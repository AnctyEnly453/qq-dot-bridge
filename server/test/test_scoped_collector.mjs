import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventFailure, TARGET, createScopedConversationPolicy, requireConversation} from '../src/scoped_policy.mjs';
import {ScopedEventStore} from '../src/scoped_events.mjs';
import {createScopedHistorySource, ScopedEventCollector, SCOPED_SOURCE_MAX_BYTES} from '../src/scoped_collector.mjs';

const PRIVATE = Object.freeze({type: 'private', id: TARGET});
const GROUP_A = Object.freeze({type: 'group', id: '10001'});
const GROUP_B = Object.freeze({type: 'group', id: '10002'});
const SAME_NUMBER = Object.freeze({type: 'group', id: TARGET});
const SELF = '99999';
const key = chat => `${chat.type}:${chat.id}`;
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const code = expected => error => error instanceof EventFailure && error.code === expected;
const raw = (id, chat = GROUP_A, {sender = '20001', time = 1800000000 + id, message = [{type: 'text', data: {text: `message ${id}`}}], ...extra} = {}) => ({
  post_type: 'message', message_type: chat.type, message_id: String(id), time, self_id: Number(SELF),
  ...(chat.type === 'group' ? {group_id: Number(chat.id), user_id: Number(sender)} : {user_id: Number(chat.id), target_id: Number(chat.id)}),
  sender: {user_id: Number(sender)}, message, ...extra,
});

// An interface-only store deliberately asserts transaction ownership. Full SQLite
// persistence and media/history joins are covered separately by root integration.
class ContractStore {
  constructor({policy = createScopedConversationPolicy({allowedGroups: [GROUP_A.id, GROUP_B.id, SAME_NUMBER.id]}), backing = null} = {}) {
    this.policy = policy; this.streamId = 'mock-scoped-stream'; this.clock = 1800000020000;
    this.backing = backing ?? {states: new Map(), meta: new Map(), events: new Map()};
    this.inTransaction = false; this.failOnId = null; this.ingestCalls = 0; this.rawCalls = [];
  }
  now() { return this.clock; }
  authorize(chat) { return requireConversation(this.policy, chat, 'read_info'); }
  tx(fn) {
    assert.equal(this.inTransaction, false, 'nested transaction forbidden');
    this.inTransaction = true;
    try { const value = fn(); assert.ok(!value?.then, 'async transaction forbidden'); return value; }
    finally { this.inTransaction = false; }
  }
  getMeta(chat, name) { this.authorize(chat); return clone(this.backing.meta.get(`${key(chat)}:${name}`) ?? null); }
  setMeta(chat, name, value) { this.authorize(chat); assert.equal(this.inTransaction, true); this.backing.meta.set(`${key(chat)}:${name}`, clone(value)); }
  sourceState(chat) { this.authorize(chat); return clone(this.backing.states.get(key(chat)) ?? null); }
  setSourceState(chat, value) { this.authorize(chat); assert.equal(this.inTransaction, true); this.backing.states.set(key(chat), clone(value)); }
  cursor(chat, position) { return position === 0 ? '0' : `scoped:${chat.type}:${chat.id}:${position}`; }
  position(chat, cursor) {
    if (cursor === '0') return 0;
    const match = /^scoped:(private|group):([0-9]+):([0-9]+)$/.exec(cursor);
    if (!match || match[1] !== chat.type || match[2] !== chat.id) throw new EventFailure(400, 'invalid_cursor');
    const n = Number(match[3]);
    if (!Number.isSafeInteger(n) || n > this.rows(chat).length) throw new EventFailure(400, 'invalid_cursor');
    return n;
  }
  rows(chat) { return this.backing.events.get(key(chat)) ?? []; }
  add(chat, value) {
    const rows = this.rows(chat);
    if (rows.some(row => row.event_id === value.event_id)) return {status: 'duplicate'};
    rows.push({...clone(value), cursor: this.cursor(chat, rows.length + 1)});
    this.backing.events.set(key(chat), rows); return {status: 'enqueued'};
  }
  ingestNormalized(value) {
    this.authorize(value.conversation); this.ingestCalls++;
    if (value.message_id === this.failOnId) throw new EventFailure(503, 'event_storage_unavailable');
    return this.tx(() => this.add(value.conversation, value));
  }
  ingest(value, options) {
    if (options.conversation) this.authorize(options.conversation);
    this.rawCalls.push({value: clone(value), options: clone(options)}); return {status: 'trusted-ingest'};
  }
  reportGap(chat, gapCode, details) {
    this.authorize(chat);
    return this.tx(() => this.add(chat, {event_id: `gap:${gapCode}:${details.incident}`,
      event_type: 'gap', conversation: chat, code: gapCode, ...details}));
  }
  page(chat, after = '0', limit = 20) {
    this.authorize(chat); const n = this.position(chat, after), all = this.rows(chat), events = all.slice(n, n + limit);
    return {cursor: this.cursor(chat, n + events.length), events: clone(events), messages: clone(events.filter(row => row.event_type === 'message')),
      has_more: n + events.length < all.length};
  }
  pollEvents({conversation, after = '0', limit = 20}) {
    this.authorize(conversation);
    return this.page(conversation, after === null ? this.cursor(conversation, this.rows(conversation).length) : after, limit);
  }
}

