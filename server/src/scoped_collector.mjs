import crypto from 'node:crypto';
import {EventFailure, snapshot, requireConversation, validAccountId} from './scoped_policy.mjs';
import {normalizeHistory} from './scoped_events.mjs';

export const SCOPED_SOURCE_SCHEMA = 'qq-scoped-source-v1';
export const SCOPED_SOURCE_LIMIT = 20;
export const SCOPED_SOURCE_MAX_BYTES = 380 * 1024;
const SOURCE_LEASE = 'source_lease';
const chatKey = chat => `${chat.type}:${chat.id}`;
const int = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const unavailable = () => new EventFailure(503, 'receive_unavailable');

// Construction-time, trusted callback only: no QQ action dispatch, credential lookup,
// transport selection, socket, or policy mutation is available through this source.
// A short/empty latest window never establishes complete upstream history.
export function createScopedHistorySource({readLatest} = {}) {
  if (typeof readLatest !== 'function') throw new TypeError('trusted readLatest callback required');
  return Object.freeze({
    capabilities: Object.freeze({backwardPaging: false, verified: false, latestLimit: SCOPED_SOURCE_LIMIT}),
    async readLatest({conversation, limit}) {
      if (limit !== SCOPED_SOURCE_LIMIT) throw unavailable();
      return readLatest({conversation: Object.freeze({...conversation}), limit: SCOPED_SOURCE_LIMIT});
    },
  });
}

export class ScopedEventCollector {
  constructor(store, source = null, {selfId = null, sourceLeaseMs = 30000,
    maxPagesPerCollect = 1, maxPageBytes = SCOPED_SOURCE_MAX_BYTES} = {}) {
    if (!store || !['now', 'authorize', 'ingest', 'ingestNormalized', 'reportGap', 'sourceState',
      'setSourceState', 'getMeta', 'setMeta', 'tx', 'page', 'pollEvents'].every(key => typeof store[key] === 'function') ||
      (source !== null && typeof source?.readLatest !== 'function') ||
      !int(sourceLeaseMs, 1000, 3600000) || maxPagesPerCollect !== 1 ||
      !int(maxPageBytes, 1024, SCOPED_SOURCE_MAX_BYTES) ||
      (selfId !== null && !validAccountId(selfId))) throw new TypeError('invalid scoped collector options');
    if (source?.capabilities?.backwardPaging === true) throw new TypeError('scoped upstream pagination is not verified');
    this.store = store;
    this.readLatest = source === null ? null : source.readLatest.bind(source);
    this.selfId = selfId;
    this.leaseMs = sourceLeaseMs;
    this.maxBytes = maxPageBytes;
    this.pending = new Map();
    this.resumeChecked = new Set();
  }

  authorize(input) {
    try {
      const chat = requireConversation(this.store.policy, input, 'read_info');
      this.store.authorize(chat);
      return chat;
    } catch (error) {
      // Let the store record revocation/rotate a known scope epoch without
      // returning any stored data, matching the history facade's authorization.
      try { this.store.authorize(input); } catch {}
      throw error;
    }
  }

  defaultState() {
    return {schema: SCOPED_SOURCE_SCHEMA, source: this.readLatest ? 'configured' : 'unconfigured',
      initialized: false, anchor: null, connected: null, last_success_at: null,
      coverage_start_at: null, continuity: 'unverified', disconnected_since: null,
      backward_paging_verified: false, incomplete: true, latest_limit: SCOPED_SOURCE_LIMIT,
      pages_per_collect: 1};
  }

  acquire(chat) {
    this.authorize(chat);
    return this.store.tx(() => {
      const lease = this.store.getMeta(chat, SOURCE_LEASE), now = this.store.now();
      if (lease && lease.until > now) return null;
      const token = crypto.randomUUID();
      this.store.setMeta(chat, SOURCE_LEASE, {token, until: now + this.leaseMs});
      return token;
    });
  }

  // Transactions only protect collector metadata. Store event/gap methods own their
  // transactions. Repeat authorization and lease checks before every synchronous
  // store write; never keep a transaction open across a callback await.
  assertLease(chat, token) {
    this.authorize(chat);
    return this.store.tx(() => {
      const lease = this.store.getMeta(chat, SOURCE_LEASE), now = this.store.now();
      if (!lease || lease.token !== token || lease.until <= now) throw new EventFailure(409, 'source_lease_lost');
      this.store.setMeta(chat, SOURCE_LEASE, {token, until: now + this.leaseMs});
    });
  }

