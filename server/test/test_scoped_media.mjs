import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ScopedMedia, createScopedMedia, imageMime} from '../src/scoped_media.mjs';
import {EventFailure, TARGET, createScopedConversationPolicy, requireConversation, scopeKey} from '../src/scoped_policy.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64');
const privateChat = {type: 'private', id: TARGET};
const groupA = {type: 'group', id: '10001'}, groupB = {type: 'group', id: '10002'};
const sameNumberGroup = {type: 'group', id: TARGET};
const errorIs = (status, code) => error => error.status === status && (!code || error.code === code);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };

function fixture({policy, adapter, decodeImage} = {}) {
  let now = 1000, calls = [], decodes = 0, output = png;
  const allowed = new Set([groupA.id, groupB.id, sameNumberGroup.id]);
  const rows = new Map(), chatCursor = new Map();
  policy ??= {authorize: (chat, operation) => operation === 'read_info' && (chat.type === 'private' || allowed.has(chat.id))};
  const key = (chat, cursor) => `${scopeKey(chat)}|${cursor}`;
  for (const chat of [privateChat, groupA, groupB, sameNumberGroup]) {
    const cursor = 'e1.' + Buffer.from(scopeKey(chat)).toString('base64url');
    const row = {conversation: {...chat}, cursor, message_id: '77', user_id: TARGET,
      messages: [{type: 'image', file_id: 'same.png', size_bytes: png.length}], expires: 2000};
    rows.set(key(chat, cursor), row); chatCursor.set(scopeKey(chat), cursor);
  }
  const store = {
    policy,
    authorize(chat) { return requireConversation(this.policy, chat, 'read_info'); },
    getRetainedMessage({conversation, cursor}) {
      const row = rows.get(key(conversation, cursor));
      return row && row.expires > now ? structuredClone(row) : null;
    },
  };
  const media = createScopedMedia({store, adapter: adapter ?? {async readImage(request) { calls.push(request); return output; }},
    decodeImage: decodeImage ?? (async (bytes, mime) => { decodes++; assert.ok(bytes.equals(png)); assert.equal(mime, 'image/png'); })});
  const request = chat => ({conversation: {...chat}, cursor: chatCursor.get(scopeKey(chat)), file_id: 'same.png'});
  const row = chat => rows.get(key(chat, request(chat).cursor));
  return {media, store, allowed, rows, key, request, row, calls: () => calls, decodes: () => decodes,
    recall: chat => rows.delete(key(chat, request(chat).cursor)), expire: () => { now = 2000; },
    output: bytes => { output = bytes; }};
}

test('scope-aware API and canonical output retain conversation identity without paths', async () => {
  const f = fixture(); assert.ok(f.media instanceof ScopedMedia);
  for (const chat of [privateChat, groupA, groupB, sameNumberGroup]) {
    const input = f.request(chat), output = await f.media.viewMedia(input);
    assert.deepEqual(output, {...input, message_id: '77', mime: 'image/png', data_base64: png.toString('base64')});
    const call = f.calls().at(-1);
    assert.deepEqual(call, {...input, message_id: '77'});
    assert.equal(Object.isFrozen(call), true); assert.equal(Object.isFrozen(call.conversation), true);
    assert.notEqual(output.conversation, input.conversation);
  }
  assert.equal(f.calls().length, 4); assert.equal(f.decodes(), 4);
});

test('default empty group allowlist denies before transport and decoder', async () => {
  const f = fixture({policy: createScopedConversationPolicy()});
  for (const chat of [groupA, groupB, sameNumberGroup]) await assert.rejects(f.media.read(f.request(chat)), errorIs(403, 'conversation_forbidden'));
  assert.equal(f.calls().length, 0); assert.equal(f.decodes(), 0);
  assert.equal((await f.media.read(f.request(privateChat))).conversation.type, 'private');
});

test('operation policy requires read_info and cannot be elevated by a media-only grant', async () => {
  const f = fixture({policy: {authorize: (_chat, operation) => operation === 'media'}});
  await assert.rejects(f.media.read(f.request(groupA)), errorIs(403, 'conversation_forbidden'));
  assert.equal(f.calls().length, 0);
});

test('same account number, message ID and filename never authorize foreign cursors', async () => {
  const f = fixture(), chats = [privateChat, groupA, groupB, sameNumberGroup];
  for (const chat of chats) for (const foreign of chats) if (scopeKey(chat) !== scopeKey(foreign)) {
    await assert.rejects(f.media.read({...f.request(chat), cursor: f.request(foreign).cursor}), errorIs(404, 'media_not_found'));
  }
  assert.equal(f.calls().length, 0); assert.equal(f.decodes(), 0);
});