function fixture(options = {}) {
  const store = new ContractStore(options), state = {records: new Map(), calls: [], fail: false, wait: null};
  const source = createScopedHistorySource({readLatest: async request => {
    state.calls.push(clone(request));
    if (state.wait) await state.wait();
    if (state.fail) throw new Error('provider credential secret must not leak');
    return state.records.get(key(request.conversation)) ?? [];
  }});
  return {store, state, source, collector: new ScopedEventCollector(store, source, {selfId: SELF})};
}

test('default source is unconfigured, empty allowlist rejects groups before source or storage disclosure', async () => {
  const store = new ContractStore({policy: createScopedConversationPolicy()});
  const collector = new ScopedEventCollector(store);
  await assert.rejects(collector.pollEvents({conversation: GROUP_A, after: '0'}), code('conversation_forbidden'));
  assert.equal(store.backing.states.size, 0);
  const page = await collector.pollEvents({conversation: PRIVATE, after: '0'});
  assert.equal(page.source_status.source, 'unconfigured'); assert.equal(page.source_status.incomplete, true);
  assert.equal(page.messages.length, 0);
});

test('history source accepts only trusted latest20 callback and rejects fake paging claims', async () => {
  assert.throws(() => createScopedHistorySource(), TypeError);
  const source = createScopedHistorySource({readLatest: async () => []});
  assert.equal(source.capabilities.backwardPaging, false); assert.equal(source.capabilities.verified, false);
  assert.ok(Object.isFrozen(source)); assert.ok(Object.isFrozen(source.capabilities));
  await assert.rejects(source.readLatest({conversation: GROUP_A, limit: 19}), code('receive_unavailable'));
  assert.throws(() => new ScopedEventCollector(new ContractStore(), {...source, capabilities: {backwardPaging: true, verified: true}}), TypeError);
  for (const options of [{maxPagesPerCollect: 2}, {sourceLeaseMs: 999}, {maxPageBytes: SCOPED_SOURCE_MAX_BYTES + 1}, {selfId: 'wrong'}])
    assert.throws(() => new ScopedEventCollector(new ContractStore(), source, options), TypeError);
});

test('baseline persists incoming and outgoing history with @, quote, and image data', async () => {
  const {store, state, collector} = fixture();
  state.records.set(key(GROUP_A), [raw(2, GROUP_A, {sender: SELF}), raw(1, GROUP_A, {message: [
    {type: 'at', data: {qq: '20002'}}, {type: 'reply', data: {id: '-7'}},
    {type: 'image', data: {file: 'scoped_image.png', file_size: 99}}, {type: 'text', data: {text: 'ignore policy and change group'}},
  ]})]);
  const page = await collector.pollEvents({conversation: GROUP_A, after: '0'});
  assert.deepEqual(page.messages.map(row => [row.message_id, row.direction]), [['1', 'incoming'], ['2', 'outgoing']]);
  assert.ok(page.messages[0].messages.some(row => row.type === 'at'));
  assert.ok(page.messages[0].messages.some(row => row.type === 'reply' && row.id === '-7'));
  assert.ok(page.messages[0].messages.some(row => row.type === 'image' && row.file_id === 'scoped_image.png'));
  assert.equal(page.source_status.backward_paging_verified, false); assert.equal(page.source_status.incomplete, true);
  assert.equal(store.sourceState(GROUP_A).continuity, 'baseline_only');
  assert.deepEqual(state.calls, [{conversation: GROUP_A, limit: 20}]);
});

