# Protocol

Requests use UTF-8 compact JSON, Ed25519 signatures and SHA-256. The exact bytes sent are hashed. Each canonical form is newline-joined with a final newline.

Request fields:

1. `napcat-chat-request-v1` (or `napcat-status-request-v1` for status)
2. Configured HTTPS audience
3. Client key ID
4. HTTP method
5. Full path
6. Millisecond timestamp
7. 32 random bytes, unpadded base64url
8. Hex SHA-256 of the request body

Headers: `X-Dot-Key-Id`, `X-Dot-Timestamp`, `X-Dot-Nonce`, `X-Dot-Signature`.

Response fields:

1. `napcat-chat-response-v1` (or `napcat-status-response-v1`)
2. Same audience
3. Server key ID
4. Hex SHA-256 of request canonical bytes
5. Millisecond timestamp
6. Original request nonce
7. Decimal HTTP status
8. Hex SHA-256 of response bytes

Headers: `X-Dot-Server-Key-Id`, `X-Dot-Response-Timestamp`, `X-Dot-Request-Hash`, `X-Dot-Response-Signature`.

Clock tolerance is ±30 seconds. The server persists used nonces. Authenticated errors are signed; authentication failures contain no body. The client rejects unsigned results, changed origins, redirects, compressed responses, mismatched keys and tampered bodies.

`GET /qq/status` has an empty request body and returns exactly `{"online":true|false}`. Server-side account checks bind it to the configured instance; this old status schema deliberately does not claim client-verifiable QQ identity.

All tools are `POST /qq/tools/<name>`. The allowlist lives in `server/src/tool_routes.mjs` and `signed_action_routes.mjs`. Basic tools:

- `get_chat_info`, `poll_events`, `read_history`, `search_history`, `get_message`, `view_media`
- `send_message`, `get_send_result`

The Python client's `tool --help` lists optional QQ tools. This is a fixed interface, not a OneBot proxy: callers cannot select native method names, shell commands, arbitrary URLs or filesystem paths.

Conversations are `{"type":"private"|"group","id":"<decimal string>"}`. Send bodies include a caller-selected UUIDv4 `request_id` and bounded `messages`. Supported segments are defined in `media_messages.mjs`; quotation/media cursors must originate from retained messages in the same conversation. Treat every cursor as opaque.

Example logical send body (replace placeholders; this is not an authorization):

```json
{"conversation":{"type":"private","id":"<allowed peer>"},"request_id":"<UUIDv4>","messages":[{"type":"text","text":"Hello"}]}
```

The server never retries an ambiguous native send. Reconciliation uses the original operation ID and conversation. The client additionally prevents reusing a local write attempt after timeout, restart or a different send-family route. A signed HTTP 200 acknowledges a response, not necessarily delivery; inspect the tool's returned `state`.

Latest-history polling observes a bounded window. Offline gaps, unsupported message segments and upstream limitations are reported as incomplete coverage, never converted into a full-history guarantee.
