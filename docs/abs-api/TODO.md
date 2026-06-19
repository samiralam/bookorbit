# ABS API — Implementation TODO

Gap list between the documented upstream surface ([`ENDPOINTS.md`](./ENDPOINTS.md), ~215 routes)
and the routes actually wired up in `server/src/modules/abs/`. Generated 2026-06-19.

**★** = client-critical per `ENDPOINTS.md` (needed for a working mobile/web client). These should be
prioritised. Unmarked rows are admin/server-management routes that may be deferred by design — confirm
against `REIMPLEMENTATION_GUIDE.md` / `BOOKORBIT_PLANNING_PROMPT.md` before treating as required.

> Status snapshot: ~32/215 routes implemented (the client-critical vertical slice). Controllers present:
> `abs-libraries`, `abs-items`, `abs-me`, `abs-sessions`, `abs-playlists` (list only), `abs-public`,
> `abs-hls`, `abs-authorize`, `auth/abs-auth`, `auth/abs-discovery`.

---

## Priority 1 — client-critical (★) gaps in existing controllers

These belong to controllers that already exist; the slice is incomplete.

### Streaming / playback

- [x] **★ `GET /hls/:stream/:file`** — HLS playlist/segment streaming. Implemented: transcode
      negotiation (`playMethod=2`) in `abs-playback.service.ts`, ffmpeg-backed stream manager in
      `abs-transcode.service.ts`, route in `abs-hls.controller.ts`, and `stream_reset` socket emit on
      out-of-window seeks (REIMPLEMENTATION_GUIDE §5.1–5.3).
- [ ] **★ `POST /items/:id/play/:episodeId`** — podcast-episode playback (book `play` exists, episode variant missing)
- [x] **★ `GET /items/:id/file/:fileid`** — inline file stream. Implemented: `streamFileInline` in
      `abs-items.controller.ts` + `getItemFile` in `abs-catalog.service.ts` (jwt + library access only,
      no `canDownload`), range-aware via `abs-stream.service.ts`.
- [ ] **★ public share track** — `GET /public/share/:slug/track/:index` (+ landing/cover/download/progress, see Priority 2 §Shares)

### Library browse

- [ ] **★ `GET /libraries/:id/recent-episodes`** — podcast "latest" shelf

### Playlists (only `GET /playlists` list is implemented)

- [ ] **★ `POST /playlists`** — create
- [ ] `GET /playlists/:id`
- [ ] `PATCH /playlists/:id`
- [ ] `DELETE /playlists/:id`
- [ ] `POST /playlists/:id/item` / `DELETE /playlists/:id/item/:libraryItemId/:episodeId?`
- [ ] `POST /playlists/:id/batch/add` / `POST /playlists/:id/batch/remove`
- [ ] `POST /playlists/collection/:collectionId` — create from collection

---

## Priority 2 — remaining gaps in existing controllers

### Auth / discovery (OIDC)

- [ ] `GET /auth/openid`
- [ ] `GET /auth/openid/callback`
- [ ] `GET /auth/openid/mobile-redirect`
- [ ] `GET /auth/openid/config`

### Library items (writes & extras)

- [ ] `POST /items/batch/delete`, `batch/update`, `batch/quickmatch`, `batch/scan`
- [ ] `DELETE /items/:id`
- [ ] `PATCH /items/:id/media`
- [ ] `POST /items/:id/cover` (upload), `PATCH /items/:id/cover` (set), `DELETE /items/:id/cover`
- [ ] `POST /items/:id/match`
- [ ] `PATCH /items/:id/tracks`
- [ ] `POST /items/:id/scan`
- [ ] `GET /items/:id/metadata-object`
- [ ] `POST /items/:id/chapters`
- [ ] `GET /items/:id/ffprobe/:fileid`
- [ ] `DELETE /items/:id/file/:fileid`
- [ ] `GET /items/:id/ebook/:fileid?`, `PATCH /items/:id/ebook/:fileid/status`

### Current user (`/me`)