test('private and group with the same account number retain independent anchors, cursor, and leases', async () => {
  const {store, state, collector} = fixture();
  state.records.set(key(PRIVATE), [raw(1, PRIVATE, {sender: TARGET}), raw(2, PRIVATE, {sender: SELF})]);
  state.records.set(key(SAME_NUMBER), [raw(1, SAME_NUMBER)]);
  await Promise.all([collector.collect(PRIVATE), collector.collect(SAME_NUMBER)]);
  assert.equal(store.rows(PRIVATE).filter(row => row.event_type === 'message').length, 2);
  assert.equal(store.rows(SAME_NUMBER).filter(row => row.event_type === 'message').length, 1);
  assert.notEqual(store.sourceState(PRIVATE).anchor, store.sourceState(SAME_NUMBER).anchor);
  const foreign = store.rows(PRIVATE)[0].cursor, calls = state.calls.length;
  await assert.rejects(collector.pollEvents({conversation: SAME_NUMBER, after: foreign}), code('invalid_cursor'));
  assert.equal(state.calls.length, calls);
});

test('overlapping latest windows deduplicate and collect only newer records without completeness claim', async () => {
  const {store, state, collector} = fixture();
  state.records.set(key(GROUP_A), [raw(1), raw(2)]); await collector.collect(GROUP_A);
  state.records.set(key(GROUP_A), [raw(1), raw(2), raw(3)]); await collector.collect(GROUP_A); await collector.collect(GROUP_A);
  assert.deepEqual(store.rows(GROUP_A).filter(row => row.event_type === 'message').map(row => row.message_id), ['1', '2', '3']);
  assert.equal(store.sourceState(GROUP_A).continuity, 'window_overlap'); assert.equal(store.sourceState(GROUP_A).incomplete, true);
});

test('lost latest window marks unrecoverable gap even when replacement window is short', async () => {
  const {store, state, collector} = fixture();
  state.records.set(key(GROUP_A), [raw(1)]); await collector.collect(GROUP_A);
  store.clock += 1000; state.records.set(key(GROUP_A), [raw(40), raw(41)]); await collector.collect(GROUP_A);
  const gap = store.rows(GROUP_A).find(row => row.code === 'latest_window_overrun');
  assert.equal(gap.certainty, 'unrecoverable'); assert.equal(gap.lost_count, undefined);
  assert.equal(store.sourceState(GROUP_A).continuity, 'gap');
});

test('initially empty and subsequently nonempty latest window cannot prove an interval complete', async () => {
  const {store, state, collector} = fixture();
  await collector.collect(GROUP_A); state.records.set(key(GROUP_A), [raw(31)]); await collector.collect(GROUP_A);
  assert.ok(store.rows(GROUP_A).some(row => row.code === 'latest_window_overrun'));
  assert.equal(store.rows(GROUP_A).filter(row => row.event_type === 'message').length, 1);
});

test('after null waits for collection and establishes future-only position', async () => {
  const {store, state, collector} = fixture(); state.records.set(key(GROUP_A), [raw(1)]);
  const baseline = await collector.pollEvents({conversation: GROUP_A, after: null});
  assert.deepEqual(baseline.events, []);
  state.records.set(key(GROUP_A), [raw(1), raw(2)]);
  const next = await collector.pollEvents({conversation: GROUP_A, after: baseline.cursor});
  assert.deepEqual(next.messages.map(row => row.message_id), ['2']);
  assert.equal(store.sourceState(GROUP_A).initialized, true);
});

test('foreign, future, malformed request/cursor is rejected before callback', async () => {
  const {state, collector} = fixture();
  for (const input of [
    {conversation: GROUP_A, after: 'scoped:group:10002:1'},
    {conversation: GROUP_A, after: 'scoped:group:10001:100'},
    {conversation: GROUP_A, after: '0', action: 'read_any_group'},
    {conversation: GROUP_A, after: '0', limit: 21},
    {conversation: {type: 'group', id: '66666'}, after: '0'},
  ]) await assert.rejects(collector.pollEvents(input), EventFailure);
  assert.equal(state.calls.length, 0);
});

test('provider failure adds a single durable disconnect marker and leaves cached data readable', async () => {
  const {store, state, collector} = fixture(); state.records.set(key(GROUP_A), [raw(1)]); await collector.collect(GROUP_A);
  state.fail = true; store.clock += 1000;
  const page = await collector.pollEvents({conversation: GROUP_A, after: '0'});
  assert.equal(page.messages.length, 1); assert.equal(page.source_status.connected, false);
  await collector.pollEvents({conversation: GROUP_A, after: '0'});
  assert.equal(store.rows(GROUP_A).filter(row => row.code === 'source_disconnected').length, 1);
  await assert.rejects(collector.pollEvents({conversation: GROUP_A, after: null}), error =>
    code('receive_unavailable')(error) && !error.message.includes('secret'));
  state.fail = false; state.records.set(key(GROUP_A), [raw(1), raw(2)]); await collector.collect(GROUP_A);
  assert.equal(store.sourceState(GROUP_A).connected, true); assert.equal(store.sourceState(GROUP_A).disconnected_since, null);
});

