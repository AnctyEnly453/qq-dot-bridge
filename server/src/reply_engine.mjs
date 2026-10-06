import {PRIVATE_TARGET, ToolFailure, snapshot, exact, validateSendShape} from './tool_contract.mjs';

// Optional offline Engine extension; the supplied existing Store.reserve/complete
// is the ONLY send-idempotency authority. Import does not change the v1 routes.
export function createReplyEngine({bridge, store, adapter, validateMessages, decodeImage, resolveReply}) {
  if (typeof bridge?.Engine !== 'function' || typeof bridge?.Failure !== 'function' || typeof store?.reserve !== 'function' || typeof store?.complete !== 'function' || typeof store?.db?.prepare !== 'function' || typeof adapter?.send !== 'function' || typeof validateMessages !== 'function' || typeof resolveReply !== 'function') throw new TypeError('existing Engine/Store, media validation and retained-message resolver required');
  return new class extends bridge.Engine {
    async send(input) {
      try {
        const captured = snapshot(input); exact(captured, ['target', 'request_id', 'messages']);
        if (captured.target !== PRIVATE_TARGET) throw new ToolFailure(403, 'conversation_forbidden');
        const value = validateSendShape({conversation: {type: 'private', id: PRIVATE_TARGET}, request_id: captured.request_id, messages: captured.messages});
        const candidate = {target: PRIVATE_TARGET, request_id: value.request_id, messages: value.messages};
        // Previously reserved bodies were already fully validated. Delegate to
        // Store for conflict/pending/completion without requiring expired quote
        // provenance again. This branch cannot create a new upstream attempt.
        if (this.store.db.prepare('SELECT request_id FROM sends WHERE request_id=?').get(value.request_id)) {
          const previous = this.store.reserve(candidate);
          return {request_id: value.request_id, message_id: previous};
        }
        const normalized = await validateMessages(value.messages.filter(item => item.type !== 'reply'), {decodeImage, errorFactory: (status, code) => new bridge.Failure(status, code)});
        let index = 0;
        const messages = value.messages.map(item => item.type === 'reply' ? {...item} : normalized[index++]);
        const reply = messages.find(item => item.type === 'reply');
        if (reply) {
          let valid;
          try { valid = await resolveReply({conversation: value.conversation, cursor: reply.cursor, message_id: reply.message_id}); }
          catch { throw new bridge.Failure(503, 'reply_unavailable'); }
          if (valid !== true) throw new bridge.Failure(404, 'reply_not_found');
        }
        const payload = {target: PRIVATE_TARGET, request_id: value.request_id, messages};
        const previous = this.store.reserve(payload);
        if (previous !== null) return {request_id: value.request_id, message_id: previous};
        try {
          const id = await this.adapter.send(payload), messageId = String(id);
          if (!/^-?[0-9]{1,20}$/.test(messageId) || (typeof id !== 'string' && typeof id !== 'number') || (typeof id === 'number' && !Number.isSafeInteger(id))) throw new Error('invalid acknowledgement');
          this.store.complete(value.request_id, messageId);
          return {request_id: value.request_id, message_id: messageId};
        } catch { throw new bridge.Failure(503, 'delivery_uncertain'); }
      } catch (error) {
        if (error instanceof ToolFailure) throw new bridge.Failure(error.status, error.code);
        throw error;
      }
    }
  }(store, adapter, decodeImage);
}
