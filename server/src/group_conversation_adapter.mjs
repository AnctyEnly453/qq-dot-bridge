import {PRIVATE_TARGET, ToolFailure, snapshot, exact, validRequestId, validMessageId, validCursor, delivery, fail, boundedWait, validateTimeout} from './tool_contract.mjs';
import {validAccountId, createConversationPolicy, requireConversation} from './scoped_conversation_policy.mjs';

const publicFailure = error => {
  if (error instanceof ToolFailure) return error;
  if (error?.code === 'idempotency_conflict') return new ToolFailure(409, 'idempotency_conflict');
  if (error?.code === 'capacity_exceeded') return new ToolFailure(503, 'capacity_exceeded');
  return new ToolFailure(503, 'unavailable');
};
const cachedDelivery = (requestId, messageId) => validMessageId(messageId) ? delivery(requestId, 'sent', messageId) : delivery(requestId, 'unknown');
function providerId(value) {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return validAccountId(text) ? text : null;
}
function label(value, max = 256) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.includes('\0') || [...value].length > max) fail(502, 'invalid_profile_response');
  return value;
}
function memberProfile(value, groupId, userId) {
  if (value === null) fail(404, 'member_not_found');
  if (!value || typeof value !== 'object' || providerId(value.group_id) !== groupId || providerId(value.user_id) !== userId) fail(502, 'invalid_profile_response');
  const nickname = label(value.nickname), card = label(value.card);
  return {group_id: groupId, user_id: userId, nickname, card, display_name: card || nickname || userId,
    identity: {type: 'qq_user', user_id: userId}};
}
async function readProvider(callback, input) {
  if (typeof callback !== 'function') fail(503, 'profile_unavailable');
  try { return await callback(input); } catch { fail(503, 'profile_unavailable'); }
}
function sendShape(input, policy) {
  const value = snapshot(input); exact(value, ['conversation', 'request_id', 'messages']);
  const conversation = requireConversation(policy, value.conversation, 'send');
  if (!validRequestId(value.request_id) || !Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 8) fail(400, 'invalid_request');
  let replies = 0;
  const messages = value.messages.map((item, index) => {
    if (item?.type === 'reply') {
      exact(item, ['type', 'cursor', 'message_id']);
      if (++replies > 1 || index !== 0 || !validCursor(item.cursor) || !validMessageId(item.message_id)) fail(400, 'invalid_reply');
      return {type: 'reply', cursor: item.cursor, message_id: item.message_id};
    }
    if (item?.type === 'at') {
      exact(item, ['type', 'user_id']);
      if (!validAccountId(item.user_id)) fail(400, 'invalid_mention');
      if (conversation.type !== 'group') fail(400, 'mention_not_supported');
      return {type: 'at', user_id: item.user_id};
    }
    if (item?.type === 'text') {
      exact(item, ['type', 'text']);
      if (typeof item.text !== 'string' || !item.text.length || item.text.includes('\0')) fail(400, 'invalid_request');
      return {type: 'text', text: item.text};
    }
    if (item?.type === 'face') {
      exact(item, ['type', 'id']);
      if (!Number.isInteger(item.id) || item.id < 0 || item.id > 500) fail(400, 'invalid_request');
      return {type: 'face', id: item.id};
    }
    if (item?.type === 'image') {
      exact(item, ['type', 'mime', 'data_base64']);
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(item.mime) || typeof item.data_base64 !== 'string') fail(400, 'invalid_image');
      return {type: 'image', mime: item.mime, data_base64: item.data_base64};
    }
    fail(400, 'invalid_request');
  });
  if (messages.every(item => item.type === 'reply')) fail(400, 'invalid_request');
  return {conversation, request_id: value.request_id, messages};
}
function oneBot(messages) {
  return messages.map(item => {
    if (item.type === 'text') return {type: 'text', data: {text: item.text}};
    if (item.type === 'face') return {type: 'face', data: {id: String(item.id)}};
    if (item.type === 'image') return {type: 'image', data: {file: 'base64://' + item.data_base64}};
    if (item.type === 'at') return {type: 'at', data: {qq: item.user_id}};
    return {type: 'reply', data: {id: item.message_id}};
  });
}

// Trusted callback selecting a SINGLE fixed future action, not an API passthrough.
// Current task-2 DockerAdapter intentionally does not allow this group action.
export function createGroupActionSender(call) {
  if (typeof call !== 'function') throw new TypeError('trusted group-only action callback required');
  return payload => call('send_group_msg', payload, 16384);
}

export function createScopedQueueReplyResolver(queue, {policy = createConversationPolicy()} = {}) {
  if (typeof queue?.db?.prepare !== 'function' || typeof queue?.now !== 'function') throw new TypeError('compatible retained queue required');
  return ({conversation, cursor, message_id}) => {
    const scope = requireConversation(policy, conversation, 'reply');
    if (!validCursor(cursor) || !validMessageId(message_id)) fail(400, 'invalid_reply');
    const row = queue.db.prepare('SELECT payload,expires FROM received WHERE seq=? AND expires>?').get(Number(cursor), queue.now());
    if (!row) return null;
    let value; try { value = JSON.parse(row.payload); } catch { return null; }
    if (value.conversation?.type !== scope.type || value.conversation.id !== scope.id || value.message_id !== message_id || !validAccountId(value.user_id) || (scope.type === 'private' && value.user_id !== PRIVATE_TARGET)) return null;
    return {conversation: {...scope}, cursor, message_id, user_id: value.user_id, expires_at: row.expires};
  };
}