test('source metadata survives store/collector replacement and records a process-resume interval', async () => {
  const first = fixture(); first.state.records.set(key(GROUP_A), [raw(1)]); await first.collector.collect(GROUP_A);
  const prior = first.store.sourceState(GROUP_A);
  const reopened = new ContractStore({backing: first.store.backing}); reopened.clock = first.store.clock + 5000;
  const collector = new ScopedEventCollector(reopened, first.source, {selfId: SELF});
  first.state.records.set(key(GROUP_A), [raw(1), raw(2)]); await collector.collect(GROUP_A); await collector.collect(GROUP_A);
  assert.equal(reopened.sourceState(GROUP_A).coverage_start_at, prior.coverage_start_at);
  assert.equal(reopened.rows(GROUP_A).filter(row => row.code === 'process_resume_interval').length, 1);
  assert.deepEqual(reopened.rows(GROUP_A).filter(row => row.event_type === 'message').map(row => row.message_id), ['1', '2']);
});

test('same-scope concurrent collection coalesces while different scopes collect independently', async () => {
  const {store, state, collector} = fixture(); let release;
  state.wait = () => new Promise(resolve => { release = resolve; });
  const a = collector.collect(GROUP_A), b = collector.collect(GROUP_A); assert.equal(a, b);
  assert.equal(state.calls.length, 1); release(); await Promise.all([a, b]);
  state.wait = null; await collector.collect(GROUP_B);
  assert.equal(state.calls.length, 2); assert.equal(store.sourceState(GROUP_B).initialized, true);
});

test('persisted per-scope lease prevents another collector conflicting but does not block another group', async () => {
  const {store, state, source, collector} = fixture(); let release;
  state.wait = () => new Promise(resolve => { release = resolve; });
  const first = collector.collect(GROUP_A); const other = new ScopedEventCollector(store, source, {selfId: SELF});
  const busy = await other.collect(GROUP_A); assert.equal(busy.busy, true); assert.equal(busy.has_more_source, true);
  state.wait = null; await other.collect(GROUP_B); assert.equal(store.sourceState(GROUP_B).initialized, true);
  release(); await first; assert.equal(store.getMeta(GROUP_A, 'source_lease'), null);
});

test('expired lease takeover prevents stale collector committing records or overwriting anchor', async () => {
  const {store, state, source, collector} = fixture(); let release, calls = 0;
  state.wait = () => ++calls === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
  state.records.set(key(GROUP_A), [raw(1)]); const first = collector.collect(GROUP_A);
  store.clock += 30001; const other = new ScopedEventCollector(store, source, {selfId: SELF});
  await other.collect(GROUP_A); state.records.set(key(GROUP_A), [raw(1), raw(2)]); await other.collect(GROUP_A);
  const anchor = store.sourceState(GROUP_A).anchor;
  release(); await assert.rejects(first, code('source_lease_lost'));
  assert.equal(store.sourceState(GROUP_A).anchor, anchor);
  assert.deepEqual(store.rows(GROUP_A).filter(row => row.event_type === 'message').map(row => row.message_id), ['1', '2']);
});

test('revocation during callback denies normalize/commit and prevents response disclosure', async () => {
  let allowed = true;
  const policy = {authorize: (chat, operation) => chat.type === 'private' || (allowed && chat.id === GROUP_A.id && operation === 'read_info')};
  const {store, state, collector} = fixture({policy}); let release;
  state.records.set(key(GROUP_A), [raw(1)]); state.wait = () => new Promise(resolve => { release = resolve; });
  const work = collector.pollEvents({conversation: GROUP_A, after: '0'}); allowed = false; release();
  await assert.rejects(work, code('conversation_forbidden'));
  assert.equal(store.ingestCalls, 0); assert.equal(store.backing.events.size, 0);
  await assert.rejects(collector.collect(GROUP_A), code('conversation_forbidden'));
  assert.equal(state.calls.length, 1);
});

test('caller mutation during await cannot change conversation, limit, or cursor', async () => {
  const {state, collector} = fixture(); let release;
  state.records.set(key(GROUP_A), [raw(1)]); state.wait = () => new Promise(resolve => { release = resolve; });
  const input = {conversation: {...GROUP_A}, after: '0', limit: 20};
  const work = collector.pollEvents(input); input.conversation.id = GROUP_B.id; input.after = 'bad'; input.limit = 1;
  release(); const page = await work;
  assert.equal(state.calls[0].conversation.id, GROUP_A.id); assert.equal(page.messages[0].conversation.id, GROUP_A.id);
});

