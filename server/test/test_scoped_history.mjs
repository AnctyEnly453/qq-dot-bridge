import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventFailure, TARGET, createScopedConversationPolicy, requireConversation, scopeKey} from '../src/scoped_policy.mjs';
import {ScopedHistoryTools, createScopedHistoryTools, SCOPED_HISTORY_LIMITS} from '../src/scoped_history.mjs';
import {ScopedEventStore} from '../src/scoped_events.mjs';

const A = Object.freeze({type: 'group', id: '10001'}), B = Object.freeze({type: 'group', id: '10002'});
const P = Object.freeze({type: 'private', id: TARGET}), SAME = Object.freeze({type: 'group', id: TARGET});
const ids = page => page.messages.map(message => message.message_id);
const expectFailure = (fn, code, status = 400) => assert.throws(fn, error => error?.code === code && error?.status === status);

// Contract fixture only; no transport, real group call, production database or credentials.
class FakeStore {
  constructor({policy = createScopedConversationPolicy({allowedGroups: [A.id, B.id, SAME.id]}), secret = Buffer.alloc(32, 5), clock = 1000} = {}) {
    this.policy = policy; this.secret = secret; this.clock = clock; this.streamId = 'fixture-stream';
    this.records = new Map(); this.high = new Map(); this.floor = new Map(); this.epochs = new Map(); this.reads = 0;
  }
  now() { return this.clock; }
  scopeEpoch(chat) { return this.epochs.get(scopeKey(chat)) ?? 'epoch-1'; }
  authorize(chat) {
    try { return requireConversation(this.policy, chat); }
    catch (error) {
      if (chat?.type && chat?.id) {
        const key = scopeKey(chat);
        if (this.records.has(key)) { this.records.delete(key); this.high.delete(key); this.floor.delete(key); this.epochs.set(key, 'epoch-2'); }
      }
      throw error;
    }
  }
  add(chat, message_id, time, {seq, expires = 100000, ...rest} = {}) {
    const key = scopeKey(chat), records = this.records.get(key) ?? [];
    const next = seq ?? (this.high.get(key) ?? 0) + 1;
    const row = {seq: next, expires, schema: 'qq.normalized-event.v1', event_type: 'message', conversation: {...chat},
      message_id, user_id: '12345', time, direction: 'incoming', state: 'available',
      messages: [{type: 'text', text: `text-${message_id}`}], references_complete: true, ...rest};
    records.push(row); this.records.set(key, records); this.high.set(key, Math.max(next, this.high.get(key) ?? 0)); return row;
  }
  historySnapshot(chat) {
    this.authorize(chat); this.reads++;
    return {now: this.clock, high: this.high.get(scopeKey(chat)) ?? 0, floor: this.floor.get(scopeKey(chat)) ?? 0,
      stream_id: this.streamId, scope_epoch: this.scopeEpoch(chat), records: structuredClone(this.records.get(scopeKey(chat)) ?? []),
      coverage: {source: 'synthetic_retained_fixture', upstream_complete: true}};
  }
  signToken(prefix, payload) {
    const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const mac = crypto.createHmac('sha256', this.secret).update(`${prefix}.${data}`).digest('base64url');
    return `${prefix}.${data}.${mac}`;
  }
  verifyToken(prefix, token) {
    if (typeof token !== 'string' || !token.startsWith(`${prefix}.`)) throw new EventFailure(400, 'invalid_cursor');
    const parts = token.split('.');
    if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) throw new EventFailure(400, 'invalid_cursor');
    const expected = crypto.createHmac('sha256', this.secret).update(`${prefix}.${parts[1]}`).digest();
    const actual = Buffer.from(parts[2], 'base64url');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new EventFailure(400, 'invalid_cursor');
    const bytes = Buffer.from(parts[1], 'base64url'), value = JSON.parse(bytes.toString());
    if (bytes.toString('base64url') !== parts[1] || JSON.stringify(value) !== bytes.toString()) throw new EventFailure(400, 'invalid_cursor');
    return value;
  }
  cursor(chat, seq) { this.authorize(chat); return this.signToken('e1', {conversation: {...chat}, stream_id: this.streamId, scope_epoch: this.scopeEpoch(chat), seq}); }
}
function fixture(options) { const store = new FakeStore(options); return {store, tools: createScopedHistoryTools(store)}; }
function series(store, chat = A, count = 7) { for (let n = 1; n <= count; n++) store.add(chat, String(n), 100 + n); }

