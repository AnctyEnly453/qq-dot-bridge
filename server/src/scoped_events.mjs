import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {TARGET, EventFailure, fail, safeInt, snapshot, parseConversation, createScopedConversationPolicy,
  validAccountId, validMessageId, validFileId, scopeKey} from './scoped_policy.mjs';
export {TARGET, EventFailure} from './scoped_policy.mjs';
export const EVENT_SCHEMA = 'qq.normalized-event.v1';
export const SCOPED_STORE_SCHEMA = 'qq.scoped-receive.v1';
const MAX_PAYLOAD = 32768;
const RESULT_BYTES = 380 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const account = value => typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value : null;
const messageId = value => { const id = account(value); return validMessageId(id) ? id : null; };
const clone = value => JSON.parse(JSON.stringify(value));
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const GAP_CODES = new Set(['source_disconnected', 'process_resume_interval', 'latest_window_overrun', 'history_anchor_unavailable',
  'history_paging_stalled', 'history_contract_unverified', 'record_unrepresentable', 'legacy_collection_unverified',
  'recall_target_ambiguous', 'source_bounds_exceeded', 'baseline_history_unavailable']);
const consumerName = name => {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) fail(400, 'invalid_consumer');
  return name;
};

function rawConversation(raw, supplied) {
  if (!object(raw)) return null;
  let chat;
  try {
    chat = supplied ? parseConversation(supplied) : raw.message_type === 'group' || raw.notice_type === 'group_recall'
      ? parseConversation({type: 'group', id: account(raw.group_id)})
      : parseConversation({type: 'private', id: account(raw.user_id)});
  } catch { return null; }
  if (chat.type === 'group') {
    if (account(raw.group_id) !== chat.id || (raw.message_type !== undefined && raw.message_type !== 'group')) return null;
  } else if (raw.group_id !== undefined || (raw.message_type !== undefined && raw.message_type !== 'private')) return null;
  return chat;
}

export function normalizeEvent(input, {now = Date.now(), transport = 'napcat-event', conversation, selfId} = {}) {
  if (!safeInt(now) || !['napcat-event', 'napcat-history', 'mock-event', 'mock-history'].includes(transport)) throw new TypeError('invalid normalization options');
  let raw;
  try { raw = snapshot(input, {maxBytes: MAX_PAYLOAD}); } catch { return null; }
  if (!object(raw) || raw.post_type !== 'message' || !['private', 'group'].includes(raw.message_type)) return null;
  const chat = rawConversation(raw, conversation), id = messageId(raw.message_id);
  if (!chat || !id || !safeInt(raw.time, 0, Math.floor(Number.MAX_SAFE_INTEGER / 1000)) || raw.time * 1000 > now + 30000) return null;
  const sender = account(raw.sender?.user_id) ?? account(raw.user_id), self = account(selfId) ?? account(raw.self_id);
  if (!validAccountId(sender) || (raw.sender?.user_id !== undefined && raw.message_type === 'group' && account(raw.user_id) !== sender)) return null;
  let direction;
  if (chat.type === 'private') {
    if (raw.user_id !== undefined && account(raw.user_id) !== chat.id && account(raw.user_id) !== self) return null;
    if (sender === chat.id) direction = 'incoming';
    else if (validAccountId(self) && sender === self && conversation) direction = 'outgoing';
    else return null;
  } else direction = validAccountId(self) ? sender === self ? 'outgoing' : 'incoming' : 'unknown';
  const source = typeof raw.message === 'string' ? [{type: 'text', data: {text: raw.message}}] : raw.message;
  if (!Array.isArray(source) || source.length < 1 || source.length > 8) return null;
  const messages = []; let textLength = 0, omitted = 0, badReference = false;
  for (const segment of source) {
    if (!object(segment) || !object(segment.data)) { omitted++; continue; }
    if (segment.type === 'text') {
      const text = segment.data.text;
      if (typeof text !== 'string' || text.includes('\0') || text.length > 4000 || (textLength += [...text].length) > 2000) return null;
      if (text.length) messages.push({type: 'text', text});
    } else if (segment.type === 'face') {
      const face = account(segment.data.id);
      if (face && /^[0-9]{1,3}$/.test(face) && Number(face) <= 500) messages.push({type: 'face', id: Number(face)});
      else omitted++;
    } else if (segment.type === 'at') {
      const user = account(segment.data.qq ?? segment.data.user_id);
      if (chat.type === 'group' && (validAccountId(user) || user === 'all')) messages.push({type: 'at', user_id: user});
      else omitted++;
    } else if (segment.type === 'reply') {
      const reply = messageId(segment.data.id ?? segment.data.message_id);
      if (reply) messages.push({type: 'reply', id: reply});
      else { omitted++; badReference = true; }
    } else if (segment.type === 'image') {
      const image = {type: 'image'};
      if (validFileId(segment.data.file)) image.file_id = segment.data.file;
      const size = typeof segment.data.file_size === 'string' && /^[0-9]{1,10}$/.test(segment.data.file_size) ? Number(segment.data.file_size) : segment.data.file_size;
      if (safeInt(size, 0, 2147483647)) image.size_bytes = size;
      messages.push(image);
    } else omitted++;
  }
  if (!messages.length) return null;
  const reply = raw.reply_to === undefined || raw.reply_to === null ? null : messageId(raw.reply_to);
  if (raw.reply_to !== undefined && raw.reply_to !== null && !reply) badReference = true;
  return {schema: EVENT_SCHEMA, event_type: 'message', event_id: `qq:${scopeKey(chat)}:${id}`, conversation: chat,
    direction, user_id: sender, message_id: id, time: raw.time, messages, state: 'available',
    references_complete: raw.references_complete === true && !badReference,
    ...(reply ? {reply_to: reply} : {}), received_at: now, source: {transport}, omitted_segments: omitted};
}