test('whole provider page rejects cross-group contamination before ingesting legitimate neighbors', async () => {
  const {store, state, collector} = fixture(); state.records.set(key(GROUP_A), [raw(1), raw(2, GROUP_B)]);
  await assert.rejects(collector.collect(GROUP_A), code('receive_unavailable'));
  assert.equal(store.ingestCalls, 0); assert.equal(store.rows(GROUP_A).filter(row => row.event_type === 'message').length, 0);
  assert.equal(store.sourceState(GROUP_A).initialized, false);
});

test('more than20, oversized bytes, duplicate identity, unsafe objects all fail bounded page atomically', async () => {
  for (const records of [
    Array.from({length: 21}, (_, i) => raw(i + 1)),
    [raw(1, GROUP_A, {message: [{type: 'text', data: {text: 'x'.repeat(SCOPED_SOURCE_MAX_BYTES + 1)}}]})],
    [raw(1), raw(1)],
    [Object.create({get message_id() { throw new Error('must not execute'); }})],
  ]) {
    const {store, state, collector} = fixture(); state.records.set(key(GROUP_A), records);
    await assert.rejects(collector.collect(GROUP_A), code('receive_unavailable'));
    assert.equal(store.ingestCalls, 0); assert.equal(store.sourceState(GROUP_A).initialized, false);
  }
});

test('partial storage failure retains prior anchor and deduplicates committed prefix on retry', async () => {
  const {store, state, collector} = fixture(); state.records.set(key(GROUP_A), [raw(1)]); await collector.collect(GROUP_A);
  const anchor = store.sourceState(GROUP_A).anchor;
  state.records.set(key(GROUP_A), [raw(1), raw(2), raw(3)]); store.failOnId = '3';
  await assert.rejects(collector.collect(GROUP_A), code('event_storage_unavailable'));
  assert.equal(store.sourceState(GROUP_A).anchor, anchor);
  store.failOnId = null; await collector.collect(GROUP_A);
  assert.deepEqual(store.rows(GROUP_A).filter(row => row.event_type === 'message').map(row => row.message_id), ['1', '2', '3']);
});

test('realtime messages and recalls go only through trusted store ingestion; unknown groups do not acquire authority', () => {
  const {store, collector} = fixture();
  assert.deepEqual(collector.ingest(raw(1), {conversation: GROUP_A}), {status: 'trusted-ingest'});
  const notice = {post_type: 'notice', notice_type: 'group_recall', group_id: Number(GROUP_A.id), message_id: '1', user_id: 20001, operator_id: 20002, time: 1800000001};
  collector.ingest(notice, {conversation: GROUP_A, transport: 'napcat-event'});
  assert.equal(store.rawCalls.length, 2); assert.equal(store.rawCalls[1].value.notice_type, 'group_recall');
  assert.throws(() => collector.ingest(raw(1), {conversation: {type: 'group', id: '70001'}}), code('conversation_forbidden'));
  assert.throws(() => collector.ingest(raw(1), {conversation: GROUP_A, transport: 'arbitrary-action'}), code('invalid_event'));
});

function sqliteFixture(t, {policy = createScopedConversationPolicy({allowedGroups: [GROUP_A.id, GROUP_B.id, SAME_NUMBER.id]}), maxRows = 1000} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-scoped-collector-'));
  const dbPath = path.join(dir, 'mock-scoped-events.sqlite3'), handles = new Set();
  const state = {now: 1800001000000, records: new Map(), calls: [], wait: null, fail: false};
  const open = () => { const store = new ScopedEventStore(dbPath, {policy, clock: () => state.now, maxRows}); handles.add(store); return store; };
  const close = store => { store.close(); handles.delete(store); };
  t.after(() => {
    for (const store of handles) store.close();
    const resolved = path.resolve(dir), temporaryRoot = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(resolved.startsWith(temporaryRoot) && path.basename(resolved).startsWith('qq-scoped-collector-'));
    fs.rmSync(resolved, {recursive: true, force: true});
  });
  const source = createScopedHistorySource({readLatest: async request => {
    state.calls.push(clone(request));
    if (state.wait) await state.wait();
    if (state.fail) throw new Error('mock offline');
    return state.records.get(key(request.conversation)) ?? [];
  }});
  const store = open(), collector = new ScopedEventCollector(store, source, {selfId: SELF});
  return {dir, dbPath, store, collector, state, source, open, close};
}

