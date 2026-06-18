# Audiobookshelf API — Re-implementation Documentation

A standalone, re-implementation-grade description of the Audiobookshelf (ABS) server API. The intent
is to let a **separate service implement an ABS-compatible API** so that existing ABS clients (the
official mobile apps and web client) can connect to it unmodified.

## Read in this order

1. **[REIMPLEMENTATION_GUIDE.md](./REIMPLEMENTATION_GUIDE.md)** — the contract narrative: route
   mounting, auth & token lifecycle, data models, query/error conventions, **streaming & HLS**, the
   **Socket.IO event contract**, and **progress/offline-sync semantics**. The §8 checklist is the
   minimum for client compatibility.
2. **[ENDPOINTS.md](./ENDPOINTS.md)** — every route grouped by domain (method, path, auth, purpose),
   with client-critical routes marked ★.
3. **[COVERAGE.md](./COVERAGE.md)** — route-inventory verification + what the existing OpenAPI spec
   does and doesn't cover + how to extend it.

## Scope & sourcing

- Documented against the v2.35.x server line (`package.json` `version`).
- Source of truth is server code — primarily `server/routers/ApiRouter.js`,
  `server/routers/HlsRouter.js`, `server/routers/PublicRouter.js`, `server/Auth.js`,
  `server/auth/TokenManager.js`, `server/managers/PlaybackSessionManager.js`, and
  `server/SocketAuthority.js`. The companion OpenAPI spec lives one level up in `docs/`.
- This set intentionally documents the parts OpenAPI can't model (token rotation, the playback
  state machine, HLS seek/reset, socket events, sync conflict rules).

## Build a client/server against this

Trace the §8 checklist end-to-end: `GET /status` → `POST /login` → `GET /api/libraries` →
`GET /api/libraries/:id/items` → `GET /api/items/:id` → `POST /api/items/:id/play` →
stream (`/hls/...` or `/public/session/:id/track/:index`) → `POST /api/session/:id/sync` → `/close`,
with a `/socket.io` connection emitting `auth` and handling `stream_reset` /
`user_item_progress_updated`. If all of that works against your server with an unmodified ABS client,
you're compatible.
