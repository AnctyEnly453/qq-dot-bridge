# Release verification

The release is checked without contacting any production service or using production keys.

`npm test` runs:

- Node unit/integration tests for request signing, nonce replay, send idempotency, conversation isolation, cursor/history behavior, retained media authorization, bounded backfill, favorite actions and feature boundaries
- A real Python-client / Node-gateway signature interoperability test over an isolated loopback socket with temporary test keys
- Full server startup/shutdown against a synthetic NapCat command fixture, including refusal of a mismatched account
- Python client tests for signature failures, safe defaults, TLS/proxy behavior, operation ledgers and installation template idempotency
- Synthetic audio decoder tests for supported formats, size/duration/stream limits (requires FFmpeg)

`npm run check` checks tracked-file boundaries, private-key/token patterns, deployment-specific paths/addresses and source syntax. The reviewed release also received a separate comparison against known private deployment identifiers; none are in the release.

Current verification environment: Linux, Node.js 24.19.0, Python 3.12, cryptography 50.0.0, Pillow 12.3.0, local FFmpeg. This does not establish compatibility with every QQ/NapCat release or OS.

Not performed in this release:

- A real new QQ login, new persistent identity registration or production deployment
- Live QQ send/receive, media mapping or native-notice acceptance on a new host
- Two-account live isolation testing, real reverse proxy/TLS installation or OS service installation
- Audit of upstream NapCat/QQ internals

The server is Linux/Docker-specific. The Python client is portable, but installation on a new Windows/macOS machine remains unverified. No completed live integration is implied by passing offline tests.