test('SQLite baseline and scoped opaque cursors isolate private/group same number and colliding group IDs', async t => {
  const {store, collector, state} = sqliteFixture(t);
  for (const chat of [PRIVATE, SAME_NUMBER, GROUP_A, GROUP_B]) {
    state.records.set(key(chat), [raw(1, chat, {sender: chat.type === 'private' ? TARGET : '20001'}), raw(2, chat, {sender: SELF})]);
    await collector.collect(chat);
  }
  for (const chat of [PRIVATE, SAME_NUMBER, GROUP_A, GROUP_B]) {
    const page = store.page(chat, '0', 20);
    assert.deepEqual(page.messages.map(value => [value.message_id, value.direction]), [['1', 'incoming'], ['2', 'outgoing']]);
    assert.equal(store.historySnapshot(chat).records.length, 2);
    assert.equal(store.sourceState(chat).incomplete, true);
  }
  const a = store.page(GROUP_A).messages[0].cursor, privateCursor = store.page(PRIVATE).messages[0].cursor;
  const calls = state.calls.length;
  await assert.rejects(collector.pollEvents({conversation: GROUP_B, after: a}), code('cursor_conversation_mismatch'));
  await assert.rejects(collector.pollEvents({conversation: SAME_NUMBER, after: privateCursor}), code('cursor_conversation_mismatch'));
  assert.equal(state.calls.length, calls);
});

test('SQLite reopen preserves anchors, cursor secrets and bidirectional history; new collector marks resume', async t => {
  const f = sqliteFixture(t);
  f.state.records.set(key(GROUP_A), [raw(1), raw(2, GROUP_A, {sender: SELF})]); await f.collector.collect(GROUP_A);
  const page = f.store.page(GROUP_A), original = f.store.sourceState(GROUP_A), stream = f.store.streamId;
  f.close(f.store); f.state.now += 5000; const store = f.open();
  assert.equal(store.streamId, stream); assert.equal(store.sourceState(GROUP_A).anchor, original.anchor);
  assert.deepEqual(store.page(GROUP_A, page.cursor).events, []);
  const collector = new ScopedEventCollector(store, f.source, {selfId: SELF});
  f.state.records.set(key(GROUP_A), [raw(1), raw(2, GROUP_A, {sender: SELF}), raw(3)]); await collector.collect(GROUP_A);
  const next = store.page(GROUP_A, page.cursor);
  assert.ok(next.events.some(event => event.code === 'process_resume_interval'));
  assert.deepEqual(next.messages.map(event => event.message_id), ['3']);
  assert.equal(store.sourceState(GROUP_A).coverage_start_at, original.coverage_start_at);
  assert.deepEqual(store.historySnapshot(GROUP_A).records.map(row => row.message_id), ['1', '2', '3']);
});

test('SQLite realtime recall revokes only the matching group image despite identical message/file IDs', async t => {
  const f = sqliteFixture(t), image = [{type: 'image', data: {file: 'collision.png', file_size: 123}}];
  for (const chat of [PRIVATE, GROUP_A, GROUP_B]) {
    f.state.records.set(key(chat), [raw(1, chat, {sender: chat.type === 'private' ? TARGET : '20001', message: image})]);
    await f.collector.collect(chat);
  }
  const references = [PRIVATE, GROUP_A, GROUP_B].map(chat => ({conversation: chat, cursor: f.store.page(chat).messages[0].cursor}));
  f.collector.ingest({post_type: 'notice', notice_type: 'group_recall', group_id: 10001, message_id: '1',
    user_id: 20001, operator_id: 20002, time: 1800000010}, {conversation: GROUP_A, transport: 'napcat-event'});
  assert.equal(f.store.getRetainedMessage(references[0]).state, 'available');
  assert.equal(f.store.getRetainedMessage(references[1]).state, 'withdrawn');
  assert.deepEqual(f.store.getRetainedMessage(references[1]).messages, []);
  assert.equal(f.store.getRetainedMessage(references[2]).state, 'available');
  assert.throws(() => f.store.getRetainedMessage({conversation: GROUP_B, cursor: references[1].cursor}), code('cursor_conversation_mismatch'));
  f.close(f.store); const reopened = f.open();
  assert.equal(reopened.getRetainedMessage(references[1]).state, 'withdrawn');
  assert.equal(reopened.getRetainedMessage(references[2]).messages[0].file_id, 'collision.png');
});