export function createGroupConversationAdapter({policy = createConversationPolicy(), groupScope, sendGroup, privateFacade,
  validateMessages, decodeImage, provider, resolveReply, timeoutMs = 10000, clock = Date.now} = {}) {
  if (typeof policy?.authorize !== 'function' || typeof clock !== 'function') throw new TypeError('trusted policy/clock required');
  validateTimeout(timeoutMs);
  const capabilities = conversation => {
    const allowed = operation => { try { return policy.authorize(conversation, operation) === true; } catch { return false; } };
    const isGroup = conversation.type === 'group';
    let inherited;
    if (!isGroup && typeof privateFacade?.getChatInfo === 'function') {
      try { inherited = privateFacade.getChatInfo({conversation})?.capabilities; } catch { /* no capabilities claimed */ }
    }
    const sendConfigured = isGroup ? typeof sendGroup === 'function' && !!groupScope && typeof validateMessages === 'function' : typeof privateFacade?.sendMessage === 'function';
    const canSend = allowed('send') && sendConfigured;
    return {send_message: canSend,
      send_result: allowed('read_result') && (isGroup ? typeof groupScope?.result === 'function' : typeof privateFacade?.getSendResult === 'function'),
      at: isGroup && canSend && allowed('mention') && typeof provider?.getGroupMemberInfo === 'function',
      at_all: false,
      reply: canSend && allowed('reply') && (isGroup ? typeof resolveReply === 'function' : inherited?.reply === true),
      image: canSend && (isGroup ? typeof decodeImage === 'function' : inherited?.image === true), marketplace_sticker: false};
  };

  async function getChatInfo(input) {
    const value = snapshot(input); const withMember = value && Object.hasOwn(value, 'member_id');
    exact(value, ['conversation', ...(withMember ? ['member_id'] : [])]);
    const conversation = requireConversation(policy, value.conversation, 'read_info');
    if (withMember && (conversation.type !== 'group' || !validAccountId(value.member_id))) fail(400, 'invalid_request');
    if (conversation.type === 'private') {
      const result = await readProvider(provider?.getPrivateInfo?.bind(provider), {user_id: conversation.id});
      requireConversation(policy, conversation, 'read_info');
      if (result === null) fail(404, 'profile_not_found');
      if (!result || providerId(result.user_id) !== conversation.id) fail(502, 'invalid_profile_response');
      const nickname = label(result.nickname);
      return {conversation: {...conversation}, source: 'provider', identity: {type: 'qq_user', user_id: conversation.id},
        profile: {user_id: conversation.id, nickname, display_name: nickname || conversation.id}, member: null,
        capabilities: capabilities(conversation), receive: {source: 'history_poll', latest: 20, interval_ms: 2000, complete: false, upstream_gap_detection: false}};
    }
    const result = await readProvider(provider?.getGroupInfo?.bind(provider), {group_id: conversation.id});
    requireConversation(policy, conversation, 'read_info');
    if (result === null) fail(404, 'group_not_found');
    if (!result || providerId(result.group_id) !== conversation.id) fail(502, 'invalid_profile_response');
    const group_name = label(result.group_name);
    let member = null;
    if (withMember) {
      const data = await readProvider(provider?.getGroupMemberInfo?.bind(provider), {group_id: conversation.id, user_id: value.member_id});
      requireConversation(policy, conversation, 'read_info'); member = memberProfile(data, conversation.id, value.member_id);
    }
    return {conversation: {...conversation}, source: 'provider', identity: {type: 'qq_group', group_id: conversation.id},
      profile: {group_id: conversation.id, group_name}, member, capabilities: capabilities(conversation),
      receive: {source: 'unconfigured', complete: false, upstream_gap_detection: false}};
  }

  async function sendMessage(input) {
    const value = sendShape(input, policy), conversation = value.conversation;
    if (conversation.type === 'private') {
      if (typeof privateFacade?.sendMessage !== 'function') fail(503, 'send_unavailable');
      return privateFacade.sendMessage(value);
    }
    if (typeof sendGroup !== 'function' || typeof groupScope?.reserve !== 'function' || typeof groupScope?.cached !== 'function' || typeof validateMessages !== 'function') fail(503, 'send_unavailable');
    const attempt = Promise.resolve().then(async () => {
      // Prior validation/provenance must not be required again to return an
      // existing result; scope and Store content hash still must match.
      const previous = await groupScope.cached(value);
      requireConversation(policy, conversation, 'send');
      if (previous !== null) return cachedDelivery(value.request_id, previous);
      const base = value.messages.filter(item => !['at', 'reply'].includes(item.type));
      const normalized = base.length ? await validateMessages(base, {decodeImage, errorFactory: (status, code) => new ToolFailure(status, code)}) : [];
      let index = 0;
      const messages = value.messages.map(item => ['at', 'reply'].includes(item.type) ? {...item} : normalized[index++]);
      const members = new Set();
      for (const item of messages) if (item.type === 'at' && !members.has(item.user_id)) {
        requireConversation(policy, conversation, 'mention');
        const result = await readProvider(provider?.getGroupMemberInfo?.bind(provider), {group_id: conversation.id, user_id: item.user_id});
        requireConversation(policy, conversation, 'mention'); memberProfile(result, conversation.id, item.user_id); members.add(item.user_id);
      }
      const reply = messages.find(item => item.type === 'reply');
      let quoteExpiresAt = null;
      if (reply) {
        requireConversation(policy, conversation, 'reply');
        if (typeof resolveReply !== 'function') fail(503, 'reply_unavailable');
        let reference;
        try { reference = await resolveReply({conversation: {...conversation}, cursor: reply.cursor, message_id: reply.message_id}); }
        catch { fail(503, 'reply_unavailable'); }
        requireConversation(policy, conversation, 'reply');
        if (!reference || reference.conversation?.type !== 'group' || reference.conversation.id !== conversation.id || reference.cursor !== reply.cursor || reference.message_id !== reply.message_id || !validAccountId(reference.user_id) || !Number.isSafeInteger(reference.expires_at) || reference.expires_at <= clock()) fail(404, 'reply_not_found');
        quoteExpiresAt = reference.expires_at;
      }
      requireConversation(policy, conversation, 'send');
      const normalizedValue = {...value, messages};
      const existing = await groupScope.reserve(normalizedValue);
      if (existing !== null) return cachedDelivery(value.request_id, existing);
      // Recheck immediately before I/O even when a custom policy is revoked.
      requireConversation(policy, conversation, 'send');
      // If provenance expired during an asynchronous reservation callback, keep
      // the reserved row conservative and make no upstream attempt.
      if (quoteExpiresAt !== null && quoteExpiresAt <= clock()) return delivery(value.request_id, 'unknown');
      try {
        const payload={group_id: conversation.id, message: oneBot(messages), auto_escape: true};
        groupScope.bindTransport?.(value.request_id,payload);
        const result = await sendGroup(payload);
        const id = result?.message_id;
        if ((typeof id !== 'number' && typeof id !== 'string') || (typeof id === 'number' && !Number.isSafeInteger(id)) || !validMessageId(String(id))) throw new Error('acknowledgement unavailable');
        const messageId = String(id); await groupScope.complete(value.request_id, messageId);
        return delivery(value.request_id, 'sent', messageId);
      } catch(error) {if(groupScope.store?.reject?.(value.request_id,error))return groupScope.result(conversation,value.request_id);return delivery(value.request_id, 'unknown'); }
    }).catch(error => {if(error?.code==='delivery_rejected')return groupScope.result(conversation,value.request_id); if (error?.code === 'delivery_uncertain') return delivery(value.request_id, 'unknown'); throw publicFailure(error); });
    return boundedWait(attempt, timeoutMs, () => delivery(value.request_id, 'unknown'));
  }

  async function getSendResult(input) {
    const value = snapshot(input); const withHash = value && Object.hasOwn(value, 'body_hash');
    exact(value, ['conversation', 'request_id', ...(withHash ? ['body_hash'] : [])]);
    const conversation = requireConversation(policy, value.conversation, 'read_result');
    if (!validRequestId(value.request_id) || (withHash && (typeof value.body_hash !== 'string' || !/^[0-9a-f]{64}$/.test(value.body_hash)))) fail(400, 'invalid_request');
    if (conversation.type === 'private') {
      if (typeof privateFacade?.getSendResult !== 'function') fail(503, 'result_query_unavailable');
      // The pre-group private facade had no group scope column. When sharing its
      // Store, hide group UUIDs before delegating rather than leaking an ACK.
      try {
        if (groupScope) {
          if (typeof groupScope.ownsRequest !== 'function') fail(503, 'result_query_unavailable');
          const owned = await groupScope.ownsRequest(value.request_id);
          requireConversation(policy, conversation, 'read_result');
          if (owned === true) return delivery(value.request_id, 'not_found');
          if (owned !== false) fail(503, 'result_query_unavailable');
        }
        const result = await privateFacade.getSendResult(value);
        requireConversation(policy, conversation, 'read_result'); return result;
      } catch (error) { throw publicFailure(error); }
    }
    if (typeof groupScope?.result !== 'function') fail(503, 'result_query_unavailable');
    try {
      const result = await groupScope.result(conversation, value.request_id, value.body_hash ?? null);
      requireConversation(policy, conversation, 'read_result'); return result;
    } catch (error) { throw publicFailure(error); }
  }
  return Object.freeze({getChatInfo, sendMessage, getSendResult});
}