export function normalizeRecall(input, {now = Date.now(), conversation} = {}) {
  if (!safeInt(now)) throw new TypeError('invalid clock');
  let raw;
  try { raw = snapshot(input, {maxBytes: MAX_PAYLOAD}); } catch { return null; }
  if (!object(raw) || raw.post_type !== 'notice' || !['friend_recall', 'group_recall'].includes(raw.notice_type)) return null;
  const chat = rawConversation(raw, conversation), id = messageId(raw.message_id);
  if (!chat || (chat.type === 'private' ? raw.notice_type !== 'friend_recall' || account(raw.user_id) !== chat.id : raw.notice_type !== 'group_recall') ||
      !id || !safeInt(raw.time, 0, Math.floor(Number.MAX_SAFE_INTEGER / 1000)) || raw.time * 1000 > now + 30000) return null;
  return {schema: EVENT_SCHEMA, event_type: 'recall', event_id: `recall:${scopeKey(chat)}:${id}:${raw.time}`,
    conversation: chat, message_id: id, time: raw.time, received_at: now, source: {transport: 'napcat-event'}};
}

export function normalizeHistory(input, conversation, now = Date.now(), {selfId} = {}) {
  const chat = parseConversation(conversation), raw = snapshot(input, {maxBytes: MAX_PAYLOAD});
  if (!rawConversation(raw, chat) || !messageId(raw.message_id) || !safeInt(raw.time, 0, Math.floor(Number.MAX_SAFE_INTEGER / 1000))) fail(503, 'invalid_history_record');
  if (chat.type === 'private') {
    const sender = account(raw.sender?.user_id), self = account(selfId) ?? account(raw.self_id);
    if (!validAccountId(sender) || (sender !== chat.id && sender !== self) ||
        (raw.user_id !== undefined && account(raw.user_id) !== chat.id && account(raw.user_id) !== self)) fail(503, 'invalid_history_record');
  }
  const value = normalizeEvent({...raw, post_type: 'message'}, {now, transport: 'napcat-history', conversation: chat, selfId});
  return {identity: `${scopeKey(chat)}:${messageId(raw.message_id)}:${raw.time}`, value, rejected: value === null};
}

function rebuildNormalized(input, now, {allowTombstone = false} = {}) {
  const value = snapshot(input, {maxBytes: MAX_PAYLOAD}), chat = parseConversation(value?.conversation);
  if (value.event_type === 'recall') {
    const result = normalizeRecall(clone({post_type: 'notice', notice_type: chat.type === 'group' ? 'group_recall' : 'friend_recall',
      user_id: chat.type === 'private' ? chat.id : value.user_id, ...(chat.type === 'group' ? {group_id: chat.id} : {}), message_id: value.message_id, time: value.time}), {now, conversation: chat});
    if (!result) fail(400, 'invalid_event');
    return result;
  }
  if (value.event_type !== 'message' || !validMessageId(value.message_id) || !validAccountId(value.user_id) ||
      !['incoming', 'outgoing', 'unknown'].includes(value.direction) || !Array.isArray(value.messages)) fail(400, 'invalid_event');
  if (chat.type === 'private' && ((value.direction === 'incoming' && value.user_id !== chat.id) ||
      (value.direction === 'outgoing' && value.user_id === chat.id))) fail(400, 'invalid_event');
  const tombstone = ['withdrawn', 'missing'].includes(value.state);
  if (tombstone && !allowTombstone) fail(400, 'explicit_recall_notice_required');
  if (!tombstone && value.state !== 'available') fail(400, 'invalid_event');
  const segments = value.messages.map(part => part?.type === 'text' ? {type: 'text', data: {text: part.text}}
    : part?.type === 'face' ? {type: 'face', data: {id: part.id}}
    : part?.type === 'at' ? {type: 'at', data: {qq: part.user_id}}
    : part?.type === 'reply' ? {type: 'reply', data: {id: part.id}}
    : part?.type === 'image' ? {type: 'image', data: {file: part.file_id, file_size: part.size_bytes}}
    : {type: 'unsupported', data: {}});
  // The normalized entry point is internal trusted ingestion; direction is validated data,
  // never a grant to read/send. It cannot extend conversation authorization.
  const raw = {post_type: 'message', message_type: chat.type, user_id: chat.type === 'private' ? chat.id : value.user_id,
    sender: {user_id: value.user_id}, ...(chat.type === 'group' ? {group_id: chat.id} : {}),
    ...(value.direction === 'outgoing' ? {self_id: value.user_id} : {}), message_id: value.message_id,
    time: value.time, message: tombstone ? 'tombstone' : segments, reply_to: value.reply_to, references_complete: value.references_complete};
  const result = normalizeEvent(clone(raw), {now, conversation: chat, transport: value.source?.transport ?? 'napcat-event'});
  if (!result) fail(400, 'invalid_event');
  result.direction = value.direction;
  if (tombstone) { result.state = value.state; result.messages = []; result.references_complete = false; delete result.reply_to; }
  return result;
}