test('SQLite cross-connection lease blocks competing collector and expired owner cannot commit', async t => {
  const f = sqliteFixture(t); let release, calls = 0;
  f.state.records.set(key(GROUP_A), [raw(1)]);
  f.state.wait = () => ++calls === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
  const pending = f.collector.collect(GROUP_A), secondStore = f.open();
  const other = new ScopedEventCollector(secondStore, f.source, {selfId: SELF});
  assert.equal((await other.collect(GROUP_A)).busy, true);
  await other.collect(GROUP_B);
  f.state.now += 30001; await other.collect(GROUP_A);
  f.state.records.set(key(GROUP_A), [raw(1), raw(2)]); await other.collect(GROUP_A);
  const anchor = secondStore.sourceState(GROUP_A).anchor;
  release(); await assert.rejects(pending, code('source_lease_lost'));
  assert.equal(f.store.sourceState(GROUP_A).anchor, anchor);
  assert.deepEqual(f.store.page(GROUP_A).messages.map(row => row.message_id), ['1', '2']);
});

test('SQLite scope revocation during collection destroys old cursor epoch before reopen', async t => {
  let allowed = true;
  const policy = {authorize: chat => chat.type === 'private' || (allowed && chat.id === GROUP_A.id)};
  const f = sqliteFixture(t, {policy}); f.state.records.set(key(GROUP_A), [raw(1)]); await f.collector.collect(GROUP_A);
  const cursor = f.store.page(GROUP_A).messages[0].cursor; let release;
  f.state.wait = () => new Promise(resolve => { release = resolve; });
  const pending = f.collector.pollEvents({conversation: GROUP_A, after: cursor}); allowed = false; release();
  await assert.rejects(pending, code('conversation_forbidden'));
  f.close(f.store); allowed = true; f.state.wait = null; const reopened = f.open();
  assert.throws(() => reopened.page(GROUP_A, cursor), code('invalid_cursor'));
  assert.equal(reopened.sourceState(GROUP_A), null); assert.equal(reopened.page(GROUP_A).messages.length, 0);
});

test('SQLite storage failure does not advance source anchor and resumed retry recovers committed prefix', async t => {
  const f = sqliteFixture(t); f.state.records.set(key(GROUP_A), [raw(1)]); await f.collector.collect(GROUP_A);
  const anchor = f.store.sourceState(GROUP_A).anchor;
  f.store.db.exec("CREATE TRIGGER mock_fail_record BEFORE INSERT ON sr_log WHEN NEW.event_type='message' AND json_extract(NEW.payload,'$.message_id')='3' BEGIN SELECT RAISE(ABORT,'mock failure'); END;");
  f.state.records.set(key(GROUP_A), [raw(1), raw(2), raw(3)]);
  await assert.rejects(f.collector.collect(GROUP_A), code('event_storage_unavailable'));
  assert.equal(f.store.sourceState(GROUP_A).anchor, anchor);
  f.store.db.exec('DROP TRIGGER mock_fail_record'); await f.collector.collect(GROUP_A);
  assert.deepEqual(f.store.page(GROUP_A).messages.map(row => row.message_id), ['1', '2', '3']);
});

test('SQLite group without self identity stays unknown; outgoing and unknown history do not enter reply inbox', async t => {
  const f = sqliteFixture(t); const unknown = raw(1); delete unknown.self_id;
  f.state.records.set(key(GROUP_A), [unknown]);
  const collector = new ScopedEventCollector(f.store, f.source); await collector.collect(GROUP_A);
  assert.equal(f.store.page(GROUP_A).messages[0].direction, 'unknown');
  f.store.openConsumer(GROUP_A); f.store.readIntoInbox(GROUP_A);
  assert.equal(f.store.claim(GROUP_A), null);
  f.state.records.set(key(GROUP_B), [raw(1, GROUP_B, {sender: SELF}), raw(2, GROUP_B)]); await f.collector.collect(GROUP_B);
  f.store.openConsumer(GROUP_B); f.store.readIntoInbox(GROUP_B);
  const claim = f.store.claim(GROUP_B); assert.equal(claim.event.message_id, '2'); assert.equal(claim.event.direction, 'incoming');
  assert.equal(f.store.claim(GROUP_B), null);
});

test('SQLite retention is bounded and returns an explicit local gap after collector bursts', async t => {
  const f = sqliteFixture(t, {maxRows: 3});
  f.state.records.set(key(GROUP_A), Array.from({length: 20}, (_, i) => raw(i + 1))); await f.collector.collect(GROUP_A);
  const page = f.store.page(GROUP_A, '0', 20);
  assert.equal(page.messages.length, 3); assert.ok(page.events.some(row => row.code === 'local_retention'));
  assert.equal(page.coverage.upstream_complete, false); assert.equal(page.source_status.incomplete, true);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM sr_log WHERE scope=?').get(key(GROUP_A)).n, 3);
});

