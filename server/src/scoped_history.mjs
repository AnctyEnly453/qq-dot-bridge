import crypto from 'node:crypto';
import {EventFailure, snapshot as copyInput, requireConversation, validMessageId, validAccountId, validFileId} from './scoped_policy.mjs';

// Retained records only. The host owns authentication, collection and media fetching.
export const SCOPED_HISTORY_LIMITS = Object.freeze({page: 20, maxPage: 50, maxRows: 10000,
  maxPayloadBytes: 32768, maxCursorBytes: 4096, maxContext: 20, maxDepth: 16,
  maxResultBytes: 380 * 1024});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const sameChat = (a, b) => a?.type === b?.type && a?.id === b?.id;
const exact = (value, keys) => object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const order = (a, b) => a.time - b.time || (a.native_order ?? a.seq) - (b.native_order ?? b.seq);
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const membership = rows => hash(rows.map(row => [row.seq, row.time, row.message_id]));
const fold = text => text.normalize('NFKC').toLowerCase();
const clone = value => JSON.parse(JSON.stringify(value));
const stringKey = value => typeof value === 'string' && value.length >= 1 && value.length <= 128;

export class ScopedHistoryTools {
  constructor(store, {policy = store?.policy, errorFactory = (status, code) => new EventFailure(status, code),
    maxRows = SCOPED_HISTORY_LIMITS.maxRows, maxPayloadBytes = SCOPED_HISTORY_LIMITS.maxPayloadBytes,
    maxResultBytes = SCOPED_HISTORY_LIMITS.maxResultBytes} = {}) {
    if (!store || !['historySnapshot', 'authorize', 'cursor', 'signToken', 'verifyToken'].every(key => typeof store[key] === 'function') ||
        typeof policy?.authorize !== 'function' || typeof errorFactory !== 'function' ||
        !integer(maxRows, 1, SCOPED_HISTORY_LIMITS.maxRows) || !integer(maxPayloadBytes, 256, SCOPED_HISTORY_LIMITS.maxPayloadBytes) ||
        !integer(maxResultBytes, 512, SCOPED_HISTORY_LIMITS.maxResultBytes)) throw new TypeError('invalid scoped history options');
    Object.assign(this, {store, policy, errorFactory, maxRows, maxPayloadBytes, maxResultBytes});
  }
  fail(code = 'invalid_request', status = 400) { throw this.errorFactory(status, code); }
  translate(error, fallback = 'history_unavailable') {
    if (integer(error?.status, 400, 599) && typeof error?.code === 'string') this.fail(error.code, error.status);
    this.fail(fallback, 503);
  }
  authorize(chat) {
    try {
      const canonical = requireConversation(this.policy, chat, 'read_info');
      const stored = this.store.authorize(canonical);
      if (!sameChat(stored, canonical)) this.fail('conversation_forbidden', 403);
      return canonical;
    } catch (error) {
      // Let the store observe a revocation and rotate its persistent scope epoch.
      try { this.store.authorize(chat); } catch {}
      this.translate(error);
    }
  }
  input(input, allowed) {
    let value;
    try { value = copyInput(input); } catch (error) { this.translate(error, 'invalid_request'); }
    if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) this.fail();
    return {value, chat: this.authorize(value.conversation)};
  }
  finish(value, chat) {
    this.authorize(chat);
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > this.maxResultBytes) this.fail('history_response_too_large', 413);
    return value;
  }
  normalize(row, chat) {
    if (!object(row) || !integer(row.seq, 1) || !integer(row.expires)) this.fail('history_corrupt', 503);
    const {seq: ignoredSeq, expires: ignoredExpires, ...flatPayload} = row;
    let value = row.payload ?? flatPayload;
    if (typeof value === 'string') {
      if (Buffer.byteLength(value) > this.maxPayloadBytes) this.fail('history_capacity_exceeded', 503);
      try { value = JSON.parse(value); } catch { this.fail('history_corrupt', 503); }
    }
    if (!object(value) || !sameChat(value.conversation, chat)) this.fail('history_corrupt', 503);
    if (Buffer.byteLength(JSON.stringify(value)) > this.maxPayloadBytes) this.fail('history_capacity_exceeded', 503);
    if (value.event_type !== undefined && value.event_type !== 'message') return null;
    const state = value.state ?? 'available';
    if (!validMessageId(value.message_id) || !validAccountId(value.user_id) ||
        !integer(value.time, 0, Math.floor(Number.MAX_SAFE_INTEGER / 1000)) ||
        !['available', 'withdrawn', 'missing'].includes(state) || !['incoming', 'outgoing', 'unknown'].includes(value.direction) ||
        (value.messages !== undefined && (!Array.isArray(value.messages) || value.messages.length > 32)) ||
        (state === 'available' && !Array.isArray(value.messages))) this.fail('history_corrupt', 503);
    const messages = [], replies = new Set();
    let contentComplete = state === 'available' && !(value.omitted_segments > 0);
    if (value.reply_to !== undefined && value.reply_to !== null) {
      if (!validMessageId(value.reply_to)) this.fail('history_corrupt', 503);
      replies.add(value.reply_to);
    }
    for (const part of value.messages ?? []) {
      if (!object(part)) this.fail('history_corrupt', 503);
      if (part.type === 'reply') {
        if (!validMessageId(part.id)) this.fail('history_corrupt', 503);
        replies.add(part.id);
        if (state === 'available') messages.push({type: 'reply', id: part.id});
      } else if (state !== 'available') continue;
      else if (part.type === 'text') {
        if (typeof part.text !== 'string' || part.text.includes('\0')) this.fail('history_corrupt', 503);
        messages.push({type: 'text', text: part.text});
      } else if (part.type === 'at') {
        if (!validAccountId(part.user_id) && part.user_id !== 'all') this.fail('history_corrupt', 503);
        messages.push({type: 'at', user_id: part.user_id});
      } else if (part.type === 'face') {
        if (!integer(part.id, 0, 500)) this.fail('history_corrupt', 503);
        messages.push({type: 'face', id: part.id});
      } else if (part.type === 'image') {
        const image = {type: 'image'};
        if (part.file_id !== undefined) {
          if (!validFileId(part.file_id)) this.fail('history_corrupt', 503);
          image.file_id = part.file_id;
        }
        if (part.size_bytes !== undefined) {
          if (!integer(part.size_bytes, 0, 2147483647)) this.fail('history_corrupt', 503);
          image.size_bytes = part.size_bytes;
        }
        messages.push(image);
      } else contentComplete = false;
    }
    const reference = replies.size > 1 ? {status: 'ambiguous', message_id: null} : replies.size === 1
      ? {status: 'known', message_id: [...replies][0]} : value.references_complete === true
        ? {status: 'known', message_id: null} : {status: 'metadata_unavailable', message_id: null};
    const normalized = {seq: row.seq, expires: row.expires, conversation: {...chat}, user_id: value.user_id,
      message_id: value.message_id, time: value.time, direction: value.direction, state, messages,
      content_complete: contentComplete, references_complete: value.references_complete === true, reference};
    if(integer(row.native_order,1))normalized.native_order=row.native_order;
    if (integer(value.received_at)) normalized.received_at = value.received_at;
    if (integer(value.omitted_segments)) normalized.omitted_segments = value.omitted_segments;
    return normalized;
  }
  snapshot(chat) {
    let source;
    try { source = this.store.historySnapshot(chat, {maxRows: this.maxRows, maxPayloadBytes: this.maxPayloadBytes}); }
    catch (error) { this.translate(error); }
    if (!object(source) || !integer(source.now) || !integer(source.high) || !integer(source.floor, 0, source.high) ||
        !Array.isArray(source.records) || !stringKey(source.stream_id ?? this.store.streamId) || !stringKey(source.scope_epoch)) this.fail('history_corrupt', 503);
    if (source.records.length > this.maxRows) this.fail('history_capacity_exceeded', 503);
    const rows = source.records.map(row => this.normalize(row, chat)).filter(Boolean).sort(order);
    const byId = new Map(), sequences = new Set();
    for (const row of rows) {
      if (row.seq > source.high || sequences.has(row.seq)) this.fail('history_corrupt', 503);
      sequences.add(row.seq);
      const list = byId.get(row.message_id) ?? [];
      list.push(row); byId.set(row.message_id, list);
    }
    const directions = new Set(rows.map(row => row.direction));
    return {...source, records: rows, byId, stream_id: source.stream_id ?? this.store.streamId,
      coverage: {...clone(source.coverage ?? {}), source: source.coverage?.source ?? 'scoped_retained_events', upstream_complete: false,
        directions: directions.has('unknown') ? 'partially_known' : directions.has('outgoing')
          ? directions.has('incoming') ? 'incoming_and_outgoing' : 'outgoing_only' : directions.has('incoming') ? 'incoming_only' : 'none'}};
  }
  message(chat, row) {
    const {seq, expires, ...value} = row;
    return {cursor: this.store.cursor(chat, seq), ...clone(value)};
  }
  lookup(source, id) {
    const rows = source.byId.get(id);
    if (!rows?.length) return {status: 'not_found_or_outside_retention', row: null};
    if (rows.length > 1) return {status: 'ambiguous', row: null};
    if (rows[0].expires <= source.now) return {status: 'expired', row: null};
    return {status: rows[0].state === 'available' ? 'found' : rows[0].state, row: rows[0]};
  }
  query(tool, value, previous = null) {
    const defaults = tool === 'read_history' ? {limit: SCOPED_HISTORY_LIMITS.page} : {
      keyword: null, sender_id: null, time_from: null, time_to: null, has_image: null,
      limit: SCOPED_HISTORY_LIMITS.page, context_before: 0, context_after: 0};
    const query = {};
    for (const key of Object.keys(defaults)) query[key] = Object.hasOwn(value, key) ? value[key] : previous ? previous[key] : defaults[key];
    if (!integer(query.limit, 1, SCOPED_HISTORY_LIMITS.maxPage)) this.fail();
    if (tool === 'search_history') {
      if (query.keyword !== null && (typeof query.keyword !== 'string' || !query.keyword.length || [...query.keyword].length > 200 || query.keyword.includes('\0'))) this.fail();
      if (query.sender_id !== null && !validAccountId(query.sender_id)) this.fail();
      for (const key of ['time_from', 'time_to']) if (query[key] !== null && !integer(query[key], 0, Math.floor(Number.MAX_SAFE_INTEGER / 1000))) this.fail();
      if (query.time_from !== null && query.time_to !== null && query.time_from > query.time_to) this.fail();
      if (query.has_image !== null && typeof query.has_image !== 'boolean') this.fail();
      for (const key of ['context_before', 'context_after']) if (!integer(query[key], 0, SCOPED_HISTORY_LIMITS.maxContext)) this.fail();
    }
    if (previous && JSON.stringify(query) !== JSON.stringify(previous)) this.fail('cursor_query_mismatch');
    return query;
  }
  decode(chat, token, tool) {
    if (typeof token !== 'string' || token.length > SCOPED_HISTORY_LIMITS.maxCursorBytes || !token.startsWith('h2.')) this.fail('invalid_cursor');
    let value;
    try { value = this.store.verifyToken('h2', token); } catch { this.fail('invalid_cursor'); }
    if (!exact(value, ['v', 'tool', 'conversation', 'stream_id', 'scope_epoch', 'snapshot', 'position', 'direction', 'query']) || value.v !== 2 ||
        !exact(value.conversation, ['type', 'id']) || !stringKey(value.stream_id) || !stringKey(value.scope_epoch) || !['before', 'after'].includes(value.direction) ||
        !exact(value.snapshot, ['high', 'as_of', 'digest']) || !integer(value.snapshot.high) || !integer(value.snapshot.as_of) ||
        typeof value.snapshot.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.snapshot.digest) ||
        !exact(value.position, ['seq', 'time', 'message_id']) || !integer(value.position.seq, 1, value.snapshot.high) ||
        !integer(value.position.time, 0, Math.floor(Number.MAX_SAFE_INTEGER / 1000)) || !validMessageId(value.position.message_id)) this.fail('invalid_cursor');
    if (!sameChat(value.conversation, chat)) this.fail('cursor_conversation_mismatch', 403);
    if (value.tool !== tool) this.fail('cursor_query_mismatch');
    const fields = tool === 'read_history' ? ['limit'] : ['keyword', 'sender_id', 'time_from', 'time_to', 'has_image', 'limit', 'context_before', 'context_after'];
    if (!exact(value.query, fields)) this.fail('invalid_cursor');
    value.query = this.query(tool, value.query);
    return value;
  }
  encode(chat, tool, direction, row, query, session, source) {
    return this.store.signToken('h2', {v: 2, tool, conversation: {...chat}, stream_id: source.stream_id, scope_epoch: source.scope_epoch,
      snapshot: session, position: {seq: row.seq, time: row.time, message_id: row.message_id}, direction, query});
  }
  retention(chat, source, live, session, continuation) {
    const marker = row => ({message_id: row.message_id, time: row.time, cursor: this.store.cursor(chat, row.seq)});
    return {floor_cursor: this.store.cursor(chat, source.floor), has_pruned_records: source.floor > 0,
      expired_records: source.records.filter(row => row.seq <= session.high && row.expires <= source.now).length,
      gap_detected: Boolean(continuation && membership(live) !== session.digest),
      earliest: live.length ? marker(live[0]) : null, latest: live.length ? marker(live.at(-1)) : null};
  }
  context(chat, row, live, before, after, session, source) {
    const index = live.findIndex(candidate => candidate.seq === row.seq);
    const earlier = live.slice(Math.max(0, index - before), index), later = live.slice(index + 1, index + 1 + after);
    const first = earlier[0] ?? row, last = later.at(-1) ?? row;
    return {before: earlier.map(item => this.message(chat, item)), after: later.map(item => this.message(chat, item)),
      before_cursor: live.some(item => order(item, first) < 0) ? this.encode(chat, 'read_history', 'before', first, {limit: SCOPED_HISTORY_LIMITS.page}, session, source) : null,
      after_cursor: live.some(item => order(item, last) > 0) ? this.encode(chat, 'read_history', 'after', last, {limit: SCOPED_HISTORY_LIMITS.page}, session, source) : null};
  }
  matches(row, query) {
    if (row.state !== 'available' || (query.sender_id !== null && row.user_id !== query.sender_id) ||
        (query.time_from !== null && row.time < query.time_from) || (query.time_to !== null && row.time > query.time_to) ||
        (query.has_image !== null && row.messages.some(part => part.type === 'image') !== query.has_image)) return false;
    return query.keyword === null || fold(row.messages.filter(part => part.type === 'text').map(part => part.text).join('')).includes(fold(query.keyword));
  }
  page(chat, tool, input) {
    const continuation = input.cursor !== undefined && input.cursor !== null;
    const cursor = continuation ? this.decode(chat, input.cursor, tool) : null;
    const query = this.query(tool, input, cursor?.query);
    const direction = input.direction ?? cursor?.direction ?? (tool === 'read_history' ? 'before' : 'after');
    if (!['before', 'after', ...(tool === 'read_history' ? ['around'] : [])].includes(direction)) this.fail();
    if (cursor && direction !== cursor.direction) this.fail('cursor_query_mismatch');
    const anchorId = input.anchor_id ?? null;
    if (anchorId !== null && !validMessageId(anchorId)) this.fail();
    if ((cursor && anchorId !== null) || (direction === 'around' && anchorId === null)) this.fail();
    const source = this.snapshot(chat);
    if (cursor && (cursor.stream_id !== source.stream_id || cursor.scope_epoch !== source.scope_epoch)) this.fail('cursor_scope_mismatch');
    if (cursor) source.now = Math.max(source.now, cursor.snapshot.as_of);
    const high = cursor?.snapshot.high ?? source.high;
    const live = source.records.filter(row => row.seq <= high && row.expires > source.now);
    const session = cursor?.snapshot ?? {high, as_of: source.now, digest: membership(live)};
    const result = {status: 'empty', messages: [], next_before: null, next_after: null,
      snapshot: {high_cursor: this.store.cursor(chat, Math.min(high, source.high)), as_of: session.as_of, scope_epoch: source.scope_epoch},
      retention: this.retention(chat, source, live, session, continuation), coverage: source.coverage};
    let boundary = null;
    if (cursor) {
      const found = this.lookup(source, cursor.position.message_id);
      if (high > source.high || !found.row) return {...result, status: 'cursor_outside_retention',
        reason: high > source.high ? 'dataset_reset' : found.status === 'expired' ? 'expired' : found.status === 'ambiguous' ? 'ambiguous' : 'pruned_or_missing'};
      if (found.row.seq !== cursor.position.seq || found.row.time !== cursor.position.time) this.fail('invalid_cursor');
      if (tool === 'search_history' && !this.matches(found.row, query)) return {...result, status: 'cursor_record_changed', reason: found.row.state === 'available' ? 'no_longer_matches' : found.row.state};
      boundary = found.row;
    } else if (anchorId !== null) {
      const found = this.lookup(source, anchorId);
      result.anchor = {message_id: anchorId, status: found.status};
      if (!found.row) return {...result, status: found.status === 'expired' ? 'anchor_expired' : found.status === 'ambiguous' ? 'anchor_ambiguous' : 'anchor_not_found'};
      boundary = found.row;
    }
    const eligible = tool === 'read_history' ? live : live.filter(row => this.matches(row, query));
    let selected;
    if (direction === 'around') {
      const center = eligible.findIndex(row => row.seq === boundary.seq);
      let start = Math.max(0, center - Math.floor((query.limit - 1) / 2));
      start = Math.max(0, Math.min(start, eligible.length - query.limit));
      selected = eligible.slice(start, start + query.limit);
    } else {
      const candidates = boundary ? eligible.filter(row => direction === 'before' ? order(row, boundary) < 0 : order(row, boundary) > 0) : eligible;
      selected = direction === 'before' ? candidates.slice(-query.limit) : candidates.slice(0, query.limit);
    }
    const first = selected[0] ?? boundary, last = selected.at(-1) ?? boundary;
    if (first && eligible.some(row => order(row, first) < 0)) result.next_before = this.encode(chat, tool, 'before', first, query, session, source);
    if (last && eligible.some(row => order(row, last) > 0)) result.next_after = this.encode(chat, tool, 'after', last, query, session, source);
    result.status = selected.length ? 'ok' : 'empty';
    result.messages = selected.map(row => {
      const message = this.message(chat, row);
      if (tool === 'search_history') {
        message.context_anchor = {conversation: {...chat}, message_id: row.message_id};
        if (query.context_before || query.context_after) message.context = this.context(chat, row, live, query.context_before, query.context_after, session, source);
      }
      return message;
    });
    return result;
  }
  readHistory(input) {
    const {value, chat} = this.input(input, ['conversation', 'before', 'after', 'around', 'limit', 'cursor']);
    const pivots = ['before', 'after', 'around'].filter(key => Object.hasOwn(value, key));
    if (pivots.length > 1) this.fail();
    const request = {};
    for (const key of ['limit', 'cursor']) if (Object.hasOwn(value, key)) request[key] = value[key];
    if (pivots.length) {
      if (!validMessageId(value[pivots[0]])) this.fail();
      Object.assign(request, {direction: pivots[0], anchor_id: value[pivots[0]]});
    }
    const result = this.page(chat, 'read_history', request);
    return this.finish({...result, has_more_before: result.next_before !== null, has_more_after: result.next_after !== null}, chat);
  }
  searchHistory(input) {
    const {value, chat} = this.input(input, ['conversation', 'query', 'limit', 'cursor', 'direction']);
    const request = {};
    for (const key of ['limit', 'cursor', 'direction']) if (Object.hasOwn(value, key)) request[key] = value[key];
    if (Object.hasOwn(value, 'query')) {
      if (typeof value.query === 'string') request.keyword = value.query;
      else {
        const fields = ['keyword', 'sender_id', 'time_from', 'time_to', 'has_image', 'context_before', 'context_after'];
        if (!object(value.query) || Object.keys(value.query).some(key => !fields.includes(key))) this.fail();
        Object.assign(request, value.query);
      }
    }
    const result = this.page(chat, 'search_history', request);
    const direction = value.direction ?? (value.cursor ? this.decode(chat, value.cursor, 'search_history').direction : 'after');
    const next = direction === 'before' ? result.next_before : result.next_after;
    return this.finish({...result, next_cursor: next, has_more: next !== null}, chat);
  }
  referenceChain(chat, original, source, maxDepth) {
    const nodes = [], seen = new Set([original.message_id]);
    let parent = original;
    if (parent.state !== 'available') return {status: parent.state, nodes};
    while (true) {
      if (parent.reference.status !== 'known') return {status: parent.reference.status, nodes};
      const next = parent.reference.message_id;
      if (next === null) return {status: 'complete', nodes};
      if (seen.has(next)) return {status: 'cycle', nodes, next_message_id: next};
      if (nodes.length >= maxDepth) return {status: 'depth_limit', nodes, next_message_id: next};
      const found = this.lookup(source, next);
      const node = {depth: nodes.length + 1, from_message_id: parent.message_id, message_id: next, status: found.status};
      if (found.row) node.message = this.message(chat, found.row);
      nodes.push(node);
      if (found.status !== 'found') return {status: found.status, nodes};
      seen.add(next); parent = found.row;
    }
  }
  getMessage(input) {
    const {value, chat} = this.input(input, ['conversation', 'message_id', 'max_depth', 'context_before', 'context_after']);
    const depth = value.max_depth ?? 8, before = value.context_before ?? 0, after = value.context_after ?? 0;
    if (!validMessageId(value.message_id) || !integer(depth, 1, SCOPED_HISTORY_LIMITS.maxDepth) ||
        !integer(before, 0, SCOPED_HISTORY_LIMITS.maxContext) || !integer(after, 0, SCOPED_HISTORY_LIMITS.maxContext)) this.fail();
    const source = this.snapshot(chat), found = this.lookup(source, value.message_id);
    const live = source.records.filter(row => row.expires > source.now);
    const session = {high: source.high, as_of: source.now, digest: membership(live)};
    const result = {status: found.status, message: found.row ? this.message(chat, found.row) : null,
      reference_chain: found.row ? this.referenceChain(chat, found.row, source, depth) : null,
      retention: this.retention(chat, source, live, session, false), coverage: source.coverage};
    if (found.row && (before || after)) result.context = this.context(chat, found.row, live, before, after, session, source);
    return this.finish(result, chat);
  }
  read_history(input) { return this.readHistory(input); }
  search_history(input) { return this.searchHistory(input); }
  get_message(input) { return this.getMessage(input); }
}

export function createScopedHistoryTools(store, options = {}) {
  const tools = new ScopedHistoryTools(store, options);
  return Object.freeze(Object.fromEntries(['readHistory', 'searchHistory', 'getMessage',
    'read_history', 'search_history', 'get_message'].map(name => [name, tools[name].bind(tools)])));
}