test('exports bound callables and has no collector or transport effects', () => {
  const {store, tools} = fixture();
  assert.equal(store.reads, 0);
  assert.deepEqual(Object.keys(tools), ['readHistory', 'searchHistory', 'getMessage', 'read_history', 'search_history', 'get_message']);
  assert.equal(SCOPED_HISTORY_LIMITS.maxResultBytes, 380 * 1024);
  const {readHistory} = tools;
  assert.equal(readHistory({conversation: A}).status, 'empty');
});
test('empty group allowlist refuses all reads before store snapshot', () => {
  const {store, tools} = fixture({policy: createScopedConversationPolicy()});
  for (const [name, args] of [['readHistory', {}], ['searchHistory', {query: 'text'}], ['getMessage', {message_id: '1'}]])
    expectFailure(() => tools[name]({conversation: A, ...args}), 'conversation_forbidden', 403);
  assert.equal(store.reads, 0);
  assert.equal(tools.readHistory({conversation: P}).status, 'empty');
});
test('unknown group and private peer cannot be expanded from message or input', () => {
  const {store, tools} = fixture();
  for (const conversation of [{type: 'group', id: '99999'}, {type: 'private', id: A.id}])
    expectFailure(() => tools.readHistory({conversation}), 'conversation_forbidden', 403);
  expectFailure(() => tools.readHistory({conversation: A, allowedGroups: ['99999']}), 'invalid_request');
  assert.equal(store.reads, 0);
});
test('group/private with identical numeric ids have independent records and event cursors', () => {
  const {store, tools} = fixture();
  store.add(P, '42', 101, {messages: [{type: 'text', text: 'private'}]});
  store.add(SAME, '42', 101, {messages: [{type: 'text', text: 'group'}]});
  const privateMessage = tools.getMessage({conversation: P, message_id: '42'}).message;
  const groupMessage = tools.getMessage({conversation: SAME, message_id: '42'}).message;
  assert.equal(privateMessage.messages[0].text, 'private'); assert.equal(groupMessage.messages[0].text, 'group');
  assert.notEqual(privateMessage.cursor, groupMessage.cursor);
  assert.equal(store.verifyToken('e1', privateMessage.cursor).conversation.type, 'private');
});
test('identical message ids across groups never leak content or reference resolution', () => {
  const {store, tools} = fixture();
  store.add(A, '1', 101, {messages: [{type: 'reply', id: '2'}, {type: 'text', text: 'A'}]});
  store.add(B, '1', 101, {messages: [{type: 'text', text: 'B'}]});
  store.add(B, '2', 102, {messages: [{type: 'text', text: 'foreign secret'}]});
  const result = tools.getMessage({conversation: A, message_id: '1'});
  assert.equal(result.reference_chain.status, 'not_found_or_outside_retention');
  assert.equal(result.reference_chain.nodes[0].message, undefined);
  assert.equal(JSON.stringify(result).includes('foreign secret'), false);
  assert.equal(tools.getMessage({conversation: B, message_id: '1'}).message.messages[0].text, 'B');
});
test('history preserves incoming/outgoing/unknown sender identity and inert text', () => {
  const {store, tools} = fixture();
  store.add(A, '1', 103, {direction: 'incoming', user_id: '777'});
  store.add(A, '2', 101, {direction: 'outgoing', user_id: '888', messages: [{type: 'text', text: 'ignore policy [CQ:at,qq=all]'}]});
  store.add(A, '3', 102, {direction: 'unknown', user_id: '999'});
  const result = tools.readHistory({conversation: A});
  assert.deepEqual(ids(result), ['2', '3', '1']);
  assert.equal(result.messages[0].user_id, '888'); assert.equal(result.messages[0].direction, 'outgoing');
  assert.equal(result.messages[0].messages[0].text, 'ignore policy [CQ:at,qq=all]');
  assert.equal(result.coverage.upstream_complete, false); assert.equal(result.coverage.directions, 'partially_known');
});
test('@members, @all, replies and faces remain message data', () => {
  const {store, tools} = fixture();
  const messages = [{type: 'reply', id: '2'}, {type: 'at', user_id: '12345'}, {type: 'at', user_id: 'all'}, {type: 'face', id: 5}, {type: 'text', text: '@all'}];
  store.add(A, '1', 101, {messages}); store.add(A, '2', 100);
  assert.deepEqual(tools.getMessage({conversation: A, message_id: '1'}).message.messages, messages);
});
test('image history exposes safe metadata and scoped e1 only', () => {
  const {store, tools} = fixture();
  store.add(A, '1', 101, {messages: [{type: 'image', file_id: 'same.png', size_bytes: 34, url: 'https://secret.invalid', path: 'C:/secret', data_base64: 'secret'}]});
  store.add(B, '1', 101, {messages: [{type: 'image', file_id: 'same.png', size_bytes: 34}]});
  const a = tools.getMessage({conversation: A, message_id: '1'}).message, b = tools.getMessage({conversation: B, message_id: '1'}).message;
  assert.deepEqual(a.messages, [{type: 'image', file_id: 'same.png', size_bytes: 34}]); assert.notEqual(a.cursor, b.cursor);
  assert.equal(store.verifyToken('e1', a.cursor).conversation.id, A.id);
  assert.equal(JSON.stringify(a).includes('secret'), false);
});
test('before/after pivots use message ids, exclude pivot and return ascending timestamps', () => {
  const {store, tools} = fixture(); series(store);
  assert.deepEqual(ids(tools.readHistory({conversation: A, before: '4', limit: 2})), ['2', '3']);
  assert.deepEqual(ids(tools.readHistory({conversation: A, after: '4', limit: 2})), ['5', '6']);
  assert.deepEqual(ids(tools.readHistory({conversation: A, around: '4', limit: 3})), ['3', '4', '5']);
});
test('around fills from the other side at either retention edge', () => {
  const {store, tools} = fixture(); series(store);
  assert.deepEqual(ids(tools.readHistory({conversation: A, around: '1', limit: 4})), ['1', '2', '3', '4']);
  assert.deepEqual(ids(tools.readHistory({conversation: A, around: '7', limit: 4})), ['4', '5', '6', '7']);
});
test('same-second order uses local seq instead of numeric message id', () => {
  const {store, tools} = fixture();
  store.add(A, '999', 100); store.add(A, '-4', 100); store.add(A, '1', 100);
  assert.deepEqual(ids(tools.readHistory({conversation: A})), ['999', '-4', '1']);
  assert.deepEqual(ids(tools.readHistory({conversation: A, before: '1'})), ['999', '-4']);
});
test('bidirectional opaque history pages retain original snapshot', () => {
  const {store, tools} = fixture(); series(store);
  const first = tools.readHistory({conversation: A, limit: 2});
  assert.deepEqual(ids(first), ['6', '7']); assert.match(first.next_before, /^h2\./);
  store.add(A, '8', 108); store.add(A, '9', 1);
  const prior = tools.readHistory({conversation: A, cursor: first.next_before});
  assert.deepEqual(ids(prior), ['4', '5']);
  assert.deepEqual(ids(tools.readHistory({conversation: A, cursor: prior.next_after})), ['6', '7']);
  assert.equal(prior.snapshot.high_cursor, first.snapshot.high_cursor);
});
test('history cursor cannot cross groups or private/group of the same number', () => {
  const {store, tools} = fixture(); series(store, A); series(store, B); series(store, P); series(store, SAME);
  const a = tools.readHistory({conversation: A, limit: 2}).next_before;
  expectFailure(() => tools.readHistory({conversation: B, cursor: a}), 'cursor_conversation_mismatch', 403);
  const p = tools.readHistory({conversation: P, limit: 2}).next_before;
  expectFailure(() => tools.readHistory({conversation: SAME, cursor: p}), 'cursor_conversation_mismatch', 403);
});
test('history cursors require HMAC and reject event cursors, decimals, overlong tokens', () => {
  const {store, tools} = fixture(); series(store);
  const token = tools.readHistory({conversation: A, limit: 2}).next_before;
  const [prefix, data, mac] = token.split('.');
  const changed = JSON.parse(Buffer.from(data, 'base64url')); changed.position.seq = 1;
  for (const bad of [`${prefix}.${Buffer.from(JSON.stringify(changed)).toString('base64url')}.${mac}`, '1', store.cursor(A, 1), 'h2.' + 'a'.repeat(4096), token + '.x'])
    expectFailure(() => tools.readHistory({conversation: A, cursor: bad}), 'invalid_cursor');
});
test('history cursor binds tool and limit', () => {
  const {store, tools} = fixture(); series(store);
  const token = tools.readHistory({conversation: A, limit: 2}).next_before;
  expectFailure(() => tools.searchHistory({conversation: A, cursor: token}), 'cursor_query_mismatch');
  expectFailure(() => tools.readHistory({conversation: A, cursor: token, limit: 3}), 'cursor_query_mismatch');
  expectFailure(() => tools.readHistory({conversation: A, cursor: token, before: '5'}), 'invalid_request');
});
test('stream reset rejects old history tokens', () => {
  const {store, tools} = fixture(); series(store);
  const token = tools.readHistory({conversation: A, limit: 2}).next_before;
  store.streamId = 'fixture-stream-new';
  expectFailure(() => tools.readHistory({conversation: A, cursor: token}), 'cursor_scope_mismatch');
});
test('scope epoch change rejects old history tokens after revoke/reopen', () => {
  let allowed = true;
  const policy = {authorize: conversation => conversation.type === 'private' || allowed};
  const {store, tools} = fixture({policy}); series(store);
  const token = tools.readHistory({conversation: A, limit: 2}).next_before;
  allowed = false;
  expectFailure(() => tools.readHistory({conversation: A}), 'conversation_forbidden', 403);
  assert.equal(store.records.has(scopeKey(A)), false);
  allowed = true; series(store);
  expectFailure(() => tools.readHistory({conversation: A, cursor: token}), 'cursor_scope_mismatch');
});
test('cursor survives adapter recreation with same persisted HMAC key and scope', () => {
  const {store, tools} = fixture(); series(store);
  const token = tools.readHistory({conversation: A, limit: 2}).next_before;
  const reopened = new FakeStore({secret: store.secret}); reopened.records = structuredClone(store.records); reopened.high = structuredClone(store.high);
  assert.deepEqual(ids(createScopedHistoryTools(reopened).readHistory({conversation: A, cursor: token})), ['4', '5']);
  reopened.secret = Buffer.alloc(32, 7);
  expectFailure(() => createScopedHistoryTools(reopened).readHistory({conversation: A, cursor: token}), 'invalid_cursor');
});
test('missing, expired and ambiguous anchor statuses are explicit', () => {
  const {store, tools} = fixture(); store.add(A, '1', 100, {expires: 999});
  assert.equal(tools.readHistory({conversation: A, around: '1'}).status, 'anchor_expired');
  assert.equal(tools.readHistory({conversation: A, before: '9'}).status, 'anchor_not_found');
  assert.equal(tools.getMessage({conversation: A, message_id: '1'}).status, 'expired');
  store.add(A, '2', 101); store.add(A, '2', 102);
  assert.equal(tools.readHistory({conversation: A, around: '2'}).status, 'anchor_ambiguous');
  assert.equal(tools.getMessage({conversation: A, message_id: '2'}).status, 'ambiguous');
});
test('expired and deleted cursor boundaries fail without advancing to another scope', () => {
  const {store, tools} = fixture(); series(store);
  const token = tools.readHistory({conversation: A, limit: 2}).next_before;
  store.records.get(scopeKey(A)).find(row => row.message_id === '6').expires = 999;
  let page = tools.readHistory({conversation: A, cursor: token});
  assert.equal(page.status, 'cursor_outside_retention'); assert.equal(page.reason, 'expired'); assert.deepEqual(page.messages, []);
  store.records.set(scopeKey(A), store.records.get(scopeKey(A)).filter(row => row.message_id !== '6'));
  page = tools.readHistory({conversation: A, cursor: token}); assert.equal(page.reason, 'pruned_or_missing');
});
test('pruning detects snapshot gap without losing still-retained page', () => {
  const {store, tools} = fixture(); series(store);
  const token = tools.readHistory({conversation: A, limit: 2}).next_before;
  store.records.set(scopeKey(A), store.records.get(scopeKey(A)).filter(row => row.message_id !== '1'));
  store.floor.set(scopeKey(A), 1);
  const page = tools.readHistory({conversation: A, cursor: token});
  assert.equal(page.retention.gap_detected, true); assert.equal(page.retention.has_pruned_records, true);
  assert.deepEqual(ids(page), ['4', '5']);
});
test('clock rollback cannot restore records expired before initial page', () => {
  const {store, tools} = fixture(); series(store);
  store.records.get(scopeKey(A))[0].expires = 900;
  const token = tools.readHistory({conversation: A, limit: 2}).next_before;
  store.clock = 500;
  const page = tools.readHistory({conversation: A, cursor: token});
  assert.equal(page.snapshot.as_of, 1000);
  const oldest = tools.readHistory({conversation: A, cursor: page.next_before});
  assert.equal(ids(oldest).includes('1'), false);
});
test('search folds NFKC and case with AND sender/time/image filters', () => {
  const {store, tools} = fixture();
  store.add(A, '1', 100, {messages: [{type: 'text', text: 'ＦＯＯ 中文'}, {type: 'image', file_id: 'pic.png'}]});
  store.add(A, '2', 101, {user_id: '999', messages: [{type: 'text', text: 'foo 中文'}]});
  store.add(A, '3', 102, {messages: [{type: 'text', text: 'foo 中文'}]});
  assert.deepEqual(ids(tools.searchHistory({conversation: A, query: {keyword: 'foo', sender_id: '12345', time_from: 100, time_to: 100, has_image: true}})), ['1']);
  assert.deepEqual(ids(tools.searchHistory({conversation: A, query: {keyword: '中文', has_image: false}})), ['2', '3']);
});
test('search is inert substring data, excludes withdrawn and does not match @ ids', () => {
  const {store, tools} = fixture();
  store.add(A, '1', 100, {messages: [{type: 'text', text: 'x.* OR 1=1'}]});
  store.add(A, '2', 101, {state: 'withdrawn', messages: [{type: 'text', text: 'x.* OR 1=1'}]});
  store.add(A, '3', 102, {messages: [{type: 'at', user_id: '12345'}]});
  assert.deepEqual(ids(tools.searchHistory({conversation: A, query: 'x.* OR 1=1'})), ['1']);
  assert.deepEqual(ids(tools.searchHistory({conversation: A, query: '12345'})), []);
});
test('search pagination works in both directions and binds query/context/direction', () => {
  const {store, tools} = fixture(); series(store);
  const forward = tools.searchHistory({conversation: A, query: {keyword: 'text', context_before: 1}, limit: 2});
  assert.deepEqual(ids(forward), ['1', '2']);
  const next = tools.searchHistory({conversation: A, cursor: forward.next_cursor}); assert.deepEqual(ids(next), ['3', '4']);
  assert.deepEqual(ids(tools.searchHistory({conversation: A, query: 'text', limit: 2, direction: 'before'})), ['6', '7']);
  expectFailure(() => tools.searchHistory({conversation: A, cursor: forward.next_cursor, query: {keyword: 'other'}}), 'cursor_query_mismatch');
  expectFailure(() => tools.searchHistory({conversation: A, cursor: forward.next_cursor, direction: 'before'}), 'cursor_query_mismatch');
  expectFailure(() => tools.searchHistory({conversation: A, cursor: forward.next_cursor, query: {context_before: 2}}), 'cursor_query_mismatch');
});
test('search and getMessage context includes unmatched neighbours with scoped read cursors', () => {
  const {store, tools} = fixture(); series(store);
  const hit = tools.searchHistory({conversation: A, query: {keyword: 'text-4', context_before: 1, context_after: 1}}).messages[0];
  assert.deepEqual(hit.context_anchor, {conversation: A, message_id: '4'});
  assert.deepEqual(hit.context.before.map(row => row.message_id), ['3']); assert.deepEqual(hit.context.after.map(row => row.message_id), ['5']);
  assert.deepEqual(ids(tools.readHistory({conversation: A, cursor: hit.context.before_cursor})), ['1', '2']);
  expectFailure(() => tools.readHistory({conversation: B, cursor: hit.context.after_cursor}), 'cursor_conversation_mismatch', 403);
  const context = tools.getMessage({conversation: A, message_id: '4', context_before: 2, context_after: 2}).context;
  assert.deepEqual(context.before.map(row => row.message_id), ['2', '3']); assert.deepEqual(context.after.map(row => row.message_id), ['5', '6']);
});
test('search boundary withdrawn reports cursor_record_changed and hides its old content', () => {
  const {store, tools} = fixture(); series(store);
  const token = tools.searchHistory({conversation: A, query: 'text', limit: 2}).next_cursor;
  store.records.get(scopeKey(A))[1].state = 'withdrawn';
  const result = tools.searchHistory({conversation: A, cursor: token});
  assert.equal(result.status, 'cursor_record_changed'); assert.equal(result.reason, 'withdrawn'); assert.deepEqual(result.messages, []);
});
test('reference chains resolve local parents with safe images', () => {
  const {store, tools} = fixture();
  store.add(A, '1', 101, {messages: [{type: 'reply', id: '2'}]});
  store.add(A, '2', 100, {messages: [{type: 'reply', id: '3'}]});
  store.add(A, '3', 99, {messages: [{type: 'image', file_id: 'x.png', url: 'secret'}]});
  const chain = tools.getMessage({conversation: A, message_id: '1'}).reference_chain;
  assert.equal(chain.status, 'complete'); assert.deepEqual(chain.nodes.map(node => node.message_id), ['2', '3']);
  assert.deepEqual(chain.nodes[1].message.messages, [{type: 'image', file_id: 'x.png'}]);
});
test('reference cycles and depth are bounded', () => {
  const {store, tools} = fixture();
  store.add(A, '1', 101, {messages: [{type: 'reply', id: '2'}]});
  store.add(A, '2', 100, {messages: [{type: 'reply', id: '3'}]});
  store.add(A, '3', 99, {messages: [{type: 'reply', id: '1'}]});
  const cycle = tools.getMessage({conversation: A, message_id: '1'}).reference_chain;
  assert.equal(cycle.status, 'cycle'); assert.equal(cycle.nodes.length, 2);
  const depth = tools.getMessage({conversation: A, message_id: '1', max_depth: 1}).reference_chain;
  assert.equal(depth.status, 'depth_limit'); assert.equal(depth.nodes.length, 1); assert.equal(depth.next_message_id, '3');
});
test('ambiguous reply metadata does not arbitrarily choose a parent', () => {
  const {store, tools} = fixture();
  store.add(A, '1', 101, {messages: [{type: 'reply', id: '2'}, {type: 'reply', id: '3'}]});
  const result = tools.getMessage({conversation: A, message_id: '1'});
  assert.equal(result.reference_chain.status, 'ambiguous'); assert.deepEqual(result.reference_chain.nodes, []);
});
test('duplicate target ids produce an ambiguous reference node', () => {
  const {store, tools} = fixture();
  store.add(A, '1', 101, {messages: [{type: 'reply', id: '2'}]}); store.add(A, '2', 99); store.add(A, '2', 100);
  const result = tools.getMessage({conversation: A, message_id: '1'});
  assert.equal(result.reference_chain.status, 'ambiguous'); assert.equal(result.reference_chain.nodes[0].message, undefined);
});
for (const [label, rest, expected] of [
  ['metadata unavailable', {references_complete: false}, 'metadata_unavailable'],
  ['expired parent', {expires: 999}, 'expired'],
  ['withdrawn parent', {state: 'withdrawn'}, 'withdrawn'],
  ['missing parent', {state: 'missing'}, 'missing'],
]) test(`reference chain explicitly reports ${label}`, () => {
  const {store, tools} = fixture();
  store.add(A, '1', 101, {messages: [{type: 'reply', id: '2'}]}); store.add(A, '2', 100, rest);
  const chain = tools.getMessage({conversation: A, message_id: '1'}).reference_chain;
  assert.equal(chain.status, expected);
  if (['withdrawn', 'missing'].includes(expected)) assert.deepEqual(chain.nodes[0].message.messages, []);
});
test('original tombstones hide stale content and stop reference expansion', () => {
  const {store, tools} = fixture();
  store.add(A, '1', 101, {state: 'withdrawn', messages: [{type: 'reply', id: '2'}, {type: 'text', text: 'private deleted'}, {type: 'image', file_id: 'x.png'}]});
  store.add(A, '2', 100);
  const result = tools.getMessage({conversation: A, message_id: '1'});
  assert.equal(result.status, 'withdrawn'); assert.deepEqual(result.message.messages, []);
  assert.equal(result.reference_chain.status, 'withdrawn'); assert.deepEqual(result.reference_chain.nodes, []);
  assert.equal(JSON.stringify(result).includes('private deleted'), false);
});
test('result mutation cannot alter retained rows or adjacent calls', () => {
  const {store, tools} = fixture(); series(store);
  const first = tools.readHistory({conversation: A}); first.messages[0].messages[0].text = 'corrupted'; first.messages[0].conversation.id = B.id;
  const result = tools.getMessage({conversation: A, message_id: '1'});
  assert.equal(result.message.messages[0].text, 'text-1'); assert.equal(result.message.conversation.id, A.id);
});
test('foreign conversation snapshot rows fail closed rather than disclose', () => {
  const {store, tools} = fixture(); store.add(A, '1', 100);
  store.records.get(scopeKey(A))[0].conversation = B;
  expectFailure(() => tools.readHistory({conversation: A}), 'history_corrupt', 503);
});
test('source corrupt ids, local seq and image paths fail closed', () => {
  for (const mutation of [row => row.message_id = 'abc', row => row.seq = 0, row => row.user_id = 'all',
    row => row.messages = [{type: 'image', file_id: '../secret.png'}], row => row.time = -1]) {
    const {store, tools} = fixture(); mutation(store.add(A, '1', 100));
    expectFailure(() => tools.readHistory({conversation: A}), 'history_corrupt', 503);
  }
});
test('payload wrappers work and nonmessage notices remain outside history', () => {
  const {store, tools} = fixture(); const row = store.add(A, '1', 100);
  const {seq, expires, ...payload} = row;
  store.records.set(scopeKey(A), [{seq, expires, payload: JSON.stringify(payload)},
    {seq: 2, expires: 100000, event_type: 'gap', conversation: A}]); store.high.set(scopeKey(A), 2);
  assert.deepEqual(ids(tools.readHistory({conversation: A})), ['1']);
});
test('row and UTF8 payload bounds fail explicitly', () => {
  const {store} = fixture(); series(store, A, 3);
  expectFailure(() => createScopedHistoryTools(store, {maxRows: 2}).readHistory({conversation: A}), 'history_capacity_exceeded', 503);
  store.records.get(scopeKey(A))[0].messages = [{type: 'text', text: '😀'.repeat(2000)}];
  expectFailure(() => createScopedHistoryTools(store, {maxPayloadBytes: 512}).getMessage({conversation: A, message_id: '1'}), 'history_capacity_exceeded', 503);
});
test('bounded output rejects large text/context/reply envelopes without truncation', () => {
  const {store} = fixture();
  for (let n = 1; n <= 4; n++) store.add(A, String(n), 100 + n, {messages: [{type: 'text', text: '😀'.repeat(1500)}, ...(n < 4 ? [{type: 'reply', id: String(n + 1)}] : [])]});
  const tools = createScopedHistoryTools(store, {maxResultBytes: 10000});
  expectFailure(() => tools.readHistory({conversation: A}), 'history_response_too_large', 413);
  expectFailure(() => tools.getMessage({conversation: A, message_id: '1'}), 'history_response_too_large', 413);
  expectFailure(() => tools.searchHistory({conversation: A, query: {keyword: '😀', context_after: 3}}), 'history_response_too_large', 413);
  assert.equal(createScopedHistoryTools(store).getMessage({conversation: A, message_id: '4'}).message.messages[0].text.length, 3000);
});
test('input accessors and non JSON data never execute', () => {
  const {store, tools} = fixture(); let invoked = 0;
  const input = {conversation: A}; Object.defineProperty(input, 'limit', {enumerable: true, get() { invoked++; return 2; }});
  expectFailure(() => tools.readHistory(input), 'invalid_request');
  expectFailure(() => tools.readHistory({conversation: A, limit: undefined}), 'invalid_request');
  assert.equal(invoked, 0); assert.equal(store.reads, 0);
});
test('invalid pivots, contexts, filters and option expansion are rejected', () => {
  const {tools} = fixture();
  for (const input of [{before: '1', after: '2'}, {around: null}, {before: 'h2.test'}, {limit: 0}, {limit: 51}, {limit: 1.5}, {sql: 'select *'}])
    expectFailure(() => tools.readHistory({conversation: A, ...input}), 'invalid_request');
  for (const input of [{query: ''}, {query: {keyword: 'x'.repeat(201)}}, {query: {sender_id: 123}}, {query: {time_from: 5, time_to: 4}},
    {query: {has_image: 'true'}}, {query: {context_before: 21}}, {query: {regex: '.*'}}, {direction: 'around'}])
    expectFailure(() => tools.searchHistory({conversation: A, ...input}), 'invalid_request');
  for (const input of [{max_depth: 0}, {max_depth: 17}, {context_after: 21}, {message_id: 1}])
    expectFailure(() => tools.getMessage({conversation: A, message_id: '1', ...input}), 'invalid_request');
});
test('trusted error factory applies to policy, cursor and source failures', () => {
  const {store} = fixture();
  class HostFailure extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
  const tools = new ScopedHistoryTools(store, {errorFactory: (status, code) => new HostFailure(status, code)});
  assert.throws(() => tools.readHistory({conversation: {type: 'group', id: '999'}}), HostFailure);
  assert.throws(() => tools.readHistory({conversation: A, cursor: '1'}), HostFailure);
  store.historySnapshot = () => { throw new Error('sqlite busy'); };
  assert.throws(() => tools.readHistory({conversation: A}), error => error instanceof HostFailure && error.code === 'history_unavailable');
});
test('policy revocation during snapshot prevents disclosure at return', () => {
  let allowed = true; const {store, tools} = fixture({policy: {authorize: () => allowed}}); series(store);
  const original = store.historySnapshot.bind(store);
  store.historySnapshot = chat => { const result = original(chat); allowed = false; return result; };
  expectFailure(() => tools.readHistory({conversation: A}), 'conversation_forbidden', 403);
});
test('compatibility snake methods use scoped conversation contract', () => {
  const {store, tools} = fixture(); series(store);
  assert.deepEqual(ids(tools.read_history({conversation: A})), ids(tools.readHistory({conversation: A})));
  assert.deepEqual(ids(tools.search_history({conversation: A, query: 'text-3'})), ['3']);
  assert.equal(tools.get_message({conversation: A, message_id: '3'}).status, 'found');
  expectFailure(() => tools.read_history({target: A.id}), 'invalid_request');
});

