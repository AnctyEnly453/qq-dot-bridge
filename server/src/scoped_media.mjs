import {EventFailure, snapshot, requireConversation, validFileId, validMessageId} from './scoped_policy.mjs';
import {validateImageBytes, MEDIA_LIMITS} from './image_validation.mjs';

const defaultError = (status, code) => new EventFailure(status, code);
const exactRequest = value => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === 'conversation,cursor,file_id';
const sameConversation = (left, right) => left?.type === right.type && left?.id === right.id;
const decimalCursor = value => /^(0|[1-9][0-9]{0,15})$/.test(value) && Number.isSafeInteger(Number(value));

export function imageMime(bytes, errorFactory = defaultError) {
  if (Buffer.isBuffer(bytes)) {
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
    if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
    if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  }
  throw errorFactory(400, 'invalid_image');
}

/** Retained media authorization is performed by the scoped event store, never a
 * URL/path lookup. The injected adapter must use every field of this scope and
 * must not delegate group reads to a filename-only legacy reader.
 * decodeImage is a trusted full decoder: it must reject corrupt/truncated data,
 * dimensions >4096, pixels >12000000, frames >60 and decode every frame.
 */
export class ScopedMedia {
  constructor({store, adapter, decodeImage, errorFactory = defaultError} = {}) {
    if (typeof store?.authorize !== 'function' || typeof store?.getRetainedMessage !== 'function' ||
        typeof store?.policy?.authorize !== 'function') throw new TypeError('trusted scoped event store required');
    if (typeof errorFactory !== 'function') throw new TypeError('errorFactory must be a function');
    this.store = store;
    this.adapter = adapter;
    this.decodeImage = decodeImage;
    this.errorFactory = errorFactory;
  }

  fail(status, code) { throw this.errorFactory(status, code); }

  authorize(conversation) {
    // read_info deliberately matches the existing trusted conversation policy.
    // Store authorization also prunes revoked retained rows and rotates epochs.
    this.store.authorize(conversation);
    return requireConversation(this.store.policy, conversation, 'read_info');
  }

  retained(request) {
    this.authorize(request.conversation);
    const row = this.store.getRetainedMessage({conversation: request.conversation, cursor: request.cursor});
    // A malformed store result never reaches the transport. This API is sync.
    const legacy = request.conversation.type === 'private' && decimalCursor(request.cursor);
    if (row?.then || !row || !sameConversation(row.conversation, request.conversation) ||
        (row.cursor !== request.cursor && !(legacy && typeof row.cursor === 'string' && row.cursor.startsWith('e1.'))) ||
        !validMessageId(row.message_id) || !Array.isArray(row.messages) || (row.state !== undefined && row.state !== 'available')) {
      this.fail(404, 'media_not_found');
    }
    const image = row.messages.find(item => item?.type === 'image' && item.file_id === request.file_id);
    // Upstream image size is optional metadata, never authority to bypass bounds.
    if (!image || (image.size_bytes !== undefined && (!Number.isSafeInteger(image.size_bytes) || image.size_bytes < 0))) this.fail(404, 'media_not_found');
    if (image.size_bytes > MEDIA_LIMITS.imageBytes) this.fail(413, 'message_too_large');
    return Object.freeze({
      conversation: request.conversation,
      cursor: row.cursor,
      message_id: row.message_id,
      file_id: request.file_id,
      size_bytes: image.size_bytes,
    });
  }

  recheck(request, original) {
    const current = this.retained(request);
    if (current.cursor !== original.cursor || current.message_id !== original.message_id || current.size_bytes !== original.size_bytes) this.fail(404, 'media_not_found');
  }

  async read(input) {
    try {
      const value = snapshot(input, {maxBytes: 8192, maxNodes: 16, maxArray: 0, maxDepth: 3});
      if (!exactRequest(value)) this.fail(400, 'invalid_request');
      const conversation = this.authorize(value.conversation);
      if (typeof value.cursor !== 'string' || value.cursor.length > 4096 ||
          !(value.cursor.startsWith('e1.') || (conversation.type === 'private' && decimalCursor(value.cursor)))) this.fail(400, 'invalid_cursor');
      if (!validFileId(value.file_id)) this.fail(400, 'invalid_media_reference');
      const request = Object.freeze({conversation, cursor: value.cursor, file_id: value.file_id});
      const source = this.retained(request);
      if (typeof this.adapter?.readImage !== 'function' || typeof this.decodeImage !== 'function') this.fail(503, 'media_unavailable');
      const transportRequest = Object.freeze({conversation, cursor: source.cursor, message_id: source.message_id, file_id: source.file_id});
      let received;
      try { received = await this.adapter.readImage(transportRequest); }
      catch { this.recheck(request, source); this.fail(503, 'media_unavailable'); }
      this.recheck(request, source);
      if (!Buffer.isBuffer(received) || !received.length) this.fail(400, 'invalid_image');
      if (received.length > MEDIA_LIMITS.imageBytes) this.fail(413, 'message_too_large');
      // Copy before any await: the adapter cannot mutate returned bytes later.
      const bytes = Buffer.from(received), mime = imageMime(bytes, this.errorFactory);
      const decodingBytes = Buffer.from(bytes);
      try { await validateImageBytes(decodingBytes, mime, {decodeImage: this.decodeImage, errorFactory: this.errorFactory}); }
      catch (error) { this.recheck(request, source); throw error; }
      this.recheck(request, source);
      if (!decodingBytes.equals(bytes)) this.fail(400, 'invalid_image');
      return {conversation: {...conversation}, cursor: source.cursor, message_id: source.message_id,
        file_id: source.file_id, mime, data_base64: bytes.toString('base64')};
    } catch (error) {
      if (error instanceof EventFailure) throw this.errorFactory(error.status, error.code);
      throw error;
    }
  }

  viewMedia(input) { return this.read(input); }
}

export const createScopedMedia = options => new ScopedMedia(options);