export class ScopedEventStore {
  constructor(dbPath, {policy = createScopedConversationPolicy(), clock = Date.now, maxRows = 1000, ttlMs = 86400000,
    maxInboxRows = 1000, maxConsumers = 16, maxScopes = 17, maxSeenRows = Math.max(20, maxRows * 4)} = {}) {
    if (typeof dbPath !== 'string' || !dbPath || typeof clock !== 'function' || typeof policy?.authorize !== 'function' ||
        !safeInt(maxRows, 1, 10000) || !safeInt(ttlMs, 1000, 2592000000) || !safeInt(maxInboxRows, 1, 10000) ||
        !safeInt(maxConsumers, 1, 64) || !safeInt(maxScopes, 1, 17) || !safeInt(maxSeenRows, maxRows, 40000)) throw new TypeError('invalid scoped store options');
    this.policy = policy; this.clock = clock; this.maxRows = maxRows; this.ttlMs = ttlMs;
    this.maxInboxRows = maxInboxRows; this.maxConsumers = maxConsumers; this.maxScopes = maxScopes; this.maxSeenRows = maxSeenRows;
    this.db = new DatabaseSync(dbPath);
    // A new schema never mutates a legacy queue, even when pointed at the wrong path.
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    if (tables.length && !tables.some(row => row.name === 'sr_meta')) { this.db.close(); fail(409, 'legacy_database_requires_migration'); }
    if (tables.some(row => row.name === 'sr_meta')) {
      const schema = this.db.prepare("SELECT value FROM sr_meta WHERE key='schema'").get();
      if (!schema || JSON.parse(schema.value) !== SCOPED_STORE_SCHEMA) { this.db.close(); fail(409, 'unsupported_scoped_schema'); }
    }
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA max_page_count=262144;
      CREATE TABLE IF NOT EXISTS sr_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sr_scopes(scope TEXT PRIMARY KEY,high INTEGER NOT NULL DEFAULT 0,floor INTEGER NOT NULL DEFAULT 0,epoch TEXT NOT NULL,legacy_high INTEGER);
      CREATE TABLE IF NOT EXISTS sr_log(scope TEXT NOT NULL,seq INTEGER NOT NULL,event_type TEXT NOT NULL,event_id TEXT NOT NULL,received_at INTEGER NOT NULL,expires INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,seq));
      CREATE TABLE IF NOT EXISTS sr_seen(scope TEXT NOT NULL,dedup_key TEXT NOT NULL,seq INTEGER NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(scope,dedup_key));
      CREATE TABLE IF NOT EXISTS sr_recalls(scope TEXT NOT NULL,message_id TEXT NOT NULL,time INTEGER NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(scope,message_id));
      CREATE TABLE IF NOT EXISTS sr_scope_meta(scope TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(scope,key));
      CREATE TABLE IF NOT EXISTS sr_consumers(scope TEXT NOT NULL,name TEXT NOT NULL,read_cursor INTEGER NOT NULL,PRIMARY KEY(scope,name));
      CREATE TABLE IF NOT EXISTS sr_inbox(scope TEXT NOT NULL,consumer TEXT NOT NULL,seq INTEGER NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,token TEXT,lease_until INTEGER,send_request_id TEXT NOT NULL,reply_message_id TEXT,reason TEXT,PRIMARY KEY(scope,consumer,seq));
      CREATE INDEX IF NOT EXISTS sr_inbox_state ON sr_inbox(scope,consumer,state,seq);`);
    this.tx(() => {
      this.db.prepare('INSERT OR IGNORE INTO sr_meta VALUES(?,?)').run('schema', JSON.stringify(SCOPED_STORE_SCHEMA));
      this.db.prepare('INSERT OR IGNORE INTO sr_meta VALUES(?,?)').run('stream_id', JSON.stringify(crypto.randomUUID()));
      this.db.prepare('INSERT OR IGNORE INTO sr_meta VALUES(?,?)').run('cursor_key', JSON.stringify(crypto.randomBytes(32).toString('hex')));
    });
    this.streamId = JSON.parse(this.db.prepare("SELECT value FROM sr_meta WHERE key='stream_id'").get().value);
    this.cursorKey = Buffer.from(JSON.parse(this.db.prepare("SELECT value FROM sr_meta WHERE key='cursor_key'").get().value), 'hex');
    for (const row of this.db.prepare('SELECT scope FROM sr_scopes').all()) {
      const [type, id] = row.scope.split(':');
      try { this.authorize({type, id}); } catch (error) { if (!(error instanceof EventFailure) || error.code !== 'conversation_forbidden') throw error; }
    }
    if (dbPath !== ':memory:') fs.chmodSync(dbPath, 0o600);
  }
  close() { this.db.close(); }
  now() { const value = this.clock(); if (!safeInt(value, 0, Number.MAX_SAFE_INTEGER - this.ttlMs * 2)) throw new TypeError('invalid clock'); return value; }
  tx(fn) {
    if (this.db.isTransaction) throw new TypeError('nested transactions are unsupported');
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); if (result && typeof result.then === 'function') throw new TypeError('async transactions are unsupported'); this.db.exec('COMMIT'); return result; }
    catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); if (error instanceof EventFailure || error instanceof TypeError) throw error; throw new EventFailure(503, 'event_storage_unavailable'); }
  }
  authorize(input) {
    const chat = parseConversation(input); let allowed = false;
    try { allowed = this.policy.authorize(chat, 'read_info') === true; } catch { /* Deny. */ }
    if (!allowed) {
      if (this.db && !this.db.isTransaction) this.tx(() => this._revoke(scopeKey(chat)));
      fail(403, 'conversation_forbidden');
    }
    return chat;
  }
  _revoke(scope) {
    const found = this.db.prepare('SELECT high FROM sr_scopes WHERE scope=?').get(scope);
    if (!found) return;
    for (const table of ['sr_log', 'sr_seen', 'sr_recalls', 'sr_scope_meta', 'sr_consumers', 'sr_inbox']) this.db.prepare(`DELETE FROM ${table} WHERE scope=?`).run(scope);
    // Keep high monotonic, rotate generation: old tokens never regain authority on reapproval.
    this.db.prepare('UPDATE sr_scopes SET floor=high,epoch=?,legacy_high=NULL WHERE scope=?').run(crypto.randomUUID(), scope);
  }
  _scope(chat) {
    const scope = scopeKey(chat); let row = this.db.prepare('SELECT * FROM sr_scopes WHERE scope=?').get(scope);
    if (!row) {
      if (this.db.prepare('SELECT COUNT(*) AS n FROM sr_scopes').get().n >= this.maxScopes) fail(503, 'scope_capacity_exceeded');
      this.db.prepare('INSERT INTO sr_scopes(scope,epoch) VALUES(?,?)').run(scope, crypto.randomUUID());
      row = this.db.prepare('SELECT * FROM sr_scopes WHERE scope=?').get(scope);
    }
    return row;
  }
  scopeEpoch(input) { return this._scope(this.authorize(input)).epoch; }
  high(input) { return this._scope(this.authorize(input)).high; }
  signToken(prefix, payload) {
    if (!/^[a-z][0-9]$/.test(prefix)) throw new TypeError('invalid token prefix');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    if (body.length > 8192) fail(400, 'invalid_cursor');
    return `${prefix}.${body}.${crypto.createHmac('sha256', this.cursorKey).update(`${prefix}.${body}`).digest('base64url')}`;
  }
  verifyToken(prefix, token) {
    if (typeof token !== 'string' || token.length > 8300) fail(400, 'invalid_cursor');
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== prefix || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) fail(400, 'invalid_cursor');
    const expected = crypto.createHmac('sha256', this.cursorKey).update(`${prefix}.${parts[1]}`).digest();
    const signature = Buffer.from(parts[2], 'base64url');
    if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) fail(400, 'invalid_cursor');
    let value; const bytes = Buffer.from(parts[1], 'base64url');
    try { value = JSON.parse(bytes.toString('utf8')); } catch { fail(400, 'invalid_cursor'); }
    if (bytes.toString('base64url') !== parts[1] || !bytes.equals(Buffer.from(JSON.stringify(value)))) fail(400, 'invalid_cursor');
    return value;
  }
  cursor(input, seq) {
    const chat = this.authorize(input), row = this._scope(chat);
    if (!safeInt(seq, 0, row.high)) fail(400, 'invalid_cursor');
    return this.signToken('e1', {v: 1, stream_id: this.streamId, conversation: chat, scope_epoch: row.epoch, seq});
  }
  decodeCursor(input, token, {allowZero = true} = {}) {
    const chat = this.authorize(input), row = this._scope(chat);
    if (allowZero && token === '0') return 0;
    if (chat.type === 'private' && row.legacy_high !== null && typeof token === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(token) && safeInt(Number(token), allowZero ? 0 : 1, row.legacy_high)) return Number(token);
    const value = this.verifyToken('e1', token);
    if (!object(value) || Object.keys(value).sort().join(',') !== 'conversation,scope_epoch,seq,stream_id,v' || value.v !== 1) fail(400, 'invalid_cursor');
    const other = parseConversation(value.conversation);
    if (scopeKey(chat) !== scopeKey(other)) fail(403, 'cursor_conversation_mismatch');
    if (value.stream_id !== this.streamId || value.scope_epoch !== row.epoch || !safeInt(value.seq, allowZero ? 0 : 1, row.high)) fail(400, 'invalid_cursor');
    return value.seq;
  }
  getMeta(input, key) {
    const chat = this.authorize(input);
    if (typeof key !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(key)) throw new TypeError('invalid scoped metadata key');
    const row = this.db.prepare('SELECT value FROM sr_scope_meta WHERE scope=? AND key=?').get(scopeKey(chat), key);
    return row ? JSON.parse(row.value) : null;
  }
  setMeta(input, key, value) {
    const chat = this.authorize(input); this._scope(chat);
    if (typeof key !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(key)) throw new TypeError('invalid scoped metadata key');
    const encoded = JSON.stringify(value);
    if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 512 * 1024) fail(413, 'source_bounds_exceeded');
    if (!this.db.prepare('SELECT 1 FROM sr_scope_meta WHERE scope=? AND key=?').get(scopeKey(chat), key) &&
        this.db.prepare('SELECT COUNT(*) AS n FROM sr_scope_meta WHERE scope=?').get(scopeKey(chat)).n >= 16) fail(503, 'source_bounds_exceeded');
    this.db.prepare('INSERT INTO sr_scope_meta VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value').run(scopeKey(chat), key, encoded);
  }
  sourceState(chat) { return this.getMeta(chat, 'source'); }
  setSourceState(chat, value) { this.setMeta(chat, 'source', value); }
  _tombstone(value, time) {
    const result = {...value, state: 'withdrawn', messages: [], references_complete: false, withdrawn_at: time * 1000};
    delete result.reply_to; return result;
  }
  _applyRecall(chat, notice) {
    const scope = scopeKey(chat), now = this.now();
    this.db.prepare('INSERT INTO sr_recalls VALUES(?,?,?,?) ON CONFLICT(scope,message_id) DO UPDATE SET time=MAX(time,excluded.time),expires=MAX(expires,excluded.expires)').run(scope, notice.message_id, notice.time, now + this.ttlMs);
    const matches = this.db.prepare("SELECT seq,payload FROM sr_log WHERE scope=? AND event_type='message'").all(scope)
      .filter(row => { const value = JSON.parse(row.payload); return value.message_id === notice.message_id && value.time <= notice.time; });
    notice.resolution = matches.length === 1 ? 'matched' : matches.length === 0 ? 'unmatched' : 'ambiguous';
    notice.affected_cursors = [];
    // Ambiguous recalls fail closed: revoke all matching media/content, report uncertainty.
    for (const row of matches) {
      notice.affected_cursors.push(row.seq);
      const value = this._tombstone(JSON.parse(row.payload), notice.time);
      this.db.prepare('UPDATE sr_log SET payload=? WHERE scope=? AND seq=?').run(JSON.stringify(value), scope, row.seq);
    }
    for (const row of this.db.prepare('SELECT consumer,seq,payload,state FROM sr_inbox WHERE scope=?').all(scope)) {
      const value = JSON.parse(row.payload);
      if (value.message_id !== notice.message_id || value.time > notice.time) continue;
      const state = ['pending', 'failed'].includes(row.state) ? 'skipped' : row.state === 'processing' ? 'uncertain' : row.state;
      this.db.prepare('UPDATE sr_inbox SET payload=?,state=?,reason=?,token=NULL,lease_until=NULL WHERE scope=? AND consumer=? AND seq=?')
        .run(JSON.stringify(this._tombstone(value, notice.time)), state, 'message_withdrawn', scope, row.consumer, row.seq);
    }
  }
  _append(chat, original, {seq: fixedSeq, receivedAt, expiresAt} = {}) {
    const scope = scopeKey(chat), state = this._scope(chat), now = this.now();
    let value = clone(original);
    const key = value.event_type === 'message' ? `m:${value.message_id}` : value.event_id;
    const previous = this.db.prepare('SELECT seq FROM sr_seen WHERE scope=? AND dedup_key=? AND expires>?').get(scope, key, now);
    if (previous) return {status: 'duplicate', cursor: this.cursor(chat, previous.seq)};
    if (value.event_type === 'recall') this._applyRecall(chat, value);
    if (value.event_type === 'message') {
      const recall = this.db.prepare('SELECT time FROM sr_recalls WHERE scope=? AND message_id=? AND expires>?').get(scope, value.message_id, now);
      if (recall && value.time <= recall.time) value = this._tombstone(value, recall.time);
    }
    const seq = fixedSeq ?? state.high + 1;
    if (!safeInt(seq, 1)) fail(503, 'cursor_capacity_exceeded');
    value.received_at = receivedAt ?? now;
    const payload = JSON.stringify(value);
    if (Buffer.byteLength(payload) > MAX_PAYLOAD) fail(413, 'event_too_large');
    this.db.prepare('INSERT INTO sr_log VALUES(?,?,?,?,?,?,?)').run(scope, seq, value.event_type, value.event_id, value.received_at, expiresAt ?? now + this.ttlMs, payload);
    this.db.prepare('INSERT OR REPLACE INTO sr_seen VALUES(?,?,?,?)').run(scope, key, seq, now + this.ttlMs * 2);
    this.db.prepare('UPDATE sr_scopes SET high=MAX(high,?) WHERE scope=?').run(seq, scope);
    return {status: 'enqueued', cursor: this.cursor(chat, seq)};
  }
  ingest(input, options = {}) {
    const raw = snapshot(input, {maxBytes: MAX_PAYLOAD}), now = this.now();
    let value;
    if (raw?.conversation) value = rebuildNormalized(raw, now);
    else {
      const chat = rawConversation(raw, options.conversation);
      if (!chat) return {status: 'ignored'};
      this.authorize(chat);
      value = raw.post_type === 'notice' ? normalizeRecall(raw, {...options, conversation: chat, now}) : normalizeEvent(raw, {...options, conversation: chat, now});
    }
    if (!value) return {status: 'ignored'};
    const chat = this.authorize(value.conversation);
    return this.tx(() => { const result = this._append(chat, value); this._prune(chat); return result; });
  }
  ingestNormalized(value) { return this.ingest(value); }
  reportGap(input, code, {incident, certainty = 'possible', since = null, anchor = null} = {}) {
    const chat = this.authorize(input);
    if (!GAP_CODES.has(code) || !['possible', 'unrecoverable'].includes(certainty) || typeof incident !== 'string' || !incident.length || incident.length > 256 ||
        (since !== null && !safeInt(since)) || (anchor !== null && (typeof anchor !== 'string' || anchor.length > 256))) throw new TypeError('invalid scoped gap');
    const value = {schema: EVENT_SCHEMA, event_type: 'gap', event_id: `gap:${scopeKey(chat)}:${code}:${digest(incident)}`, conversation: chat,
      code, certainty, since, anchor, detected_at: this.now(), received_at: this.now(), lost_count: null, recoverable: certainty === 'possible'};
    return this.tx(() => { const result = this._append(chat, value); this._prune(chat); return result; });
  }
  _prune(chat) {
    const scope = scopeKey(chat), state = this._scope(chat), now = this.now();
    const expired = this.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM sr_log WHERE scope=? AND expires<=?').get(scope, now).n;
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM sr_log WHERE scope=?').get(scope).n;
    const excess = count - this.maxRows;
    const evicted = excess > 0 ? this.db.prepare('SELECT seq FROM sr_log WHERE scope=? ORDER BY seq LIMIT 1 OFFSET ?').get(scope, excess - 1).seq : 0;
    const floor = Math.max(state.floor, expired, evicted);
    this.db.prepare('DELETE FROM sr_log WHERE scope=? AND seq<=?').run(scope, floor);
    this.db.prepare('UPDATE sr_scopes SET floor=? WHERE scope=?').run(floor, scope);
    this.db.prepare('DELETE FROM sr_seen WHERE scope=? AND expires<=?').run(scope, now);
    this.db.prepare('DELETE FROM sr_recalls WHERE scope=? AND expires<=?').run(scope, now);
    for (const table of ['sr_seen', 'sr_recalls']) {
      const total = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE scope=?`).get(scope).n;
      if (total > this.maxSeenRows) this.db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE scope=? ORDER BY expires,rowid LIMIT ?)`).run(scope, total - this.maxSeenRows);
    }
  }
  prune(input) { const chat = this.authorize(input); return this.tx(() => this._prune(chat)); }
  _page(chat, after, limit) {
    const seq = this.decodeCursor(chat, after);
    if (!safeInt(limit, 1, 20)) fail(400, 'invalid_limit');
    this._prune(chat);
    const state = this._scope(chat), effective = Math.max(seq, state.floor);
    const rows = this.db.prepare('SELECT seq,payload FROM sr_log WHERE scope=? AND seq>? ORDER BY seq LIMIT ?').all(scopeKey(chat), effective, limit + 1);
    const selected = rows.slice(0, limit), events = selected.map(row => {
      const value = JSON.parse(row.payload);
      if (value.event_type === 'recall') value.affected_cursors = value.affected_cursors.map(item => this.cursor(chat, item));
      return {cursor: this.cursor(chat, row.seq), ...value};
    });
    if (seq < state.floor) events.unshift({schema: EVENT_SCHEMA, event_type: 'gap', event_id: `retention:${this.streamId}:${state.epoch}:${state.floor}`,
      conversation: chat, cursor: this.cursor(chat, state.floor), code: 'local_retention', certainty: 'unrecoverable',
      from_cursor: this.cursor(chat, seq), through_cursor: this.cursor(chat, state.floor), lost_count: null, recoverable: false});
    const cursor = this.cursor(chat, selected.length ? selected.at(-1).seq : effective);
    const result = {conversation: chat, cursor, next_cursor: cursor, events, messages: events.filter(event => event.event_type === 'message'),
      reset: seq < state.floor || events.some(event => event.event_type === 'gap'), has_more: rows.length > limit, stream_id: this.streamId,
      scope_epoch: state.epoch, source_status: this.sourceState(chat), coverage: {upstream_complete: false, retained_only: true},
      gap: events.filter(event => event.event_type === 'gap')};
    if (Buffer.byteLength(JSON.stringify(result)) > RESULT_BYTES) fail(413, 'events_response_too_large');
    return result;
  }
  page(input, after = '0', limit = 20) { const chat = this.authorize(input); return this.tx(() => this._page(chat, after, limit)); }
  pollEvents({conversation, after = '0', limit = 20} = {}) {
    const chat = this.authorize(conversation);
    return this.page(chat, after === null ? this.cursor(chat, this.high(chat)) : after, limit);
  }
  historySnapshot(input, {maxRows = 10000, maxPayloadBytes = MAX_PAYLOAD} = {}) {
    const chat = this.authorize(input);
    if (!safeInt(maxRows, 1, 10000) || !safeInt(maxPayloadBytes, 1, MAX_PAYLOAD)) throw new TypeError('invalid history bounds');
    return this.tx(() => {
      this._prune(chat); const state = this._scope(chat), now = this.now();
      const rows = this.db.prepare("SELECT seq,expires,CASE WHEN length(CAST(payload AS BLOB))<=? THEN payload ELSE NULL END AS payload FROM sr_log WHERE scope=? AND event_type='message' ORDER BY seq LIMIT ?").all(maxPayloadBytes, scopeKey(chat), maxRows + 1);
      if (rows.length > maxRows) fail(503, 'history_capacity_exceeded');
      const records = rows.map(row => { if (row.payload === null) fail(503, 'history_corrupt'); return {seq: row.seq, expires: row.expires, ...JSON.parse(row.payload)}; });
      return {now, high: state.high, floor: state.floor, records, stream_id: this.streamId, scope_epoch: state.epoch,
        coverage: {source: 'scoped_persistent_receive', upstream_complete: false, retained_only: true, direction_identity: 'sender_and_self',
          deduplication: 'conversation_and_message_id', source_status: this.sourceState(chat)}};
    });
  }
  getRetainedMessage({conversation, cursor} = {}) {
    const chat = this.authorize(conversation), seq = this.decodeCursor(chat, cursor, {allowZero: false});
    const row = this.db.prepare("SELECT payload FROM sr_log WHERE scope=? AND seq=? AND event_type='message' AND expires>?").get(scopeKey(chat), seq, this.now());
    if (!row) fail(404, 'media_not_found');
    return {cursor: this.cursor(chat, seq), ...JSON.parse(row.payload)};
  }
  openConsumer(input, name = 'default', {after = '0'} = {}) {
    const chat = this.authorize(input); consumerName(name);
    const seq = after === null ? this.high(chat) : this.decodeCursor(chat, after);
    return this.tx(() => {
      const scope = scopeKey(chat), row = this.db.prepare('SELECT read_cursor FROM sr_consumers WHERE scope=? AND name=?').get(scope, name);
      if (!row) {
        if (this.db.prepare('SELECT COUNT(*) AS n FROM sr_consumers WHERE scope=?').get(scope).n >= this.maxConsumers) fail(503, 'consumer_capacity_exceeded');
        this.db.prepare('INSERT INTO sr_consumers VALUES(?,?,?)').run(scope, name, seq);
      }
      return {conversation: chat, read_cursor: this.cursor(chat, row?.read_cursor ?? seq), stream_id: this.streamId};
    });
  }
  _recoverExpired(chat, name) {
    this.db.prepare("UPDATE sr_inbox SET state='uncertain',token=NULL,lease_until=NULL,reason='lease_expired' WHERE scope=? AND consumer=? AND state='processing' AND lease_until<=?").run(scopeKey(chat), name, this.now());
  }
  _enqueueInbox(chat, name, event) {
    if (event.direction !== 'incoming') return;
    const scope = scopeKey(chat), seq = this.decodeCursor(chat, event.cursor, {allowZero: false});
    if (this.db.prepare('SELECT 1 FROM sr_inbox WHERE scope=? AND consumer=? AND seq=?').get(scope, name, seq)) return;
    if (this.db.prepare('SELECT COUNT(*) AS n FROM sr_inbox WHERE scope=? AND consumer=?').get(scope, name).n >= this.maxInboxRows) fail(503, 'inbox_capacity_exceeded');
    const tombstone = event.state !== 'available';
    this.db.prepare('INSERT INTO sr_inbox(scope,consumer,seq,payload,state,send_request_id,reason) VALUES(?,?,?,?,?,?,?)')
      .run(scope, name, seq, JSON.stringify(event), tombstone ? 'skipped' : 'pending', crypto.randomUUID(), tombstone ? 'message_withdrawn' : null);
  }
  readIntoInbox(input, name = 'default', {limit = 20} = {}) {
    const chat = this.authorize(input); consumerName(name);
    return this.tx(() => {
      const row = this.db.prepare('SELECT read_cursor FROM sr_consumers WHERE scope=? AND name=?').get(scopeKey(chat), name);
      if (!row) fail(404, 'consumer_not_found');
      const page = this._page(chat, this.cursor(chat, row.read_cursor), limit);
      for (const event of page.messages) this._enqueueInbox(chat, name, event);
      this.db.prepare('UPDATE sr_consumers SET read_cursor=? WHERE scope=? AND name=?').run(this.decodeCursor(chat, page.cursor), scopeKey(chat), name);
      return page;
    });
  }
  acknowledgeRead({conversation, consumer = 'default', cursor} = {}) {
    const chat = this.authorize(conversation); consumerName(consumer); const seq = this.decodeCursor(chat, cursor);
    return this.tx(() => {
      const row = this.db.prepare('SELECT read_cursor FROM sr_consumers WHERE scope=? AND name=?').get(scopeKey(chat), consumer);
      if (!row) fail(404, 'consumer_not_found');
      if (seq < row.read_cursor) fail(409, 'read_cursor_regression');
      const page = this._page(chat, this.cursor(chat, row.read_cursor), 20);
      if (seq > this.decodeCursor(chat, page.cursor)) fail(409, 'ack_page_too_large');
      for (const event of page.messages.filter(item => this.decodeCursor(chat, item.cursor) <= seq)) this._enqueueInbox(chat, consumer, event);
      this.db.prepare('UPDATE sr_consumers SET read_cursor=? WHERE scope=? AND name=?').run(seq, scopeKey(chat), consumer);
      return {conversation: chat, read_cursor: this.cursor(chat, seq)};
    });
  }
  processing(input, name, cursor) {
    const chat = this.authorize(input); consumerName(name); const seq = this.decodeCursor(chat, cursor, {allowZero: false});
    return this.tx(() => {
      this._recoverExpired(chat, name);
      const row = this.db.prepare('SELECT * FROM sr_inbox WHERE scope=? AND consumer=? AND seq=?').get(scopeKey(chat), name, seq);
      if (!row) fail(404, 'processing_not_found');
      return {event: JSON.parse(row.payload), state: row.state, attempts: row.attempts, token: row.token, lease_until: row.lease_until,
        send_request_id: row.send_request_id, reply_message_id: row.reply_message_id, reason: row.reason};
    });
  }
  claim(input, name = 'default', {leaseMs = 30000} = {}) {
    const chat = this.authorize(input); consumerName(name);
    if (!safeInt(leaseMs, 1000, 3600000)) fail(400, 'invalid_lease');
    return this.tx(() => {
      this._recoverExpired(chat, name);
      const row = this.db.prepare("SELECT * FROM sr_inbox WHERE scope=? AND consumer=? AND state='pending' ORDER BY seq LIMIT 1").get(scopeKey(chat), name);
      if (!row) return null;
      const token = crypto.randomUUID(), lease_until = this.now() + leaseMs;
      this.db.prepare("UPDATE sr_inbox SET state='processing',attempts=attempts+1,token=?,lease_until=?,reason=NULL WHERE scope=? AND consumer=? AND seq=?").run(token, lease_until, scopeKey(chat), name, row.seq);
      return {event: JSON.parse(row.payload), token, lease_until, send_request_id: row.send_request_id, attempts: row.attempts + 1};
    });
  }
  finish(input, name, cursor, token, {state, reason = null} = {}) {
    const chat = this.authorize(input); consumerName(name); const seq = this.decodeCursor(chat, cursor, {allowZero: false});
    if (!['skipped', 'failed', 'uncertain'].includes(state) || (reason !== null && (typeof reason !== 'string' || !/^[a-z0-9_]{1,64}$/.test(reason)))) fail(400, 'invalid_processing_state');
    return this.tx(() => {
      this._recoverExpired(chat, name);
      const result = this.db.prepare("UPDATE sr_inbox SET state=?,reason=?,token=NULL,lease_until=NULL WHERE scope=? AND consumer=? AND seq=? AND state='processing' AND token=?").run(state, reason, scopeKey(chat), name, seq, token);
      if (result.changes !== 1) fail(409, 'stale_processing_claim');
      return {cursor: this.cursor(chat, seq), state};
    });
  }
  reconcile(input, name, cursor, {expected, state, reason} = {}) {
    const chat = this.authorize(input); consumerName(name); const seq = this.decodeCursor(chat, cursor, {allowZero: false});
    if (!['uncertain', 'failed'].includes(expected) || !['pending', 'skipped'].includes(state) || typeof reason !== 'string' || !/^[a-z0-9_]{1,64}$/.test(reason)) fail(400, 'invalid_reconciliation');
    return this.tx(() => {
      this._recoverExpired(chat, name);
      const existing = this.db.prepare('SELECT payload FROM sr_inbox WHERE scope=? AND consumer=? AND seq=?').get(scopeKey(chat), name, seq);
      if (state === 'pending' && existing && JSON.parse(existing.payload).state !== 'available') fail(409, 'message_withdrawn');
      const result = this.db.prepare('UPDATE sr_inbox SET state=?,reason=? WHERE scope=? AND consumer=? AND seq=? AND state=?').run(state, reason, scopeKey(chat), name, seq, expected);
      if (result.changes !== 1) fail(409, 'processing_state_conflict');
      return {cursor: this.cursor(chat, seq), state};
    });
  }
  recordReply({conversation, consumer = 'default', event_cursor, token, request_id, message_id, status} = {}) {
    const chat = this.authorize(conversation); consumerName(consumer); const seq = this.decodeCursor(chat, event_cursor, {allowZero: false});
    if (status !== 'completed' || !validMessageId(message_id)) fail(409, 'reply_not_confirmed');
    return this.tx(() => {
      this._recoverExpired(chat, consumer);
      const row = this.db.prepare('SELECT * FROM sr_inbox WHERE scope=? AND consumer=? AND seq=?').get(scopeKey(chat), consumer, seq);
      if (!row) fail(404, 'processing_not_found');
      if (request_id !== row.send_request_id) fail(409, 'reply_not_confirmed');
      if (row.state === 'replied' && row.reply_message_id === message_id) return {cursor: this.cursor(chat, seq), state: 'replied'};
      if (JSON.parse(row.payload).state !== 'available') fail(409, 'message_withdrawn');
      if (!['processing', 'uncertain'].includes(row.state) || (row.state === 'processing' && token !== row.token)) fail(409, 'stale_processing_claim');
      this.db.prepare("UPDATE sr_inbox SET state='replied',reply_message_id=?,reason='confirmed_send',token=NULL,lease_until=NULL WHERE scope=? AND consumer=? AND seq=?").run(message_id, scopeKey(chat), consumer, seq);
      return {cursor: this.cursor(chat, seq), state: 'replied'};
    });
  }
  getState({conversation, consumer = 'default'} = {}) {
    const chat = this.authorize(conversation); consumerName(consumer);
    return this.tx(() => {
      this._recoverExpired(chat, consumer);
      const row = this.db.prepare('SELECT read_cursor FROM sr_consumers WHERE scope=? AND name=?').get(scopeKey(chat), consumer);
      if (!row) fail(404, 'consumer_not_found');
      const processing = Object.fromEntries(this.db.prepare('SELECT state,COUNT(*) AS n FROM sr_inbox WHERE scope=? AND consumer=? GROUP BY state').all(scopeKey(chat), consumer).map(item => [item.state, item.n]));
      return {conversation: chat, stream_id: this.streamId, read_cursor: this.cursor(chat, row.read_cursor), processing, source_status: this.sourceState(chat)};
    });
  }
}

// Explicit offline copy only. Source remains read-only; destination must be new.
// Legacy private decimal positions are preserved, never accepted for a group.
function copyLegacyQueue(fromPath, toPath, options = {}) {
  if (typeof fromPath !== 'string' || typeof toPath !== 'string' || fromPath === ':memory:' || toPath === ':memory:' ||
      path.resolve(fromPath) === path.resolve(toPath) || fs.existsSync(toPath)) fail(409, 'invalid_migration_destination');
  const source = new DatabaseSync(fromPath, {readOnly: true}); let destination;
  try {
    const cap = options.maxRows ?? 1000;
    const rows = source.prepare('SELECT seq,expires,payload FROM received ORDER BY seq LIMIT ?').all(cap + 1);
    if (rows.length > cap) fail(503, 'migration_capacity_exceeded');
    const high = source.prepare("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='received'),0) AS n").get().n;
    const floor = source.prepare("SELECT value FROM receive_meta WHERE key='floor'").get()?.value ?? 0;
    if (!safeInt(high) || !safeInt(floor, 0, high)) fail(400, 'invalid_legacy_cursor');
    destination = new ScopedEventStore(toPath, options); const chat = {type: 'private', id: TARGET};
    destination.tx(() => {
      destination._scope(chat);
      for (const row of rows) {
        if (!safeInt(row.seq, 1, high) || !safeInt(row.expires) || typeof row.payload !== 'string' || Buffer.byteLength(row.payload) > MAX_PAYLOAD) fail(400, 'invalid_legacy_event');
        const old = JSON.parse(row.payload);
        if (old.conversation?.type !== 'private' || old.conversation.id !== TARGET) fail(403, 'legacy_conversation_forbidden');
        const value = rebuildNormalized({...old, event_type: 'message', direction: old.direction ?? (account(old.user_id) === TARGET ? 'incoming' : 'unknown'), state: old.state ?? 'available'}, destination.now(), {allowTombstone: true});
        if (!safeInt(old.received_at)) fail(400, 'invalid_legacy_event');
        const appended = destination._append(chat, value, {seq: row.seq, receivedAt: old.received_at, expiresAt: row.expires});
        if (appended.status !== 'enqueued') fail(400, 'duplicate_legacy_message');
      }
      destination.db.prepare('UPDATE sr_scopes SET high=?,floor=?,legacy_high=? WHERE scope=?').run(high, floor, high, scopeKey(chat));
      destination._prune(chat);
      destination.setSourceState(chat, {initialized: false, source: 'unconfigured', incomplete: true, backward_paging_verified: false, continuity: 'migration_unverified'});
    });
    destination.reportGap(chat, 'legacy_collection_unverified', {incident: 'offline-copy', certainty: 'possible'});
    return {copied_rows: rows.length, legacy_high_cursor: String(high), legacy_floor: String(floor), stream_id: destination.streamId,
      next_cursor: destination.cursor(chat, destination.high(chat)), schema: SCOPED_STORE_SCHEMA, continuity: 'migration_unverified'};
  } finally { destination?.close(); source.close(); }
}

export function migrateLegacyQueue(fromPath, toPath, options = {}) {
  if (typeof fromPath !== 'string' || typeof toPath !== 'string' || fromPath === ':memory:' || toPath === ':memory:' ||
      path.resolve(fromPath) === path.resolve(toPath) || fs.existsSync(toPath)) fail(409, 'invalid_migration_destination');
  const sourcePath = path.resolve(fromPath), destinationPath = path.resolve(toPath), stat = fs.lstatSync(sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024 ||
      ['-wal', '-shm', '-journal'].some(suffix => fs.existsSync(sourcePath + suffix))) fail(409, 'offline_snapshot_required');
  const hashFile = () => crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
  const sourceHash = hashFile();
  const temporaryDirectory = fs.mkdtempSync(path.join(path.dirname(destinationPath), '.scoped-copy-'));
  const temporaryPath = path.join(temporaryDirectory, 'candidate.sqlite3');
  try {
    const result = copyLegacyQueue(sourcePath, temporaryPath, options);
    if (hashFile() !== sourceHash) fail(409, 'offline_source_changed');
    // Same filesystem, atomic create-without-overwrite after the candidate closes.
    fs.linkSync(temporaryPath, destinationPath);
    return {...result, source_sha256: sourceHash, destination_path: destinationPath};
  } finally {
    // Targets are literal children created here; never traverse a user-supplied tree.
    for (const suffix of ['', '-journal', '-wal', '-shm']) if (fs.existsSync(temporaryPath + suffix)) fs.unlinkSync(temporaryPath + suffix);
    fs.rmdirSync(temporaryDirectory);
  }
}
