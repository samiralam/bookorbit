# ABS API — Implementation TODO

Gap list between the documented upstream surface ([`ENDPOINTS.md`](./ENDPOINTS.md), ~215 routes)
and the routes actually wired up in `server/src/modules/abs/`. Generated 2026-06-19; refreshed
2026-07-13 against the controllers and [`ABS_SERVER_DEBUG_LOG.md`](./ABS_SERVER_DEBUG_LOG.md).

**★** = client-critical per `ENDPOINTS.md` (needed for a working mobile/web client). These should be
prioritised. Unmarked rows are admin/server-management routes that may be deferred by design — confirm
against `REIMPLEMENTATION_GUIDE.md` / `BOOKORBIT_PLANNING_PROMPT.md` before treating as required.

> Status snapshot (2026-07-12): ~53/215 routes implemented (the client-critical vertical slice —
> verified end-to-end with Prologue, see the debug log). Controllers present: `abs-libraries`,
> `abs-items` (incl. `batch/get`, file stream/download, cover), `abs-me`, `abs-sessions`,
> `abs-playlists` (list only), `abs-authors` (`GET :id` only), `abs-public`, `abs-hls`,
> `abs-authorize`, `auth/abs-auth`, `auth/abs-discovery`, `auth/abs-openid`.

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

Thin adapter (`abs-openid.controller.ts`) over BookOrbit's existing OIDC stack (`OidcService`); mirrors ABS
`OidcAuthStrategy`/`Auth.js`. Same provider record, claim mapping, and auto-provisioning, so an ABS OIDC login
resolves to the same BookOrbit user as the web flow. `/status` advertises `openid` + button text when a provider
is enabled. Flow is detected as ABS does (`response_type=code` | `redirect_uri` | `code_challenge` ⇒ mobile).
**Operator note:** register `<server>/auth/openid/callback` (web) and `<server>/auth/openid/mobile-redirect`
(mobile — IdPs can't redirect to the `audiobookshelf://` app scheme) as allowed redirect URIs on the IdP client;
same client/provider as BookOrbit's web login (which uses `<appUrl>/oauth2-callback`). ABS has no provider
selection, so the first enabled provider is used.

- [x] `GET /auth/openid` — authorize redirect. Web: server-owned PKCE, IdP→`/callback`. Mobile: native client owns PKCE (`code_challenge` relayed), client `state` preserved, IdP→`/mobile-redirect`
- [x] `GET /auth/openid/callback` — code exchange (verifier server-stashed or client-forwarded); tokens as JSON for mobile/native, same-origin redirect for web
- [x] `GET /auth/openid/mobile-redirect` — IdP hop: bounces the auth `code` (no token) to `audiobookshelf://oauth`; app then calls `/callback` with the verifier
- [x] `GET /auth/openid/config` — admin-only `.well-known` read (403 to non-admin)

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
- [ ] `GET /items/:id/ebook/:fileid?`, `PATCH /items/:id/ebook/:fileid/status` — note: until ebook
      support lands (`ebookFile` is always `null`), books without a playable audio content file are
      intentionally invisible to ABS clients: `AbsReadRepository` gates every book query on an
      audio-content-file `EXISTS` (they would otherwise render as track-less, unplayable items)

### Current user (`/me`)

- [x] `GET /me/listening-sessions` — real paginated history from the persisted `abs_playback_sessions` log (migration 0025), ABS envelope math (`itemsPerPage` default 10 / `page` default 0). See debug log session 2026-07-13
- [x] `GET /me/item/listening-sessions/:libraryItemId/:episodeId?` — per-item history filtered by book id; 404s on garbage/unknown items (episode param N/A — BookOrbit items have no episodes)
- [x] `GET /me/listening-stats` — real aggregates from persisted sessions, mirrors `ApiRouter.getUserListeningStatsHelpers` bug-for-bug (`items[]` entries carry NO `lastUpdate` key, like ABS 2.35.1)
- [x] `GET /me/progress/:id/remove-from-continue-listening` — persisted `hide_from_continue_listening` flag on `audiobook_progress` (migration 0024); clears when the position moves, ABS-asymmetric shelf filtering (`/personalized` filters hidden, `items-in-progress` does not). See debug log session 2026-07-12
- [x] `DELETE /me/progress/:id` — deletes the `audiobook_progress` row via `AbsProgressService#deleteProgress`; accepts the composite `usr_<u>-li_<b>` id (or bare `li_<b>`), verifies the user segment, 404 when absent
- [x] `PATCH /me/password` — delegates to `AuthService.changePassword` (single source of truth: hashing, audit event, web-session revocation, OIDC/shared blocking); maps to ABS wire shapes (demo → 403, bad input/wrong current password → 400 text, success → 200). Enforces BookOrbit's password policy so the ABS route isn't a weak-password side door
- [ ] `GET /me/series/:id/remove-from-continue-listening` / `readd-to-continue-listening` — blocked
      on storage: ABS keeps this in user `extraData.seriesHideFromContinueListening`, which has no
      BookOrbit home yet; implement when a client is seen calling it (Still hit the item-level route)
- [x] `GET /me/stats/year/:year` — real year-in-review from persisted sessions (mirrors `userStats.js getStatsForYear`: top-3 authors/genres with substring junk-genre filter, months, narrator; finished side approximated from MediaProgress `finishedAt`)
- [ ] `POST /me/ereader-devices`

### Sessions (admin side)

Unblocked by the persisted `abs_playback_sessions` log (2026-07-13) but deliberately deferred to a
follow-up: superuser-gated, new `abs-admin-sessions.controller.ts`, repo gains
`listAllPaginated`/`deleteById(s)`.

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

## Behavioral gaps — routes that exist but don't match ABS semantics/values

The route checklist above misses these: the endpoint responds with a valid ABS shape, but the
_content_ diverges from what real ABS 2.35.1 would return (the debug log proved values matter as
much as shapes to strict clients).

- ~~**No listening-session history.**~~ **Resolved 2026-07-13**: sessions persist to
  `abs_playback_sessions` (migration 0025) with ABS semantics (row appears only once
  `timeListening > 0`; sync/close/device-takeover save, stale-prune doesn't; `session/local[-all]`
  upsert by client id). The four `/me` history/stats endpoints serve real data; admin session routes
  are now unblocked (still deferred, see above). Remaining approximation: `finishedAt` in year stats
  is the progress row's `updatedAt` once past the library finish threshold (BookOrbit has no
  persisted finish timestamp).
