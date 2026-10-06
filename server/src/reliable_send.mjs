import {sendHash, fail, delivery, validMessageId, boundedWait, validateTimeout, PRIVATE_TARGET, exact} from './tool_contract.mjs';
import {rejectedDelivery} from './send_failures.mjs';

// Read-only projection over the SAME existing Store.db/sends table.
// No new send reservation implementation, migration or database.
export class SendLedger {
  constructor(store) {
    if (typeof store?.db?.prepare !== 'function') throw new TypeError('existing Store required');
    this.db = store.db;
  }
  result(requestId, expectedHash = null) {
    const row = this.db.prepare('SELECT body_hash,state,message_id FROM sends WHERE request_id=?').get(requestId);
    if (!row) return delivery(requestId, 'not_found');
    if (expectedHash !== null && row.body_hash !== expectedHash) fail(409, 'idempotency_conflict');
    if (row.state === 'complete' && validMessageId(row.message_id)) return delivery(requestId, 'sent', row.message_id);
    const rejected=rejectedDelivery(this,requestId,row.body_hash);if(rejected)return rejected;
    return delivery(requestId, 'unknown');
  }
}

export class ReliableSender {
  constructor({send, lookup}, {timeoutMs = 10000} = {}) {
    if (typeof send !== 'function' || typeof lookup !== 'function') throw new TypeError('existing Engine.send and read-only lookup callbacks required');
    this.send = send; this.lookup = lookup; this.timeoutMs = validateTimeout(timeoutMs);
  }
  result(requestId, expectedHash = null) { return this.lookup(requestId, expectedHash); }
  async sendValidated(value) {
    if (value.target !== PRIVATE_TARGET) fail(403, 'conversation_forbidden');
    // Engine owns validation, reserve, complete, and all upstream sending.
    const attempt = Promise.resolve().then(() => this.send(value)).then(result => {
      exact(result, ['request_id', 'message_id']);
      if (result.request_id !== value.request_id || !validMessageId(result.message_id)) fail(502, 'invalid_response');
      return delivery(value.request_id, 'sent', result.message_id);
    }).catch(error => {
      if(['delivery_rejected','upstream_pre_send_rejected'].includes(error?.code))return this.lookup(value.request_id);
      if (error?.code === 'delivery_uncertain') return delivery(value.request_id, 'unknown');
      throw error;
    });
    // Timeout doesn't cancel Engine.send. Its late ACK can complete the same row.
    return boundedWait(attempt, this.timeoutMs, () => delivery(value.request_id, 'unknown'));
  }
}

// Client attempt tracking only; Engine+Store remains the send authority.
// Reserve before network I/O, persist no raw message/media, never retry on restart.
export class ClientJournal {
  constructor(db) {
    this.db = db;
    db.exec(`PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tool_client_sends(request_id TEXT PRIMARY KEY,body_hash TEXT NOT NULL,state TEXT NOT NULL,message_id TEXT,error_code TEXT);`);
  }
  reserve(value) {
    const hash = sendHash(value);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.db.prepare('SELECT * FROM tool_client_sends WHERE request_id=?').get(value.request_id);
      if (previous) {
        if (previous.body_hash !== hash) fail(409, 'idempotency_conflict');
        this.db.exec('COMMIT'); return this.result(value.request_id);
      }
      if (this.db.prepare('SELECT COUNT(*) AS count FROM tool_client_sends').get().count >= 100000) fail(503, 'capacity_exceeded');
      this.db.prepare("INSERT INTO tool_client_sends VALUES(?,?,'unknown',NULL,NULL)").run(value.request_id, hash);
      this.db.exec('COMMIT'); return null;
    } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
  }
  result(requestId) {
    const row = this.db.prepare('SELECT * FROM tool_client_sends WHERE request_id=?').get(requestId);
    if (!row) return null;
    if (row.state === 'rejected') return {...delivery(requestId, 'rejected'), error: row.error_code};
    const sent = row.state === 'sent' && validMessageId(row.message_id);
    return delivery(requestId, sent ? 'sent' : 'unknown', sent ? row.message_id : null);
  }
  expectedHash(requestId) { return this.db.prepare('SELECT body_hash FROM tool_client_sends WHERE request_id=?').get(requestId)?.body_hash ?? null; }
  settle(value) {
    if (value.state === 'sent') {
      this.db.prepare("UPDATE tool_client_sends SET state='sent',message_id=?,error_code=NULL WHERE request_id=? AND state!='sent'").run(value.message_id, value.request_id);
    } else if (value.state === 'rejected') {
      this.db.prepare("UPDATE tool_client_sends SET state='rejected',error_code=? WHERE request_id=? AND state='unknown'").run(value.error, value.request_id);
    }
    return this.result(value.request_id);
  }
}