const mockPolicy = () => createScopedConversationPolicy({allowedGroups: [A.id, B.id, SAME.id]});
function rawMessage(chat, id, {time = 100, sender = '12345', self = '9988', text = `${chat.type}-${chat.id}-${id}`, parts} = {}) {
  return {post_type: 'message', message_type: chat.type, ...(chat.type === 'group' ? {group_id: chat.id} : {}),
    message_id: id, user_id: chat.type === 'private' ? chat.id : sender, sender: {user_id: sender},
    self_id: self, time, references_complete: true, message: parts ?? [{type: 'text', data: {text}}]};
}
function realMemory(t, options = {}) {
  const store = new ScopedEventStore(':memory:', {policy: mockPolicy(), clock: () => 1000000, ...options});
  t.after(() => store.close());
  return {store, tools: createScopedHistoryTools(store)};
}
function safeTemp() {
  const tempRoot = path.resolve(os.tmpdir()), directory = fs.mkdtempSync(path.join(tempRoot, 'scoped-history-test-'));
  const cleanup = () => {
    const target = path.resolve(directory);
    if (path.dirname(target) !== tempRoot || !path.basename(target).startsWith('scoped-history-test-')) throw new Error('unsafe test cleanup');
    fs.rmSync(target, {recursive: true, force: true});
  };
  return {database: path.join(directory, 'synthetic.sqlite3'), cleanup};
}
test('SQLite E2E groups/private with colliding ids keep history, search, reply and media cursors isolated', t => {
  const {store, tools} = realMemory(t);
  for (const chat of [A, B, P, SAME]) {
    const sender = chat.type === 'private' ? TARGET : '12345';
    store.ingest(rawMessage(chat, '1', {sender}), {conversation: chat});
    store.ingest(rawMessage(chat, '2', {time: 101, sender, parts: [
      {type: 'reply', data: {id: '1'}}, {type: 'at', data: {qq: '55555'}},
      {type: 'image', data: {file: 'same.png', file_size: 40, url: 'https://private.invalid'}},
      {type: 'text', data: {text: `${chat.type}-${chat.id}-reply`}},
    ]}), {conversation: chat});
    assert.deepEqual(ids(tools.readHistory({conversation: chat})), ['1', '2']);
    assert.deepEqual(ids(tools.searchHistory({conversation: chat, query: {has_image: true}})), ['2']);
    const result = tools.getMessage({conversation: chat, message_id: '2'});
    assert.equal(result.reference_chain.status, 'complete');
    assert.equal(result.reference_chain.nodes[0].message.messages[0].text, `${chat.type}-${chat.id}-1`);
    assert.equal(store.decodeCursor(chat, result.message.cursor), 2);
    assert.equal(JSON.stringify(result).includes('private.invalid'), false);
    if (chat.type === 'group') assert.ok(result.message.messages.some(part => part.type === 'at'));
  }
  const token = tools.readHistory({conversation: A, limit: 1}).next_before;
  expectFailure(() => tools.readHistory({conversation: B, cursor: token}), 'cursor_conversation_mismatch', 403);
  const sameToken = tools.readHistory({conversation: P, limit: 1}).next_before;
  expectFailure(() => tools.readHistory({conversation: SAME, cursor: sameToken}), 'cursor_conversation_mismatch', 403);
  assert.notEqual(tools.getMessage({conversation: P, message_id: '2'}).message.cursor, tools.getMessage({conversation: SAME, message_id: '2'}).message.cursor);
});
test('SQLite E2E private and group outgoing history preserve actual sender', t => {
  const {store, tools} = realMemory(t);
  store.ingest(rawMessage(P, '1', {sender: TARGET}), {conversation: P});
  store.ingest(rawMessage(P, '2', {sender: '9988', time: 101}), {conversation: P});
  store.ingest(rawMessage(A, '1', {sender: '9988'}), {conversation: A});
  assert.equal(tools.getMessage({conversation: P, message_id: '1'}).message.direction, 'incoming');
  for (const chat of [P, A]) {
    const message = tools.getMessage({conversation: chat, message_id: chat.type === 'private' ? '2' : '1'}).message;
    assert.equal(message.direction, 'outgoing'); assert.equal(message.user_id, '9988');
  }
});
test('SQLite E2E group recall tombstones only that group and invalidates matching search cursor', t => {
  const {store, tools} = realMemory(t);
  for (const chat of [A, B]) for (let n = 1; n <= 3; n++) store.ingest(rawMessage(chat, String(n), {time: 100 + n, parts: [
    {type: 'text', data: {text: 'image text'}}, {type: 'image', data: {file: 'same.png'}},
  ]}), {conversation: chat});
  const token = tools.searchHistory({conversation: A, query: 'image', limit: 2}).next_cursor;
  store.ingest({post_type: 'notice', notice_type: 'group_recall', group_id: A.id, user_id: '12345', message_id: '2', time: 200});
  const withdrawn = tools.getMessage({conversation: A, message_id: '2'});
  assert.equal(withdrawn.status, 'withdrawn'); assert.deepEqual(withdrawn.message.messages, []);
  assert.equal(tools.getMessage({conversation: B, message_id: '2'}).status, 'found');
  assert.equal(tools.getMessage({conversation: B, message_id: '2'}).message.messages[1].file_id, 'same.png');
  const changed = tools.searchHistory({conversation: A, cursor: token});
  assert.equal(changed.status, 'cursor_record_changed'); assert.equal(changed.reason, 'withdrawn');
});
test('SQLite E2E retained row eviction truthfully invalidates old page boundary', t => {
  const {store, tools} = realMemory(t, {maxRows: 3});
  for (let n = 1; n <= 3; n++) store.ingest(rawMessage(A, String(n), {time: 100 + n}));
  const token = tools.readHistory({conversation: A, limit: 1}).next_before;
  for (let n = 4; n <= 6; n++) store.ingest(rawMessage(A, String(n), {time: 100 + n}));
  const result = tools.readHistory({conversation: A, cursor: token});
  assert.equal(result.status, 'cursor_outside_retention'); assert.equal(result.reason, 'pruned_or_missing');
  assert.equal(result.retention.has_pruned_records, true); assert.equal(result.retention.gap_detected, true);
  assert.deepEqual(ids(tools.readHistory({conversation: A})), ['4', '5', '6']);
});
test('SQLite E2E TTL expiry cannot restore history or quote contents', t => {
  let now = 1000000;
  const {store, tools} = realMemory(t, {clock: () => now, ttlMs: 1000});
  for (let n = 1; n <= 3; n++) store.ingest(rawMessage(A, String(n), {time: 100 + n}));
  const token = tools.readHistory({conversation: A, limit: 1}).next_before;
  now += 1001;
  assert.equal(tools.getMessage({conversation: A, message_id: '1'}).status, 'not_found_or_outside_retention');
  const result = tools.readHistory({conversation: A, cursor: token});
  assert.equal(result.status, 'cursor_outside_retention'); assert.deepEqual(result.messages, []);
  now -= 1001;
  assert.equal(tools.readHistory({conversation: A}).status, 'empty');
});
test('SQLite E2E durable HMAC history page survives close/reopen', t => {
  const {database, cleanup} = safeTemp(), policy = mockPolicy();
  let store = new ScopedEventStore(database, {policy, clock: () => 1000000});
  t.after(() => { try { store.close(); } catch {} cleanup(); });
  for (let n = 1; n <= 7; n++) store.ingest(rawMessage(A, String(n), {time: 100 + n}));
  const first = createScopedHistoryTools(store).readHistory({conversation: A, limit: 2});
  const stream = store.streamId; store.close();
  store = new ScopedEventStore(database, {policy, clock: () => 1001000});
  assert.equal(store.streamId, stream);
  const page = createScopedHistoryTools(store).readHistory({conversation: A, cursor: first.next_before});
  assert.deepEqual(ids(page), ['4', '5']); assert.equal(page.snapshot.as_of, 1000000);
  assert.equal(store.decodeCursor(A, page.messages[0].cursor), 4);
});
test('SQLite E2E reopen with revoked groups erases retained data and rotates persistent epoch', t => {
  const {database, cleanup} = safeTemp();
  let store = new ScopedEventStore(database, {policy: mockPolicy(), clock: () => 1000000});
  t.after(() => { try { store.close(); } catch {} cleanup(); });
  for (let n = 1; n <= 3; n++) store.ingest(rawMessage(A, String(n), {time: 100 + n}));
  const token = createScopedHistoryTools(store).readHistory({conversation: A, limit: 1}).next_before;
  const epoch = store.scopeEpoch(A); store.close();
  store = new ScopedEventStore(database, {clock: () => 1000000});
  expectFailure(() => createScopedHistoryTools(store).getMessage({conversation: A, message_id: '3'}), 'conversation_forbidden', 403);
  store.close(); store = new ScopedEventStore(database, {policy: mockPolicy(), clock: () => 1000000});
  assert.notEqual(store.scopeEpoch(A), epoch); assert.equal(createScopedHistoryTools(store).readHistory({conversation: A}).status, 'empty');
  for (let n = 1; n <= 3; n++) store.ingest(rawMessage(A, String(n), {time: 100 + n}));
  expectFailure(() => createScopedHistoryTools(store).readHistory({conversation: A, cursor: token}), 'cursor_scope_mismatch');
});
test('SQLite E2E default empty group policy rejects even synthetic group ingest', t => {
  const {store, tools} = realMemory(t, {policy: createScopedConversationPolicy()});
  expectFailure(() => store.ingest(rawMessage(A, '1')), 'conversation_forbidden', 403);
  expectFailure(() => tools.readHistory({conversation: A}), 'conversation_forbidden', 403);
  store.ingest(rawMessage(P, '1', {sender: TARGET}));
  assert.deepEqual(ids(tools.readHistory({conversation: P})), ['1']);
});
