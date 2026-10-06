import {ToolFailure, PRIVATE_TARGET, GROUP_ALLOWLIST, snapshot, exact, authorizeConversation, validateSendShape, validateResultRequest, validCursor, validFileId, fail} from './tool_contract.mjs';

export class ConversationTools {
  constructor({sender, imageEnabled = false, replyEnabled = false, mediaReader}) {
    if (typeof sender?.sendValidated !== 'function' || typeof sender?.result !== 'function') throw new TypeError('existing Engine sender required');
    if (typeof imageEnabled !== 'boolean' || typeof replyEnabled !== 'boolean') throw new TypeError('trusted capability flags required');
    this.sender = sender; this.imageEnabled = imageEnabled; this.replyEnabled = replyEnabled; this.mediaReader = mediaReader;
  }
  get_chat_info(input) {
    const value = snapshot(input); exact(value, ['conversation']);
    const conversation = authorizeConversation(value.conversation);
    return {conversation, source: 'local_policy', profile: null,
      capabilities: {send_message: true, send_result: true, text: true, face: true,
        image: this.imageEnabled, reply: this.replyEnabled,
        at: false, marketplace_sticker: false, view_media: typeof this.mediaReader?.read === 'function',
        enabled_groups: [...GROUP_ALLOWLIST]},
      receive: {source: 'history_poll', latest: 20, interval_ms: 2000, complete: false, upstream_gap_detection: false}};
  }
  async send_message(input) {
    const value = validateSendShape(input);
    if (value.messages.some(item => item.type === 'reply') && !this.replyEnabled) fail(503, 'reply_unavailable');
    if (value.messages.some(item => item.type === 'image') && !this.imageEnabled) fail(503, 'media_unavailable');
    return this.sender.sendValidated({target: PRIVATE_TARGET, request_id: value.request_id, messages: value.messages});
  }
  get_send_result(input) {
    const value = validateResultRequest(input);
    return this.sender.result(value.request_id, value.body_hash ?? null);
  }
  async view_media(input) {
    const value = snapshot(input); exact(value, ['conversation', 'cursor', 'file_id']);
    authorizeConversation(value.conversation);
    if (!validCursor(value.cursor) || !validFileId(value.file_id)) fail(400, 'invalid_media_reference');
    if (typeof this.mediaReader?.read !== 'function') fail(503, 'media_unavailable');
    // PrivateMedia.read already binds the retained message/image and performs
    // bounded cache reading plus full decoding. Keep its established wire/output.
    return this.mediaReader.read({target: PRIVATE_TARGET, cursor: value.cursor, file_id: value.file_id});
  }
}

export function createQueueReplyResolver(queue) {
  if (typeof queue?.db?.prepare !== 'function' || typeof queue?.now !== 'function') throw new TypeError('trusted existing ReceiveQueue required');
  return ({conversation, cursor, message_id}) => {
    authorizeConversation(conversation);
    const row = queue.db.prepare('SELECT payload FROM received WHERE seq=? AND expires>?').get(Number(cursor), queue.now());
    if (!row) return false;
    let value; try { value = JSON.parse(row.payload); } catch { return false; }
    return value.conversation?.type === 'private' && value.conversation.id === PRIVATE_TARGET && value.user_id === PRIVATE_TARGET && value.message_id === message_id;
  };
}

// Uses only the EXISTING send_private_msg capability on the trusted adapter.
// The existing DockerAdapter.send cannot map replies; don't feed replies to it.
export function createPrivateSendAdapter(existingAdapter) {
  if (typeof existingAdapter?.call !== 'function') throw new TypeError('trusted existing DockerAdapter required');
  return {async send(value) {
    if (value.target !== PRIVATE_TARGET) fail(403, 'conversation_forbidden');
    const message = value.messages.map(item => {
      if (item.type === 'text') return {type: 'text', data: {text: item.text}};
      if (item.type === 'face') return {type: 'face', data: {id: String(item.id)}};
      if (item.type === 'image') return {type: 'image', data: {file: 'base64://' + item.data_base64}};
      if (item.type === 'reply') return {type: 'reply', data: {id: item.message_id}};
      fail(400, 'invalid_request');
    });
    const result = await existingAdapter.call('send_private_msg', {user_id: Number(PRIVATE_TARGET), message, auto_escape: true}, 16384);
    return result?.message_id;
  }};
}
