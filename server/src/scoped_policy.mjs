import {CONFIG,PRIMARY_PRIVATE} from './config.mjs';
// Trusted construction-time policy only. QQ message data never grants authority.
export const TARGET = PRIMARY_PRIVATE;
export const PRIVATE_CANDIDATES = CONFIG.allowed_privates;
export const GROUP_ALLOWLIST = Object.freeze([]);
export class EventFailure extends Error {
  constructor(status, code) { super(code); this.name = 'EventFailure'; this.status = status; this.code = code; }
}
export const validAccountId = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
export const validMessageId = value => typeof value === 'string' && /^-?[0-9]{1,20}$/.test(value);
export const validFileId = value => typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/.test(value);
export const fail = (status, code) => { throw new EventFailure(status, code); };
export const safeInt = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;

export function snapshot(input, {maxBytes = 3 * 1024 * 1024, maxNodes = 512, maxArray = 100, maxDepth = 10} = {}) {
  let nodes = 0;
  const copy = (value, depth) => {
    if (++nodes > maxNodes || depth > maxDepth) fail(400, 'invalid_request');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') { if (value.length > maxBytes) fail(413, 'request_too_large'); return value; }
    if (!value || typeof value !== 'object') fail(400, 'invalid_request');
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if ((array && prototype !== Array.prototype) || (!array && prototype !== Object.prototype && prototype !== null)) fail(400, 'invalid_request');
    if (Object.getOwnPropertySymbols(value).length) fail(400, 'invalid_request');
    const descriptors = Object.getOwnPropertyDescriptors(value), output = array ? [] : Object.create(null);
    if (array && (value.length > maxArray || Object.keys(value).length !== value.length)) fail(400, 'invalid_request');
    for (const name of Object.keys(descriptors)) {
      if (array && name === 'length') continue;
      const entry = descriptors[name];
      if (!entry.enumerable || !('value' in entry) || (array && !/^(0|[1-9][0-9]*)$/.test(name))) fail(400, 'invalid_request');
      Object.defineProperty(output, name, {value: copy(entry.value, depth + 1), writable: true, enumerable: true, configurable: true});
    }
    return output;
  };
  const result = copy(input, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) fail(413, 'request_too_large');
  return result;
}

export function parseConversation(input) {
  const value = snapshot(input);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'id,type' ||
      !['private', 'group'].includes(value.type) || !validAccountId(value.id)) fail(400, 'invalid_conversation');
  return Object.freeze({type: value.type, id: value.id});
}

export function createScopedConversationPolicy({allowedGroups = [], allowedPrivates = [TARGET]} = {}) {
  const captured = snapshot(allowedGroups);
  if (!Array.isArray(captured) || captured.length > 16 || captured.some(value => !validAccountId(value))) throw new TypeError('invalid trusted group allowlist');
  const groups = new Set(captured);
  const peers = snapshot(allowedPrivates);
  if (!Array.isArray(peers) || peers.length > 16 || new Set(peers).size !== peers.length || peers.some(id => !validAccountId(id))) throw new TypeError('invalid trusted private allowlist');
  const privates = new Set(peers);
  const operations = new Set(['read_info', 'read', 'poll', 'history', 'media', 'send', 'read_result', 'mention', 'reply']);
  return Object.freeze({authorize(conversation, operation) {
    const value = parseConversation(conversation);
    return operations.has(operation) && (value.type === 'private' ? privates.has(value.id) && operation !== 'mention' : groups.has(value.id));
  }});
}
export const createConversationPolicy = createScopedConversationPolicy;

export function requireConversation(policy, input, operation = 'read_info') {
  const chat = parseConversation(input);
  if (typeof policy?.authorize !== 'function') throw new TypeError('trusted policy.authorize required');
  let allowed = false;
  try { allowed = policy.authorize(chat, operation) === true; } catch { /* Fail closed. */ }
  if (!allowed) fail(403, 'conversation_forbidden');
  return chat;
}
export const scopeKey = chat => `${chat.type}:${chat.id}`;
