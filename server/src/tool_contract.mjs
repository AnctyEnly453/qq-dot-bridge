import {PRIMARY_PRIVATE} from './config.mjs';
import crypto from 'node:crypto';
import {SEND_REJECTION_CODES} from './send_failures.mjs';

// This release deliberately has no configurable destination allowlist.
export const PRIVATE_TARGET = PRIMARY_PRIVATE;
export const GROUP_ALLOWLIST = Object.freeze([]);
export const TOOL_PATHS = Object.freeze({send: '/qq/private/send', media: '/qq/private/media'});
export const MAX_BODY = 3 * 1024 * 1024;
export class ToolFailure extends Error {
  constructor(status, code) { super(code); this.name = 'ToolFailure'; this.status = status; this.code = code; }
}
export const fail = (status, code) => { throw new ToolFailure(status, code); };
export const digest = value => crypto.createHash('sha256').update(value).digest('hex');
export const newRequestId = () => crypto.randomUUID();
export const validRequestId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export const validMessageId = value => typeof value === 'string' && /^-?[0-9]{1,20}$/.test(value);
export const validCursor = value => typeof value === 'string' && ( /^(0|[1-9][0-9]{0,15})$/.test(value) && Number.isSafeInteger(Number(value)) || value.length<=4096 && /^e1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value));
export const validFileId = value => typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/.test(value);
export function exact(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...names].sort().join(',')) fail(400, 'invalid_request');
}

// Reject accessors, symbols, custom prototypes and oversized values before any
// async validation. All later work uses this private JSON-data snapshot.
export function snapshot(input) {
  let nodes = 0;
  const copy = (value, depth) => {
    if (++nodes > 128 || depth > 6) fail(400, 'invalid_request');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') { if (value.length > MAX_BODY) fail(413, 'request_too_large'); return value; }
    if (!value || typeof value !== 'object') fail(400, 'invalid_request');
    const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
    if ((array && proto !== Array.prototype) || (!array && proto !== Object.prototype && proto !== null)) fail(400, 'invalid_request');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length) fail(400, 'invalid_request');
    const output = array ? [] : Object.create(null);
    if (array && (value.length > 16 || Object.keys(value).length !== value.length)) fail(400, 'invalid_request');
    for (const name of Object.keys(descriptors)) {
      if (array && name === 'length') continue;
      const entry = descriptors[name];
      if (!entry.enumerable || !('value' in entry) || (array && !/^(0|[1-9][0-9]*)$/.test(name))) fail(400, 'invalid_request');
      output[name] = copy(entry.value, depth + 1);
    }
    return output;
  };
  const output = copy(input, 0);
  if (Buffer.byteLength(JSON.stringify(output)) > MAX_BODY) fail(413, 'request_too_large');
  return output;
}
export function authorizeConversation(value) {
  exact(value, ['type', 'id']);
  if (value.type !== 'private' || value.id !== PRIVATE_TARGET) fail(403, 'conversation_forbidden');
  return {type: 'private', id: PRIVATE_TARGET};
}
export function validateResultRequest(input) {
  const value = snapshot(input);
  const hasHash = Object.hasOwn(value, 'body_hash');
  exact(value, ['conversation', 'request_id', ...(hasHash ? ['body_hash'] : [])]);
  const conversation = authorizeConversation(value.conversation);
  if (!validRequestId(value.request_id) || (hasHash && (typeof value.body_hash !== 'string' || !/^[0-9a-f]{64}$/.test(value.body_hash)))) fail(400, 'invalid_request');
  return {conversation, request_id: value.request_id, ...(hasHash ? {body_hash: value.body_hash} : {})};
}
export function validateSendShape(input) {
  const value = snapshot(input); exact(value, ['conversation', 'request_id', 'messages']);
  const conversation = authorizeConversation(value.conversation);
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
      if (typeof item.user_id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(item.user_id)) fail(400, 'invalid_mention');
      // No @all, private mentions, membership lookup, or group authorization.
      fail(400, 'mention_not_supported');
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
export function delivery(requestId, state, messageId = null) {
  return {request_id: requestId, state, message_id: messageId};
}
export const sendHash = value => digest(JSON.stringify({target: PRIVATE_TARGET, request_id: value.request_id, messages: value.messages}));
export function validateDelivery(value, requestId, allowNotFound = false) {
  const rejected=value?.state==='rejected';exact(value, ['request_id', 'state', 'message_id',...(rejected?['error']:[])]);
  if (value.request_id !== requestId || !['sent', 'unknown','rejected', ...(allowNotFound ? ['not_found'] : [])].includes(value.state)||rejected&&!SEND_REJECTION_CODES.includes(value.error)) fail(502, 'invalid_response');
  if (value.state === 'sent' ? !validMessageId(value.message_id) : value.message_id !== null) fail(502, 'invalid_response');
  return {...delivery(requestId, value.state, value.message_id),...(rejected?{error:value.error}:{})};
}
export async function boundedWait(promise, timeoutMs, fallback) {
  let timer;
  try { return await Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => { try { resolve(fallback()); } catch (error) { reject(error); } }, timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
export function validateTimeout(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 120000) throw new TypeError('invalid timeout');
  return value;
}