  saveState(chat, token, value) {
    this.authorize(chat);
    return this.store.tx(() => {
      const lease = this.store.getMeta(chat, SOURCE_LEASE), now = this.store.now();
      if (!lease || lease.token !== token || lease.until <= now) throw new EventFailure(409, 'source_lease_lost');
      this.store.setMeta(chat, SOURCE_LEASE, {token, until: now + this.leaseMs});
      this.store.setSourceState(chat, value);
    });
  }

  gap(chat, token, code, details) {
    this.assertLease(chat, token);
    return this.store.reportGap(chat, code, details);
  }

  release(chat, token) {
    this.store.tx(() => {
      if (this.store.getMeta(chat, SOURCE_LEASE)?.token === token) this.store.setMeta(chat, SOURCE_LEASE, null);
    });
  }

  async read(chat, token) {
    this.assertLease(chat, token);
    let raw;
    try {
      raw = await this.readLatest({conversation: Object.freeze({...chat}), limit: SCOPED_SOURCE_LIMIT});
    } catch {
      // Callback failures contain no provider secrets in the public error.
      this.authorize(chat);
      this.assertLease(chat, token);
      throw unavailable();
    }
    // Revocation or takeover while awaiting prevents even normalization/disclosure.
    this.authorize(chat);
    this.assertLease(chat, token);
    try {
      raw = snapshot(raw, {maxBytes: this.maxBytes, maxArray: 100, maxNodes: 6000, maxDepth: 12});
      if (!Array.isArray(raw) || raw.length > SCOPED_SOURCE_LIMIT) throw unavailable();
      const now = this.store.now();
      const rows = raw.map(record => {
        const normalized = normalizeHistory(record, chat, now, {selfId: this.selfId});
        if (!normalized || typeof normalized.identity !== 'string' || normalized.identity.length > 200 ||
          typeof normalized.rejected !== 'boolean') throw unavailable();
        return {...normalized, orderTime: record.time, orderId: String(record.message_id)};
      });
      if (new Set(rows.map(row => row.identity)).size !== rows.length) throw unavailable();
      // Callback order is unverified. Present events deterministically oldest-first
      // after choosing a timestamp/message-id head; no claim of server ordering.
      rows.sort((a, b) => b.orderTime - a.orderTime ||
        (BigInt(a.orderId) < BigInt(b.orderId) ? 1 : BigInt(a.orderId) > BigInt(b.orderId) ? -1 : 0));
      if (Buffer.byteLength(JSON.stringify(rows)) > this.maxBytes) throw unavailable();
      return rows;
    } catch { throw unavailable(); }
  }

  ingest(raw, {conversation, transport = 'mock-event', selfId = this.selfId} = {}) {
    if (!['mock-event', 'napcat-event'].includes(transport) ||
        (selfId !== null && selfId !== undefined && !validAccountId(selfId))) throw new EventFailure(400, 'invalid_event');
    const chat = conversation === undefined ? undefined : this.authorize(conversation);
    const value = snapshot(raw, {maxBytes: this.maxBytes, maxArray: 100, maxNodes: 6000, maxDepth: 12});
    // Store normalization obtains conversation from trusted event fields when no
    // explicit scope is supplied. @/reply/text never grant conversation authority.
    return this.store.ingest(value, {conversation: chat, transport, selfId});
  }

  collect(input) {
    // Authorization occurs even if another collection for this scope is pending.
    let chat;
    try { chat = this.authorize(input); } catch (error) { return Promise.reject(error); }
    const key = chatKey(chat);
    if (this.pending.has(key)) return this.pending.get(key);
    const work = this.run(chat).finally(() => { if (this.pending.get(key) === work) this.pending.delete(key); });
    this.pending.set(key, work);
    return work;
  }

