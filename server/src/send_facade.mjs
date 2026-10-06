import {SendLedger, ReliableSender} from './reliable_send.mjs';
import {ConversationTools} from './conversation_tools.mjs';

// Integration-facing local facade. No disk opens, timers, ports, network calls
// or permission changes on import/construction. Only Engine.send may send.
export function createConversationFacade({engine, store, lookup, timeoutMs = 10000, imageEnabled = false, replyEnabled = false, mediaReader}) {
  if (typeof engine?.send !== 'function') throw new TypeError('existing Engine required');
  const ledger = lookup ? null : new SendLedger(store);
  const resultLookup = lookup ?? ((requestId, expectedHash) => ledger.result(requestId, expectedHash));
  const sender = new ReliableSender({send: value => engine.send(value), lookup: resultLookup}, {timeoutMs});
  const tools = new ConversationTools({sender, imageEnabled, replyEnabled, mediaReader});
  return Object.freeze({
    getChatInfo: value => tools.get_chat_info(value),
    sendMessage: value => tools.send_message(value),
    getSendResult: value => tools.get_send_result(value),
    viewMedia: value => tools.view_media(value),
  });
}