test('legacy private decimal references remain private and cannot authorize any group', async () => {
  const f = fixture(); const row = structuredClone(f.row(privateChat));
  f.rows.set(f.key(privateChat, '1'), row);
  assert.equal((await f.media.read({...f.request(privateChat), cursor: '1'})).cursor, row.cursor);
  for (const chat of [groupA, groupB, sameNumberGroup]) await assert.rejects(f.media.read({...f.request(chat), cursor: '1'}), errorIs(400, 'invalid_cursor'));
  assert.equal(f.calls().length, 1);
});

test('arbitrary paths, URLs, request fields and noncanonical file identifiers are rejected', async () => {
  const f = fixture(), request = f.request(groupA);
  for (const file_id of ['', '.', '..', '../same.png', '..\\same.png', 'C:\\tmp\\same.png', '/tmp/same.png', 'file:///tmp/same.png', 'https://x/same.png', 'same.png?x', 'same.png#x', 'same%2epng', 'same\0png', 'a'.repeat(129), 'same.two.png']) {
    await assert.rejects(f.media.read({...request, file_id}), errorIs(400, 'invalid_media_reference'));
  }
  for (const extra of [{url: 'http://x'}, {path: '/tmp/a'}, {message_id: '77'}, {target: TARGET}, {policy: {allowedGroups: [groupA.id]}}]) {
    await assert.rejects(f.media.read({...request, ...extra}), errorIs(400, 'invalid_request'));
  }
  assert.equal(f.calls().length, 0);
});

test('accessors, custom prototypes, symbols and sparse input fail without invocation', async () => {
  const f = fixture(), request = f.request(groupA); let getters = 0;
  const accessor = {...request}; Object.defineProperty(accessor, 'file_id', {enumerable: true, get() { getters++; return 'same.png'; }});
  const custom = Object.assign(Object.create({admin: true}), request), symbol = {...request, [Symbol('authority')]: true};
  for (const input of [accessor, custom, symbol, [request], null, {...request, conversation: {...groupA, allowed: true}}]) {
    await assert.rejects(f.media.read(input), error => error.status === 400);
  }
  assert.equal(getters, 0); assert.equal(f.calls().length, 0);
});

test('missing and malformed retained provenance fails before the adapter', async () => {
  const malformed = [null, {conversation: groupB}, {cursor: 'e1.foreign'}, {message_id: 77}, {message_id: ''}, {state: 'withdrawn'}, {messages: []},
    {messages: [{type: 'image', file_id: 'other.png', size_bytes: png.length}]},
    {messages: [{type: 'image', file_id: 'same.png', size_bytes: -1}]},
    {messages: [{type: 'image', file_id: 'same.png', size_bytes: 1.5}]}];
  for (const replacement of malformed) {
    const f = fixture(), original = f.row(groupA);
    f.store.getRetainedMessage = () => replacement === null ? null : {...original, ...replacement};
    await assert.rejects(f.media.read(f.request(groupA)), errorIs(404, 'media_not_found'));
    assert.equal(f.calls().length, 0);
  }
});