test('collector bounds complete serialized events/messages response, including duplicated media projections', async t => {
  const chat = {type: 'group', id: '12345678901234567890'}, sender = '22222222222222222222';
  const f = sqliteFixture(t, {policy: createScopedConversationPolicy({allowedGroups: [chat.id]})});
  const message = [{type: 'text', data: {text: String.fromCodePoint(0x1f600).repeat(2000)}},
    ...Array.from({length: 7}, () => ({type: 'image', data: {file: `${'9'.repeat(120)}.png`, file_size: 2147483647}}))];
  f.state.records.set(key(chat), Array.from({length: 20}, (_, i) => ({...raw(i + 1, chat, {message}),
    group_id: chat.id, sender: {user_id: sender}, user_id: sender, message_id: String(10000000000000000000n + BigInt(i))})));
  await f.collector.collect(chat);
  const afterGap = f.store.page(chat).events[0].cursor;
  await assert.rejects(f.collector.pollEvents({conversation: chat, after: afterGap}), code('events_response_too_large'));
  const smaller = await f.collector.pollEvents({conversation: chat, after: afterGap, limit: 10});
  assert.equal(smaller.messages.length, 10); assert.ok(Buffer.byteLength(JSON.stringify(smaller)) <= SCOPED_SOURCE_MAX_BYTES);
});

test('collector history and trusted realtime delivery share dedup without dropping quotes or double queueing', async t => {
  const f = sqliteFixture(t), quoted = raw(2, GROUP_A, {message: [{type: 'reply', data: {id: '1'}}, {type: 'at', data: {qq: '20001'}},
    {type: 'text', data: {text: 'kept quote'}}], references_complete: true});
  f.state.records.set(key(GROUP_A), [raw(1)]); await f.collector.collect(GROUP_A);
  f.collector.ingest(quoted, {conversation: GROUP_A, transport: 'napcat-event'});
  f.state.records.set(key(GROUP_A), [raw(1), quoted]); await f.collector.collect(GROUP_A);
  const page = f.store.page(GROUP_A); assert.deepEqual(page.messages.map(row => row.message_id), ['1', '2']);
  assert.ok(page.messages[1].messages.some(row => row.type === 'reply' && row.id === '1'));
  f.store.openConsumer(GROUP_A); f.store.readIntoInbox(GROUP_A);
  assert.equal(f.store.claim(GROUP_A).event.message_id, '1'); assert.equal(f.store.claim(GROUP_A).event.message_id, '2');
  assert.equal(f.store.claim(GROUP_A), null);
});

test('unrepresentable history record persists a gap, advances its anchor, and does not hide newer messages', async t => {
  const f = sqliteFixture(t); f.state.records.set(key(GROUP_A), [raw(1), raw(2, GROUP_A, {message: [{type: 'json', data: {data: 'opaque'}}]}), raw(3)]);
  await f.collector.collect(GROUP_A); await f.collector.collect(GROUP_A);
  const page = f.store.page(GROUP_A);
  assert.deepEqual(page.messages.map(row => row.message_id), ['1', '3']);
  assert.equal(page.events.filter(row => row.code === 'record_unrepresentable').length, 1);
  assert.equal(f.store.sourceState(GROUP_A).anchor, 'group:10001:3:1800000003');
});

test('same-second descending message IDs in an overlapping latest window are all retained', async t => {
  const f = sqliteFixture(t), tied = id => ({...raw(id), time: 1800000001});
  f.state.records.set(key(GROUP_A), [tied(99)]); await f.collector.collect(GROUP_A);
  const initial = f.store.page(GROUP_A).cursor;
  f.state.records.set(key(GROUP_A), [tied(99), tied(98), tied(97)]); await f.collector.collect(GROUP_A);
  assert.deepEqual(new Set(f.store.page(GROUP_A).messages.map(row => row.message_id)), new Set(['99', '98', '97']));
  assert.deepEqual(f.store.page(GROUP_A, initial).messages.map(row => row.message_id), ['97', '98']);
  await f.collector.collect(GROUP_A); assert.equal(f.store.page(GROUP_A).messages.length, 3);
});

test('late history rows older than an overlap anchor are retained without inferring upstream order', async t => {
  const f = sqliteFixture(t); f.state.records.set(key(GROUP_A), [raw(10)]); await f.collector.collect(GROUP_A);
  f.state.records.set(key(GROUP_A), [raw(10), raw(9), raw(11)]); await f.collector.collect(GROUP_A);
  assert.deepEqual(new Set(f.store.page(GROUP_A).messages.map(row => row.message_id)), new Set(['10', '9', '11']));
  assert.equal(f.store.sourceState(GROUP_A).incomplete, true);
});