- [ ] `GET /me/listening-sessions`
- [ ] `GET /me/item/listening-sessions/:libraryItemId/:episodeId?`
- [ ] `GET /me/listening-stats`
- [ ] `GET /me/progress/:id/remove-from-continue-listening`
- [ ] `DELETE /me/progress/:id`
- [ ] `PATCH /me/password`
- [ ] `GET /me/series/:id/remove-from-continue-listening` / `readd-to-continue-listening`
- [ ] `GET /me/stats/year/:year`
- [ ] `POST /me/ereader-devices`

### Sessions (admin side)

- [ ] `GET /sessions` (admin, 404 to non-admin)
- [ ] `DELETE /sessions/:id`
- [ ] `GET /sessions/open`
- [ ] `POST /sessions/batch/delete`

### Libraries (admin / podcast)

- [ ] `POST /libraries` (create), `PATCH /libraries/:id`, `DELETE /libraries/:id`
- [ ] `DELETE /libraries/:id/issues`
- [ ] `GET /libraries/:id/episode-downloads`
- [ ] `GET /libraries/:id/series/:seriesId`
- [ ] `GET /libraries/:id/stats`
- [ ] `GET /libraries/:id/authors`, `GET /libraries/:id/narrators`, `PATCH`/`DELETE /libraries/:id/narrators/:narratorId`
- [ ] `GET /libraries/:id/matchall`, `POST /libraries/:id/scan`
- [ ] `GET /libraries/:id/opml`, `GET /libraries/:id/podcast-titles`
- [ ] `POST /libraries/order`, `POST /libraries/:id/remove-metadata`
- [ ] `GET /libraries/:id/download`

### Public shares (rest of §5)

- [ ] `GET /public/share/:slug` (landing)
- [ ] `GET /public/share/:slug/cover`
- [ ] `GET /public/share/:slug/download`
- [ ] `PATCH /public/share/:slug/progress`

---

## Priority 3 — controllers not started

Each is a whole domain with zero routes today.

- [ ] **Collections** (`/api/collections`) — 9 routes (CRUD + book add/remove + batch)
- [ ] **Authors** (`/api/authors`) — 7 routes (get/update/delete, match, image get/upload/delete)
- [ ] **Series** standalone (`/api/series`) — 2 routes (get one, update)
- [ ] **Podcasts** (`/api/podcasts`) — 13 routes (feed parse, OPML, episodes, downloads, match)
- [ ] **Users** (`/api/users`, admin) — 9 routes
- [ ] **Notifications** (`/api/notifications`, admin) — 8 routes
- [ ] **Emails / e-reader** (`/api/emails`) — 5 routes
- [ ] **Search providers** (`/api/search`) — 6 routes (covers/books/podcast/authors/chapters/providers)
- [ ] **RSS feeds** (`/api/feeds`) — 5 routes
- [ ] **Shares** (`/api/share`) — `POST /share/mediaitem`, `DELETE /share/mediaitem/:id` (public side in Priority 2)
- [ ] **Tools** (`/api/tools`, admin) — 4 routes (encode-m4b, embed-metadata)
- [ ] **Backups** (`/api/backups`, admin) — 7 routes
- [ ] **API keys** (`/api/api-keys`, admin) — 4 routes
- [ ] **Custom metadata providers** (`/api/custom-metadata-providers`, admin) — 3 routes
- [ ] **Filesystem** (`/api/filesystem`, admin) — 2 routes
- [ ] **Cache** (`/api/cache`, admin) — 2 routes
- [ ] **Stats** (`/api/stats`, admin) — 2 routes
- [ ] **Misc / settings** (`/api`, admin) — 16 routes (`/upload`, `/tasks`, `/settings`, tags, genres,
      `/validate-cron`, `/auth-settings`, `/watcher/update`, `/logger-data`, …). `POST /authorize` already done.

---

## Notes

- Counts are documented-route counts from `ENDPOINTS.md`, not a commitment to ship all of them.
- Reconcile this list with `COVERAGE.md` (doc coverage) and the planning docs to split
  "deferred by design" (much of the admin/server-management surface) from "genuinely pending."
