import {ScopedEventStore} from './scoped_events.mjs';
import {ScopedEventCollector} from './scoped_collector.mjs';
import {createScopedHistoryTools} from './scoped_history.mjs';
import {createScopedMedia} from './scoped_media.mjs';
import {EventFailure, snapshot, requireConversation, validMessageId} from './scoped_policy.mjs';

export const SCOPED_READ_PATHS = Object.freeze({pollEvents: '/qq/tools/poll_events', readHistory: '/qq/tools/read_history',
  searchHistory: '/qq/tools/search_history', getMessage: '/qq/tools/get_message', viewMedia: '/qq/tools/view_media'});

// Host supplies authentication/signing outside these handlers. Construction/import
// never opens a network connection or starts a background collector.
export function createScopedReadRuntime({store, dbPath, storeOptions, collector, source = null, collectorOptions,
  media, mediaAdapter, decodeImage, sender, historyStore, errorFactory = (status, code) => new EventFailure(status, code)} = {}) {
  const ownsStore = !store;
  const queue = store ?? new ScopedEventStore(dbPath, storeOptions);
  const receive = collector ?? new ScopedEventCollector(queue, source, collectorOptions);
  const history = createScopedHistoryTools(historyStore??queue, {errorFactory});
  const images = media ?? createScopedMedia({store: historyStore??queue, adapter: mediaAdapter, decodeImage, errorFactory});
  const adapt = fn => async input => {
    try { return await fn(input); }
    catch (error) { if (Number.isInteger(error?.status) && typeof error.code === 'string') throw errorFactory(error.status, error.code); throw error; }
  };
  const bounded = result => {
    if (Buffer.byteLength(JSON.stringify(result)) > 380 * 1024) throw errorFactory(413, 'events_response_too_large');
    return result;
  };
  const facade = Object.freeze({
    pollEvents: adapt(async input => {
      const {messages, ...result} = await receive.pollEvents(input);
      return bounded(result); // Avoid duplicating message content in events and messages on the wire.
    }),
    readHistory: adapt(input => history.readHistory(input)),
    searchHistory: adapt(input => history.searchHistory(input)),
    getMessage: adapt(input => history.getMessage(input)),
    viewMedia: adapt(input => images.viewMedia(input)),
  });
  const handlers = Object.freeze(Object.fromEntries(Object.entries(SCOPED_READ_PATHS).map(([name, route]) => [route, facade[name]])));
  const confirm = sender ? createScopedReplyConfirmer({store: queue, sender, errorFactory}) : () => { throw errorFactory(503, 'reply_sender_unconfigured'); };
  return Object.freeze({store: queue, collector: receive, history, media: images, facade, handlers,
    // Internal ACK reconciliation only. Do not expose recordReply as a public route.
    confirmReply: adapt(async input => {
      const value = snapshot(input);
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
          Object.keys(value).some(key => !['conversation', 'consumer', 'event_cursor', 'token', 'request_id'].includes(key))) throw errorFactory(400, 'invalid_request');
      return confirm(value);
    }),
    close() { if (ownsStore) queue.close(); },
  });
}

// A separate internal constructor permits confirmed-send reconciliation without
// ever accepting a public caller's assertion that a reply completed.
export function createScopedReplyConfirmer({store, sender, errorFactory = (status, code) => new EventFailure(status, code)} = {}) {
  if (!store || typeof sender?.getSendResult !== 'function') throw new TypeError('trusted store and sender required');
  return async ({conversation, consumer = 'default', event_cursor, token, request_id} = {}) => {
    const chat = requireConversation(store.policy, conversation, 'read_info'); store.authorize(chat);
    const item = store.processing(chat, consumer, event_cursor);
    if (item.send_request_id !== request_id) throw errorFactory(409, 'reply_not_confirmed');
    const result = await sender.getSendResult({conversation: chat, request_id});
    store.authorize(chat);
    if (!result || result.request_id !== request_id || !['sent', 'unknown', 'not_found', 'rejected'].includes(result.state) ||
        (result.state === 'sent' ? !validMessageId(result.message_id) : result.message_id !== null)) throw errorFactory(502, 'invalid_send_result');
    if (result.state !== 'sent') return {state: 'unconfirmed', send_state: result.state};
    return store.recordReply({conversation: chat, consumer, event_cursor, token, request_id, message_id: result.message_id, status: 'completed'});
  };
}

export function createScopedReplyResolver(store) {
  if (!store || typeof store.getRetainedMessage !== 'function') throw new TypeError('trusted scoped store required');
  return input => {
    const request = snapshot(input);
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
        Object.keys(request).sort().join(',') !== 'conversation,cursor,message_id' || !validMessageId(request.message_id)) throw new EventFailure(400, 'invalid_reply');
    const chat = requireConversation(store.policy, request.conversation, 'reply'); store.authorize(chat);
    let row;
    try { row = store.getRetainedMessage({conversation: chat, cursor: request.cursor}); }
    catch (error) { if (error?.code === 'media_not_found') return null; throw error; }
    if (row.message_id !== request.message_id || row.state !== 'available') return null;
    const seq = store.decodeCursor(chat, request.cursor, {allowZero: false});
    const retained = store.historySnapshot(chat).records.find(item => item.seq === seq);
    if (!retained || retained.expires <= store.now()) return null;
    return {conversation: {...chat}, cursor: request.cursor, message_id: row.message_id, user_id: row.user_id, expires_at: retained.expires};
  };
}