  async run(chat) {
    const token = this.acquire(chat);
    if (!token) return {has_more_source: true, busy: true, source_status: this.store.sourceState(chat) ?? this.defaultState()};
    try {
      if (this.readLatest === null) {
        const state = {...(this.store.sourceState(chat) ?? this.defaultState()),
          source: 'unconfigured', connected: null, continuity: 'unconfigured',
          backward_paging_verified: false, incomplete: true};
        this.saveState(chat, token, state);
        return {has_more_source: false, busy: false, source_status: state};
      }
      let state = this.store.sourceState(chat) ?? this.defaultState();
      const key = chatKey(chat);
      if (!this.resumeChecked.has(key)) {
        if (state.last_success_at !== null && this.store.now() > state.last_success_at) {
          this.gap(chat, token, 'process_resume_interval', {incident: `${state.last_success_at}:${this.store.now()}`,
            certainty: 'possible', since: state.last_success_at, anchor: state.anchor});
        }
        this.resumeChecked.add(key);
      }
      const rows = await this.read(chat, token);
      state = this.store.sourceState(chat) ?? this.defaultState();
      const head = rows[0]?.identity ?? null;
      const anchorIndex = state.anchor === null ? -1 : rows.findIndex(row => row.identity === state.anchor);
      // This source's ordering is unverified. Timestamp/short-ID sorting cannot
      // decide which side of an overlap anchor contains new messages: IDs can
      // decrease in the same second, and late arrivals can carry an older time.
      // Ingest the entire bounded window; the durable scoped message-ID key
      // deduplicates retained overlap. The anchor serves gap detection only.
      const records = rows;
      const overrun = state.initialized && state.anchor !== null && anchorIndex < 0;
      const uncertainEmptyBaseline = state.initialized && state.anchor === null && rows.length > 0;
      if (!state.initialized) {
        this.gap(chat, token, 'history_contract_unverified', {incident: 'bounded-latest20', certainty: 'possible'});
      } else if (overrun || uncertainEmptyBaseline) {
        this.gap(chat, token, 'latest_window_overrun', {incident: `${state.anchor ?? 'none'}:${head ?? 'none'}`,
          certainty: 'unrecoverable', since: state.last_success_at, anchor: state.anchor});
      }
      // Partial storage failure keeps the old anchor. A retry deduplicates the
      // committed prefix and retries remaining records, without losing an interval.
      for (const record of records.toReversed()) {
        if (record.value) {
          this.assertLease(chat, token);
          this.store.ingestNormalized(record.value);
        }
        if (record.rejected) this.gap(chat, token, 'record_unrepresentable', {
          incident: record.identity, certainty: 'unrecoverable', anchor: record.identity});
      }
      const now = this.store.now();
      state = {...state, schema: SCOPED_SOURCE_SCHEMA, source: 'configured', initialized: true,
        anchor: head ?? state.anchor, connected: true, last_success_at: now,
        coverage_start_at: state.coverage_start_at ?? now, disconnected_since: null,
        continuity: overrun || uncertainEmptyBaseline ? 'gap' : state.initialized ? 'window_overlap' : 'baseline_only',
        backward_paging_verified: false, incomplete: true, latest_limit: SCOPED_SOURCE_LIMIT, pages_per_collect: 1};
      this.saveState(chat, token, state);
      return {has_more_source: false, busy: false, source_status: state};
    } catch (error) {
      if (error instanceof EventFailure && error.code === 'receive_unavailable') {
        // Repeat checks here as callback failure can race with revoke/takeover.
        this.assertLease(chat, token);
        const state = this.store.sourceState(chat) ?? this.defaultState();
        if (state.connected !== false) {
          state.disconnected_since = this.store.now();
          this.gap(chat, token, 'source_disconnected', {incident: String(state.disconnected_since),
            certainty: 'possible', since: state.last_success_at, anchor: state.anchor});
        }
        state.connected = false; state.continuity = 'disconnected'; state.incomplete = true;
        this.saveState(chat, token, state);
      }
      throw error;
    } finally {
      // A denial during final metadata access must also deny direct collect(),
      // including a policy change after the last source-state commit.
      this.release(chat, token);
    }
  }

  async pollEvents(input) {
    const request = snapshot(input, {maxBytes: 2048, maxNodes: 30, maxArray: 10, maxDepth: 3});
    if (!request || Array.isArray(request) || Object.keys(request).some(key => !['conversation', 'after', 'limit'].includes(key)))
      throw new EventFailure(400, 'invalid_request');
    const chat = this.authorize(request.conversation), after = request.after === undefined ? '0' : request.after,
      limit = request.limit === undefined ? SCOPED_SOURCE_LIMIT : request.limit;
    if ((after !== null && typeof after !== 'string') || !int(limit, 1, SCOPED_SOURCE_LIMIT)) throw new EventFailure(400, 'invalid_request');
    // Foreign/future/invalid cursors are rejected before calling the source.
    if (after !== null) this.store.page(chat, after, limit);
    let collection;
    try { collection = await this.collect(chat); }
    catch (error) {
      if (!(error instanceof EventFailure) || error.code !== 'receive_unavailable' || after === null) throw error;
      collection = {has_more_source: false, busy: false};
    }
    this.authorize(chat);
    const page = this.store.pollEvents({conversation: chat, after, limit});
    const result = {...page, has_more: page.has_more || collection.has_more_source,
      has_more_source: collection.has_more_source, source_busy: collection.busy,
      source_status: this.store.sourceState(chat) ?? this.defaultState()};
    // Events and the convenience messages projection are both serialized. Count
    // the actual complete envelope, including duplicate projections and coverage.
    if (Buffer.byteLength(JSON.stringify(result)) > SCOPED_SOURCE_MAX_BYTES) throw new EventFailure(413, 'events_response_too_large');
    return result;
  }
}
