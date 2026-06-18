# API Documentation Coverage Matrix

Tracks every route group against two documentation sources:

- **Markdown** = documented in [`ENDPOINTS.md`](./ENDPOINTS.md) + [`REIMPLEMENTATION_GUIDE.md`](./REIMPLEMENTATION_GUIDE.md) (this set).
- **OpenAPI** = present in the maintained spec under `docs/` (`root.yaml` → `controllers/*.yaml`).

## How this was verified

The authoritative route list comes from the routers, not the OpenAPI spec:

```bash
# 197 /api routes:
grep -nE "this\.router\.(get|post|patch|delete|put)\('" server/routers/ApiRouter.js
# HLS + public:
grep -nE "this\.router\.(get|post|patch|delete|put)\('" server/routers/HlsRouter.js server/routers/PublicRouter.js
# auth/discovery routes:  server/Auth.js (initAuthRoutes) + server/Server.js (/init,/status,/ping,/healthcheck)
```

Counts: **197** `/api/*` routes + **1** HLS + **6** public + **11** auth/discovery ≈ **215 total**
(4 discovery: `/ping` `/healthcheck` `/status` `/init`; 7 auth: `/login` `/auth/refresh` `/logout`
`/auth/openid` `/auth/openid/callback` `/auth/openid/mobile-redirect` `/auth/openid/config`).
All are listed in `ENDPOINTS.md`.

## Controller-level coverage

| Domain / Controller                       |              Routes | Markdown | OpenAPI (existing) |  Client-critical  |
| ----------------------------------------- | ------------------: | :------: | :----------------: | :---------------: |
| Discovery + Auth (`Auth`,`Server`)        |                  11 |    ✅    |         ❌         |         ★         |
| Libraries (`LibraryController`)           |                  28 |    ✅    |     ⚠️ partial     |         ★         |
| Library items (`LibraryItemController`)   |                  26 |    ✅    |         ❌         |         ★         |
| Current user (`MeController`)             |                  18 |    ✅    |         ❌         |         ★         |
| Sessions (`SessionController`)            | 9 (+1 public track) |    ✅    |         ❌         |         ★         |
| HLS (`HlsRouter`)                         |                   1 |    ✅    |         ❌         |         ★         |
| Public (`PublicRouter`/`ShareController`) |                   6 |    ✅    |         ❌         | ★ (session track) |
| Collections (`CollectionController`)      |                   9 |    ✅    |         ❌         |                   |
| Playlists (`PlaylistController`)          |                  10 |    ✅    |         ❌         |     ★ (list)      |
| Authors (`AuthorController`)              |                   7 |    ✅    |         ✅         |                   |
| Series (`SeriesController`)               |                   2 |    ✅    |         ✅         |                   |
| Podcasts (`PodcastController`)            |                  13 |    ✅    |         ✅         |                   |
| Users (`UserController`)                  |                   9 |    ✅    |         ❌         |                   |
| Notifications (`NotificationController`)  |                   8 |    ✅    |         ✅         |                   |
| Emails (`EmailController`)                |                   5 |    ✅    |         ✅         |                   |
| Search (`SearchController`)               |                   6 |    ✅    |         ❌         |                   |
| RSS feeds (`RSSFeedController`)           |                   5 |    ✅    |         ❌         |                   |
| Shares (`ShareController`)                |       2 (+4 public) |    ✅    |         ❌         |                   |
| Tools (`ToolsController`)                 |                   4 |    ✅    |         ❌         |                   |
| Backups (`BackupController`)              |                   7 |    ✅    |         ❌         |                   |
| API keys (`ApiKeyController`)             |                   4 |    ✅    |         ❌         |                   |
| Custom metadata providers                 |                   3 |    ✅    |         ❌         |                   |
| Filesystem (`FileSystemController`)       |                   2 |    ✅    |         ❌         |                   |
| Cache (`CacheController`)                 |                   2 |    ✅    |         ❌         |                   |
| Stats (`StatsController`)                 |                   2 |    ✅    |         ❌         |                   |
| Misc/settings (`MiscController`)          |                  17 |    ✅    |         ❌         |                   |

**Legend:** ✅ documented · ⚠️ partial · ❌ not present · ★ client-critical.

### OpenAPI spec status

The repo's existing OpenAPI project (`docs/root.yaml`, bundled to `docs/openapi.json`) ships
per-controller YAML for **6** controllers only: `AuthorController`, `EmailController`,
`LibraryController` (partial), `NotificationController`, `PodcastController`, `SeriesController`.
The **client-critical** controllers (`LibraryItemController`, `MeController`, `SessionController`),
the auth/token routes, HLS, and the Socket.IO contract are **absent** from the spec. This markdown
set fills those gaps; extending the OpenAPI YAML for machine consumption is a separate, mechanical
follow-up (see below).

## Re-implementation completeness (client-critical) — all ✅

Every endpoint and event needed for a working client is documented in the markdown set:

- ✅ Discovery `/status` `/ping` `/init`
- ✅ Auth `/login` `/auth/refresh` `/logout` (+ token lifecycle, grace-window rotation)
- ✅ `/api/me`, `/api/libraries`, `/api/libraries/:id`
- ✅ Browse `/libraries/:id/items` `/personalized` `/filterdata` `/search` `/series` `/collections` `/recent-episodes`
- ✅ Item detail `/items/:id`, cover `/items/:id/cover`
- ✅ Playback `/items/:id/play(/:episodeId)` (direct vs transcode)
- ✅ Streaming `/hls/:stream/:file` (+ `stream_reset`), `/public/session/:id/track/:index`
- ✅ Sync `/session/:id/sync` `/close`, `/me/progress/...`, `/session/local-all` (merge rule)
- ✅ Socket: `auth`→`init`, `user_item_progress_updated`, `user_session_closed`, `stream_reset`, `item_*`

## Follow-up: extending the OpenAPI YAML (optional, for tooling)

If machine-readable specs are wanted (codegen, mock servers, contract tests), extend the existing
exploded redocly project in priority order:

1. `LibraryItemController.yaml`, `MeController.yaml`, `SessionController.yaml` (client-critical)
2. Object schemas not yet in `docs/objects/`: **PlaybackSession**, **MediaProgress**, **DeviceInfo**
3. `CollectionController`, `PlaylistController`, `SearchController`, `ShareController`
4. Admin-only controllers last

Method: add `controllers/<Name>.yaml`, reference shared schemas from `docs/objects/*` and
`docs/schemas.yaml`, register each path in `docs/root.yaml`, then rebuild per `docs/README.md`:

```bash
cd docs
npx @redocly/cli bundle root.yaml > bundled.yaml
npx yq -p yaml -o json bundled.yaml > openapi.json
npx @redocly/cli lint root.yaml
```

Validate request/response shapes at runtime with the `wiretap` tool (noted in `docs/README.md`)
against a live server while driving the official client.
