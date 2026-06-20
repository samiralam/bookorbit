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
- [x] **★ `GET /items/:id/file/:fileid`** — inline file stream. Implemented: `streamFileInline` in
      `abs-items.controller.ts` + `getItemFile` in `abs-catalog.service.ts` (jwt + library access only,
      no `canDownload`), range-aware via `abs-stream.service.ts`.
- [ ] **★ public share track** — `GET /public/share/:slug/track/:index` (+ landing/cover/download/progress, see Priority 2 §Shares)

### Playlists (only `GET /playlists` list is implemented)

- [ ] **★ `POST /playlists`** — create
- [ ] `GET /playlists/:id`
- [ ] `PATCH /playlists/:id`
- [ ] `DELETE /playlists/:id`
- [ ] `POST /playlists/:id/item` / `DELETE /playlists/:id/item/:libraryItemId/:episodeId?` (episode param N/A — BookOrbit items have no episodes)
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

- [x] `GET /me/listening-sessions` — returns an empty ABS history page (BookOrbit keeps no ABS-shaped session history); satisfies clients (e.g. Prologue) that probe it on connect
- [x] `GET /me/item/listening-sessions/:libraryItemId/:episodeId?` — empty page (same rationale as `listening-sessions`); decodes the item id to 404 on garbage (episode param N/A — BookOrbit items have no episodes)
- [x] `GET /me/listening-stats` — zeroed stats envelope (no per-session history retained)
- [ ] `GET /me/progress/:id/remove-from-continue-listening` — needs a `hideFromContinueListening` column on `audiobook_progress` (mapper currently hardcodes `false`); defer to its own migration PR
- [x] `DELETE /me/progress/:id` — deletes the `audiobook_progress` row via `AbsProgressService#deleteProgress`; accepts the composite `usr_<u>-li_<b>` id (or bare `li_<b>`), verifies the user segment, 404 when absent
- [ ] `PATCH /me/password`
- [ ] `GET /me/series/:id/remove-from-continue-listening` / `readd-to-continue-listening`
- [x] `GET /me/stats/year/:year` — zeroed year-in-review envelope (no per-session history retained)
- [ ] `POST /me/ereader-devices`

### Sessions (admin side)

- [ ] `GET /sessions` (admin, 404 to non-admin)
- [ ] `DELETE /sessions/:id`
- [ ] `GET /sessions/open`
- [ ] `POST /sessions/batch/delete`

### Libraries (admin / podcast)

- [ ] `POST /libraries` (create), `PATCH /libraries/:id`, `DELETE /libraries/:id`
- [ ] `DELETE /libraries/:id/issues`
- [ ] `GET /libraries/:id/series/:seriesId`
- [ ] `GET /libraries/:id/stats`
- [x] `GET /libraries/:id/authors` — authors with in-library book counts (primary browse axis for author-centric clients, e.g. Prologue)
- [ ] `GET /libraries/:id/narrators`, `PATCH`/`DELETE /libraries/:id/narrators/:narratorId`
- [ ] `GET /libraries/:id/matchall`, `POST /libraries/:id/scan`
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
- [~] **Authors** (`/api/authors`) — `GET /authors/:id` (with `?include=items,series`) implemented; remaining: update/delete, match, image get/upload/delete
- [ ] **Series** standalone (`/api/series`) — 2 routes (get one, update)
- [ ] **Users** (`/api/users`, admin) — 9 routes
- [ ] **Notifications** (`/api/notifications`, admin) — 8 routes (reduced relevance: ABS events are mostly `onPodcastEpisodeDownloaded`; without podcasts only backup/test events remain)
- [ ] **Emails / e-reader** (`/api/emails`) — 5 routes
- [ ] **Search providers** (`/api/search`) — 6 routes (covers/books/~~podcast~~/authors/chapters/providers; `GET /search/podcast` N/A — no podcast support)
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

## Priority 4 — podcasts (not planned)

BookOrbit does not currently support podcasts, so this part of the ABS API is **out of scope**. These
routes are tracked only for completeness against the upstream surface; do not implement them unless
podcast support is added to BookOrbit. Even the ★ client-critical markings below are deprioritised here.

- [ ] **★ `POST /items/:id/play/:episodeId`** — podcast-episode playback (book `play` exists, episode variant missing)
- [ ] **★ `GET /libraries/:id/recent-episodes`** — podcast "latest" shelf
- [ ] `GET /libraries/:id/episode-downloads`
- [ ] `GET /libraries/:id/opml`, `GET /libraries/:id/podcast-titles`
- [ ] **Podcasts** (`/api/podcasts`) — 13 routes (feed parse, OPML, episodes, downloads, match)

---

## Notes

- Counts are documented-route counts from `ENDPOINTS.md`, not a commitment to ship all of them.
- Reconcile this list with `COVERAGE.md` (doc coverage) and the planning docs to split
  "deferred by design" (much of the admin/server-management surface) from "genuinely pending."
