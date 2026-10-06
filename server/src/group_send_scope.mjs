import {digest, delivery, validMessageId, validRequestId, fail} from './tool_contract.mjs';
import {parseConversation} from './scoped_conversation_policy.mjs';
import {rejectedDelivery} from './send_failures.mjs';

export const groupBodyHash = value => digest(JSON.stringify({target: {type: 'group', id: value.conversation.id}, request_id: value.request_id, messages: value.messages}));
const payload = value => ({target: {type: 'group', id: value.conversation.id}, request_id: value.request_id, messages: value.messages});
function validateKey(conversation, requestId) {
  const scope = parseConversation(conversation);
  if (scope.type !== 'group' || !validRequestId(requestId)) fail(400, 'invalid_request');
  return scope;
}

// New scope metadata ONLY, in the caller-supplied existing Store database.
// Existing Store.reserve/complete remains the single send authority; no second
// sends table/database is created. Construction is explicit, not an import effect.
export class GroupSendScope {
  constructor(store) {
    if (typeof store?.reserve !== 'function' || typeof store?.complete !== 'function' || typeof store?.db?.prepare !== 'function') throw new TypeError('existing Store required');
    this.store = store; this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS tool_group_send_scope(request_id TEXT PRIMARY KEY,group_id TEXT NOT NULL,body_hash TEXT NOT NULL);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS tool_send_transport_bind(request_id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL)');
  }
  cached(value) {
    validateKey(value.conversation, value.request_id);
    const scope = this.db.prepare('SELECT group_id,body_hash FROM tool_group_send_scope WHERE request_id=?').get(value.request_id);
    const existing = this.db.prepare('SELECT body_hash FROM sends WHERE request_id=?').get(value.request_id);
    if (scope && (scope.group_id !== value.conversation.id || scope.body_hash !== groupBodyHash(value))) fail(409, 'idempotency_conflict');
    // Old private UUIDs and unowned historical rows cannot become group records.
    if (existing && !scope) fail(409, 'idempotency_conflict');
    if (existing && existing.body_hash !== scope.body_hash) fail(409, 'idempotency_conflict');
    return existing ? this.store.reserve(payload(value)) : null;
  }
  reserve(value) {
    validateKey(value.conversation, value.request_id);
    // Bind scope BEFORE Store.reserve. A crash in the small gap leaves no send
    // row or a conservative pending row; it never grants ownership of another
    // group's/private UUID. Store still performs the actual reservation.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const hash = groupBodyHash(value);
      const scope = this.db.prepare('SELECT group_id,body_hash FROM tool_group_send_scope WHERE request_id=?').get(value.request_id);
      if (scope && (scope.group_id !== value.conversation.id || scope.body_hash !== hash)) fail(409, 'idempotency_conflict');
      if (!scope) {
        if (this.db.prepare('SELECT request_id FROM sends WHERE request_id=?').get(value.request_id)) fail(409, 'idempotency_conflict');
        if (this.db.prepare('SELECT COUNT(*) AS n FROM tool_group_send_scope').get().n >= 100000) fail(503, 'capacity_exceeded');
        this.db.prepare('INSERT INTO tool_group_send_scope VALUES(?,?,?)').run(value.request_id, value.conversation.id, hash);
      }
      this.db.exec('COMMIT');
    } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
    return this.store.reserve(payload(value));
  }
  complete(requestId, messageId) {
    if (!validRequestId(requestId) || !validMessageId(messageId)) fail(400, 'invalid_request');
    this.store.complete(requestId, messageId);
  }
  bindTransport(requestId,payload) {
    if(!validRequestId(requestId)||!this.ownsRequest(requestId))fail(403,'conversation_forbidden');
    const hash=digest(JSON.stringify(payload)),old=this.db.prepare('SELECT payload_hash FROM tool_send_transport_bind WHERE request_id=?').get(requestId);
    if(old&&old.payload_hash!==hash)fail(409,'idempotency_conflict');
    this.db.prepare('INSERT OR IGNORE INTO tool_send_transport_bind VALUES(?,?)').run(requestId,hash);
  }
  ownsRequest(requestId) {
    if (!validRequestId(requestId)) fail(400, 'invalid_request');
    return !!this.db.prepare('SELECT request_id FROM tool_group_send_scope WHERE request_id=?').get(requestId);
  }
  result(conversation, requestId, expectedHash = null) {
    const scope = validateKey(conversation, requestId);
    if (expectedHash !== null && (typeof expectedHash !== 'string' || !/^[0-9a-f]{64}$/.test(expectedHash))) fail(400, 'invalid_request');
    const owner = this.db.prepare('SELECT group_id,body_hash FROM tool_group_send_scope WHERE request_id=?').get(requestId);
    if (!owner || owner.group_id !== scope.id) return delivery(requestId, 'not_found');
    const row = this.db.prepare('SELECT body_hash,state,message_id FROM sends WHERE request_id=?').get(requestId);
    if (!row) return delivery(requestId, 'not_found');
    // A private reservation may race the separate scope bind in another process.
    // Metadata alone must never claim that foreign body's ACK as a group send.
    if (row.body_hash !== owner.body_hash) return delivery(requestId, 'not_found');
    if (expectedHash !== null && expectedHash !== row.body_hash) fail(409, 'idempotency_conflict');
    if(row.state!=='complete'){const rejected=rejectedDelivery(this.store,requestId,row.body_hash);if(rejected)return rejected;}
    return row.state === 'complete' && validMessageId(row.message_id) ? delivery(requestId, 'sent', row.message_id) : delivery(requestId, 'unknown');
  }
}