- **Playlists are a hardcoded empty list.** `GET /api/playlists` returns `{results: [], total: 0}`;
  no playlist model exists. Any client playlist UI is inert.
- **Ebook-only books are invisible by design.** `AbsReadRepository` gates every query on an
  audio-content-file `EXISTS`; `ebookFile` is always `null` and the `/items/:id/ebook` routes are
  absent. ABS ereader clients see an audiobook-only subset of the library.
- **`titleIgnorePrefix` / `nameIgnorePrefix` don't move articles** ("The …" sorts under T).
- **Socket surface is the client-critical subset only.** Implemented: `auth`/`init`/`auth_failed`,
  `ping`/`pong`, `user_item_progress_updated`, `user_session_closed`, `stream_reset`, item/library
  added/updated/removed. Missing vs `SocketAuthority`: `user_online`/`user_offline` presence
  (`init.usersOnline` is always `[]`), `user_updated`, scan/task/backup progress events,
  `admin_message`, cover-search events.
- **No user `extraData`** (`seriesHideFromContinueListening` etc.) — blocks the series-level
  continue-listening routes above.
- Parked data oddities (from the debug log): `li_385` is an authorless book with an empty title;
  pre-existing `architecture-boundaries.test.ts` failure (abs-session/abs-bookmark/abs-progress
  inject DB directly) needs its own cleanup.

## Notes

- Counts are documented-route counts from `ENDPOINTS.md`, not a commitment to ship all of them.
- Reconcile this list with `COVERAGE.md` (doc coverage) and the planning docs to split
  "deferred by design" (much of the admin/server-management surface) from "genuinely pending."