test('unknown retained image size is supported and byte bounds still apply', async () => {
  const f = fixture(); delete f.row(groupA).messages[0].size_bytes;
  assert.equal((await f.media.read(f.request(groupA))).mime, 'image/png');
  f.output(Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(f.media.read(f.request(groupA)), errorIs(413, 'message_too_large'));
});

test('oversize retained metadata refuses retrieval before the adapter', async () => {
  const f = fixture(); f.row(groupA).messages[0].size_bytes = 2 * 1024 * 1024 + 1;
  await assert.rejects(f.media.read(f.request(groupA)), errorIs(413, 'message_too_large'));
  assert.equal(f.calls().length, 0);
});

for (const event of ['revocation', 'recall', 'expiry', 'replace message', 'replace image']) {
  test(`media source ${event} while transport awaits refuses bytes and skips decoder`, async () => {
    const entered = deferred(), gate = deferred(), f = fixture({adapter: {async readImage() { entered.resolve(); await gate.promise; return png; }}});
    const reading = f.media.read(f.request(groupA)); await entered.promise;
    if (event === 'revocation') f.allowed.delete(groupA.id);
    else if (event === 'recall') f.recall(groupA);
    else if (event === 'expiry') f.expire();
    else if (event === 'replace message') f.row(groupA).message_id = '78';
    else f.row(groupA).messages[0].size_bytes++;
    gate.resolve(); await assert.rejects(reading, errorIs(event === 'revocation' ? 403 : 404));
    assert.equal(f.decodes(), 0);
  });
}

for (const event of ['revocation', 'recall', 'expiry', 'replace message', 'replace image']) {
  test(`media source ${event} while decoder awaits refuses output`, async () => {
    const entered = deferred(), gate = deferred(), f = fixture({decodeImage: async () => { entered.resolve(); await gate.promise; }});
    const reading = f.media.read(f.request(groupA)); await entered.promise;
    if (event === 'revocation') f.allowed.delete(groupA.id);
    else if (event === 'recall') f.recall(groupA);
    else if (event === 'expiry') f.expire();
    else if (event === 'replace message') f.row(groupA).message_id = '78';
    else f.row(groupA).messages[0].size_bytes++;
    gate.resolve(); await assert.rejects(reading, errorIs(event === 'revocation' ? 403 : 404));
  });
}

test('failed async decoding rechecks source revocation before exposing decoder status', async () => {
  const entered = deferred(), gate = deferred(), f = fixture({decodeImage: async () => { entered.resolve(); await gate.promise; throw new EventFailure(400, 'invalid_image'); }});
  const reading = f.media.read(f.request(groupA)); await entered.promise; f.allowed.delete(groupA.id); gate.resolve();
  await assert.rejects(reading, errorIs(403, 'conversation_forbidden'));
});

test('input mutation during transport await cannot move authority to another scope', async () => {
  const entered = deferred(), gate = deferred(); let transport;
  const f = fixture({adapter: {async readImage(request) { transport = request; entered.resolve(); await gate.promise; return png; }}});
  const input = f.request(groupA), reading = f.media.read(input); await entered.promise;
  input.conversation.type = 'private'; input.conversation.id = TARGET; input.cursor = f.request(privateChat).cursor; input.file_id = 'other.png';
  gate.resolve(); const result = await reading;
  assert.deepEqual(result.conversation, groupA); assert.deepEqual(transport.conversation, groupA); assert.equal(result.file_id, 'same.png');
});

test('transport buffer mutation during decoder await cannot change output', async () => {
  const entered = deferred(), gate = deferred(), mutable = Buffer.from(png);
  const f = fixture({adapter: {async readImage() { return mutable; }}, decodeImage: async bytes => { assert.ok(bytes.equals(png)); entered.resolve(); await gate.promise; }});
  const reading = f.media.read(f.request(groupA)); await entered.promise; mutable.fill(0); gate.resolve();
  assert.equal((await reading).data_base64, png.toString('base64'));
});

test('decoder mutation of its input bytes fails closed', async () => {
  const f = fixture({decodeImage: async bytes => { bytes[8] ^= 1; }});
  await assert.rejects(f.media.read(f.request(groupA)), errorIs(400, 'invalid_image'));
});

test('absent scope-aware adapter or decoder returns media unavailable before retrieval', async () => {
  for (const missing of ['adapter', 'decoder']) {
    const f = fixture(); if (missing === 'adapter') f.media.adapter = {readImageByFilename: () => png}; else f.media.decodeImage = null;
    await assert.rejects(f.media.read(f.request(groupA)), errorIs(503, 'media_unavailable')); assert.equal(f.calls().length, 0);
  }
});

test('adapter errors never expose paths or diagnostics', async () => {
  const f = fixture({adapter: {async readImage() { throw new Error('secret C:/credentials/token.txt'); }}});
  await assert.rejects(f.media.read(f.request(groupA)), error => errorIs(503, 'media_unavailable')(error) && !error.message.includes('secret'));
});

test('image bytes require supported sniffed MIME, nonempty Buffer and strict 2 MiB bound', async () => {
  const f = fixture();
  for (const bytes of [Buffer.alloc(0), new Uint8Array(png), Buffer.from('https://x/file.svg'), Buffer.from('<svg></svg>')]) {
    f.output(bytes); await assert.rejects(f.media.read(f.request(groupA)), errorIs(400, 'invalid_image'));
  }
  f.output(Buffer.alloc(2 * 1024 * 1024 + 1)); await assert.rejects(f.media.read(f.request(groupA)), errorIs(413, 'message_too_large'));
  assert.equal(f.decodes(), 0);
});

test('trusted full decoder rejections propagate safe image and limit errors only', async () => {
  for (const [decoderError, status, code] of [[new EventFailure(400, 'invalid_image'), 400, 'invalid_image'],
    [new EventFailure(413, 'message_too_large'), 413, 'message_too_large'],
    [new Error('secret decoder details'), 503, 'media_unavailable'],
    [{status: 400, code: 'decoder_dimensions_100000x100000'}, 503, 'media_unavailable']]) {
    const f = fixture({decodeImage: async () => { throw decoderError; }});
    await assert.rejects(f.media.read(f.request(groupA)), errorIs(status, code));
  }
});

test('custom public error factory receives validation and store-policy failures', async () => {
  class PublicFailure extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
  const f = fixture(); f.media.errorFactory = (status, code) => new PublicFailure(status, code);
  await assert.rejects(f.media.read({...f.request(groupA), file_id: '../a'}), error => error instanceof PublicFailure && error.code === 'invalid_media_reference');
  f.allowed.delete(groupA.id);
  await assert.rejects(f.media.read(f.request(groupA)), error => error instanceof PublicFailure && error.code === 'conversation_forbidden');
});

test('MIME sniffing permits only PNG, JPEG, GIF and WebP containers', () => {
  assert.equal(imageMime(png), 'image/png');
  assert.equal(imageMime(Buffer.from([255,216,255,217])), 'image/jpeg');
  assert.equal(imageMime(Buffer.from('GIF89a')), 'image/gif');
  assert.equal(imageMime(Buffer.from('524946460400000057454250', 'hex')), 'image/webp');
  assert.throws(() => imageMime(Buffer.from('BM')), errorIs(400, 'invalid_image'));
});

const rawImage = (conversation, now, message_id = '77') => ({post_type: 'message', message_type: conversation.type,
  ...(conversation.type === 'group' ? {group_id: conversation.id} : {}), user_id: TARGET,
  message_id, time: Math.floor(now / 1000), message: [{type: 'image', data: {file: 'same.png'}}]});

test('real SQLite signed cursors isolate groups/private sharing identifiers and unknown image size', async () => {
  const {ScopedEventStore} = await import('../src/scoped_events.mjs');
  const now = 1770000000000, store = new ScopedEventStore(':memory:', {clock: () => now,
    policy: createScopedConversationPolicy({allowedGroups: [groupA.id, groupB.id, sameNumberGroup.id]})});
  const chats = [privateChat, groupA, groupB, sameNumberGroup], cursors = new Map(), calls = [];
  try {
    for (const chat of chats) cursors.set(scopeKey(chat), store.ingest(rawImage(chat, now)).cursor);
    const media = createScopedMedia({store, adapter: {async readImage(request) { calls.push(request); return png; }}, decodeImage: async bytes => assert.ok(bytes.equals(png))});
    for (const chat of chats) {
      const cursor = cursors.get(scopeKey(chat)), result = await media.read({conversation: chat, cursor, file_id: 'same.png'});
      assert.deepEqual(result.conversation, chat); assert.equal(result.cursor, cursor); assert.equal(result.message_id, '77');
      assert.deepEqual(calls.at(-1), {conversation: chat, cursor, message_id: '77', file_id: 'same.png'});
    }
    assert.equal(new Set(cursors.values()).size, 4); assert.equal(calls.length, 4);
    for (const chat of chats) for (const foreign of chats) if (scopeKey(chat) !== scopeKey(foreign)) {
      await assert.rejects(media.read({conversation: chat, cursor: cursors.get(scopeKey(foreign)), file_id: 'same.png'}), error => error.status === 400 || error.status === 403);
    }
    assert.equal(calls.length, 4);
  } finally { store.close(); }
});

test('real SQLite group recall revokes image provenance without affecting other groups/private', async () => {
  const {ScopedEventStore} = await import('../src/scoped_events.mjs');
  const now = 1770000000000, store = new ScopedEventStore(':memory:', {clock: () => now,
    policy: createScopedConversationPolicy({allowedGroups: [groupA.id, groupB.id]})});
  let calls = 0;
  try {
    const cursors = new Map([privateChat, groupA, groupB].map(chat => [scopeKey(chat), store.ingest(rawImage(chat, now)).cursor]));
    const media = createScopedMedia({store, adapter: {async readImage() { calls++; return png; }}, decodeImage: async () => {}});
    store.ingest({post_type: 'notice', notice_type: 'group_recall', group_id: groupA.id, user_id: TARGET, message_id: '77', time: now / 1000});
    await assert.rejects(media.read({conversation: groupA, cursor: cursors.get(scopeKey(groupA)), file_id: 'same.png'}), errorIs(404, 'media_not_found'));
    for (const conversation of [groupB, privateChat]) await media.read({conversation, cursor: cursors.get(scopeKey(conversation)), file_id: 'same.png'});
    assert.equal(calls, 2);
  } finally { store.close(); }
});

test('real SQLite authorization revocation during read prunes sources and old cursor stays dead after regrant', async () => {
  const {ScopedEventStore} = await import('../src/scoped_events.mjs');
  const now = 1770000000000, allowed = new Set([groupA.id]);
  const policy = {authorize: (chat, operation) => operation === 'read_info' && (chat.type === 'private' || allowed.has(chat.id))};
  const store = new ScopedEventStore(':memory:', {clock: () => now, policy}); let calls = 0, revoke = true;
  try {
    const cursor = store.ingest(rawImage(groupA, now)).cursor;
    const media = createScopedMedia({store, adapter: {async readImage() { calls++; if (revoke) allowed.delete(groupA.id); return png; }}, decodeImage: async () => {}});
    await assert.rejects(media.read({conversation: groupA, cursor, file_id: 'same.png'}), errorIs(403, 'conversation_forbidden'));
    allowed.add(groupA.id); revoke = false;
    await assert.rejects(media.read({conversation: groupA, cursor, file_id: 'same.png'}), errorIs(400, 'invalid_cursor'));
    const next = store.ingest(rawImage(groupA, now)).cursor;
    assert.notEqual(next, cursor); await media.read({conversation: groupA, cursor: next, file_id: 'same.png'});
    assert.equal(calls, 2);
  } finally { store.close(); }
});

test('real SQLite media reference expires while asynchronous decoder runs', async () => {
  const {ScopedEventStore} = await import('../src/scoped_events.mjs');
  let now = 1770000000000;
  const store = new ScopedEventStore(':memory:', {clock: () => now, ttlMs: 1000,
    policy: createScopedConversationPolicy({allowedGroups: [groupA.id]})});
  try {
    const cursor = store.ingest(rawImage(groupA, now)).cursor;
    const media = createScopedMedia({store, adapter: {async readImage() { return png; }}, decodeImage: async () => { now += 1000; }});
    await assert.rejects(media.read({conversation: groupA, cursor, file_id: 'same.png'}), errorIs(404, 'media_not_found'));
  } finally { store.close(); }
});

test('real SQLite restart retains media authorization and signed scope cursor', async () => {
  const {ScopedEventStore} = await import('../src/scoped_events.mjs');
  const now = 1770000000000, directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-scoped-media-')),
    database = path.join(directory, 'media.sqlite3'), policy = createScopedConversationPolicy({allowedGroups: [groupA.id, groupB.id]});
  let store;
  try {
    store = new ScopedEventStore(database, {clock: () => now, policy});
    const cursor = store.ingest(rawImage(groupA, now)).cursor, other = store.ingest(rawImage(groupB, now)).cursor;
    store.close(); store = new ScopedEventStore(database, {clock: () => now + 1, policy});
    const media = createScopedMedia({store, adapter: {async readImage(request) { assert.deepEqual(request.conversation, groupA); return png; }}, decodeImage: async () => {}});
    assert.equal((await media.read({conversation: groupA, cursor, file_id: 'same.png'})).cursor, cursor);
    await assert.rejects(media.read({conversation: groupA, cursor: other, file_id: 'same.png'}));
  } finally {
    store?.close();
    // No recursive deletion: remove only known test SQLite artifacts.
    for (const file of [database, database + '-journal']) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(directory);
  }
});

test('real SQLite explicitly migrated private decimal reference returns canonical e1 and denies group reuse', async () => {
  const {ScopedEventStore} = await import('../src/scoped_events.mjs');
  const now = 1770000000000, store = new ScopedEventStore(':memory:', {clock: () => now,
    policy: createScopedConversationPolicy({allowedGroups: [sameNumberGroup.id]})});
  let calls = 0;
  try {
    const canonical = store.ingest(rawImage(privateChat, now)).cursor;
    store.ingest(rawImage(sameNumberGroup, now));
    // Trusted local fixture reproduces the migration's private legacy_high flag.
    store.db.prepare('UPDATE sr_scopes SET legacy_high=high WHERE scope=?').run(scopeKey(privateChat));
    const media = createScopedMedia({store, adapter: {async readImage(request) {
      calls++; assert.equal(request.cursor, canonical); assert.deepEqual(request.conversation, privateChat); return png;
    }}, decodeImage: async () => {}});
    assert.equal((await media.read({conversation: privateChat, cursor: '1', file_id: 'same.png'})).cursor, canonical);
    await assert.rejects(media.read({conversation: sameNumberGroup, cursor: '1', file_id: 'same.png'}), errorIs(400, 'invalid_cursor'));
    assert.equal(calls, 1);
  } finally { store.close(); }
});
