import {PRIVATE_TARGET, snapshot, exact, fail} from './tool_contract.mjs';

export const validAccountId = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const OPERATIONS = Object.freeze(['read_info', 'send', 'read_result', 'mention', 'reply']);

export function parseConversation(input) {
  const value = snapshot(input); exact(value, ['type', 'id']);
  if (!['private', 'group'].includes(value.type) || !validAccountId(value.id)) fail(400, 'invalid_conversation');
  return Object.freeze({type: value.type, id: value.id});
}

// Trusted construction-time config only, copied into a closed immutable policy.
// No event/message/config-update method. Defaults to zero authorized groups.
export function createConversationPolicy({allowedGroups = [], allowedPrivates = [PRIVATE_TARGET]} = {}) {
  const captured = snapshot(allowedGroups);
  if (!Array.isArray(captured) || captured.length > 16 || captured.some(value => !validAccountId(value))) throw new TypeError('invalid trusted group allowlist');
  const groups = new Set(captured);
  const peers = snapshot(allowedPrivates);
  if (!Array.isArray(peers) || peers.length > 16 || new Set(peers).size !== peers.length || peers.some(id => !validAccountId(id))) throw new TypeError('invalid trusted private allowlist');
  const privates = new Set(peers);
  return Object.freeze({
    authorize(conversation, operation) {
      const value = parseConversation(conversation);
      if (!OPERATIONS.includes(operation)) return false;
      return value.type === 'private' ? privates.has(value.id) && operation !== 'mention' : groups.has(value.id);
    },
  });
}

// A custom policy may implement revocation, but its callback is trusted config,
// never supplied by a tool request or QQ message. Always recheck after awaits.
export function requireConversation(policy, input, operation) {
  const conversation = parseConversation(input);
  if (typeof policy?.authorize !== 'function') throw new TypeError('trusted policy.authorize required');
  let permitted;
  try { permitted = policy.authorize(conversation, operation); } catch { fail(403, 'conversation_forbidden'); }
  if (permitted !== true) fail(403, 'conversation_forbidden');
  return conversation;
}
