# Audiobookshelf API — Endpoint Reference

Per-domain reference for every route in `server/routers/ApiRouter.js`, `HlsRouter.js`,
`PublicRouter.js`, and the auth/discovery routes. Read alongside
[`REIMPLEMENTATION_GUIDE.md`](./REIMPLEMENTATION_GUIDE.md) (contracts) and
[`COVERAGE.md`](./COVERAGE.md) (completeness matrix).

**Legend** — **Auth column:** `none` = unauthenticated · `jwt` = any valid user token · `admin` =
admin/root · `owner` = owner-of-resource or admin · `key` = covered by API key too. **★** = client-
critical (needed for a working mobile/web client). All `/api/*` routes require `jwt` unless noted.

> **Permission middleware note.** Many controllers gate writes on user permissions
> (`canUpdate`, `canDelete`, `canDownload`, `canUpload`, `canAccessExplicitContent`) and gate
> admin-only reads/writes via a per-controller `middleware`/`adminMiddleware`. Non-admins typically
> get `403`, but some admin reads return `404` to avoid leaking existence (noted inline).

---

## 0. Discovery & auth (router root — NOT under `/api`)

| ★   | Method | Path                           | Auth                         | Purpose                                                                   |
| --- | ------ | ------------------------------ | ---------------------------- | ------------------------------------------------------------------------- |
|     | GET    | `/ping`                        | none                         | `{ success:true }` liveness                                               |
|     | GET    | `/healthcheck`                 | none                         | `200` empty                                                               |
| ★   | GET    | `/status`                      | none                         | server identity + `isInit` + auth methods                                 |
| ★   | POST   | `/init`                        | none                         | create first root user (only when `!isInit`, else 500)                    |
| ★   | POST   | `/login`                       | none (rate-limited)          | local login; `x-return-tokens:true` ⇒ tokens in body, else refresh cookie |
| ★   | POST   | `/auth/refresh`                | refresh token (rate-limited) | rotate tokens; cookie or `x-refresh-token` header                         |
| ★   | POST   | `/logout`                      | jwt                          | destroy session, clear cookie, returns `{ redirect_url }`                 |
|     | GET    | `/auth/openid`                 | none (rate-limited)          | begin OIDC, redirect to provider                                          |
|     | GET    | `/auth/openid/callback`        | none                         | OIDC code exchange                                                        |
|     | GET    | `/auth/openid/mobile-redirect` | none                         | bounce to `audiobookshelf://oauth`                                        |
|     | GET    | `/auth/openid/config`          | admin                        | read provider `.well-known` config                                        |

See guide §2 for the token lifecycle and §1.3 for discovery payloads.

---

## 1. Libraries — `LibraryController` (`/api/libraries`)

| ★   | Method | Path                                   | Auth            | Purpose                                                                            |
| --- | ------ | -------------------------------------- | --------------- | ---------------------------------------------------------------------------------- |
|     | POST   | `/libraries`                           | admin           | create library                                                                     |
| ★   | GET    | `/libraries`                           | jwt             | list libraries                                                                     |
| ★   | GET    | `/libraries/:id`                       | jwt             | get one (`?include=filterdata`)                                                    |
|     | PATCH  | `/libraries/:id`                       | admin           | update                                                                             |
|     | DELETE | `/libraries/:id`                       | admin           | delete                                                                             |
| ★   | GET    | `/libraries/:id/items`                 | jwt             | **primary browse** — `limit/page/sort/desc/filter/minified/collapseseries/include` |
|     | DELETE | `/libraries/:id/issues`                | admin           | remove missing/invalid items                                                       |
|     | GET    | `/libraries/:id/episode-downloads`     | jwt             | podcast download queue                                                             |
| ★   | GET    | `/libraries/:id/series`                | jwt             | series in library (paginated)                                                      |
|     | GET    | `/libraries/:id/series/:seriesId`      | jwt             | one series                                                                         |
| ★   | GET    | `/libraries/:id/collections`           | jwt             | collections                                                                        |
| ★   | GET    | `/libraries/:id/playlists`             | jwt             | user playlists                                                                     |
| ★   | GET    | `/libraries/:id/personalized`          | jwt             | **home-screen shelves**                                                            |
| ★   | GET    | `/libraries/:id/filterdata`            | jwt             | valid filter values/ids (genres, tags, authors, narrators…)                        |
| ★   | GET    | `/libraries/:id/search`                | jwt             | search within library (`?q=`)                                                      |
|     | GET    | `/libraries/:id/stats`                 | jwt             | library stats                                                                      |
|     | GET    | `/libraries/:id/authors`               | jwt             | authors list                                                                       |
|     | GET    | `/libraries/:id/narrators`             | jwt             | narrators list                                                                     |
|     | PATCH  | `/libraries/:id/narrators/:narratorId` | admin           | rename narrator                                                                    |
|     | DELETE | `/libraries/:id/narrators/:narratorId` | admin           | remove narrator                                                                    |
|     | GET    | `/libraries/:id/matchall`              | admin           | match all items to metadata providers                                              |
|     | POST   | `/libraries/:id/scan`                  | admin           | trigger scan                                                                       |
| ★   | GET    | `/libraries/:id/recent-episodes`       | jwt             | podcast "latest" shelf                                                             |
|     | GET    | `/libraries/:id/opml`                  | jwt             | export podcasts as OPML                                                            |
|     | POST   | `/libraries/order`                     | admin           | reorder libraries                                                                  |
|     | POST   | `/libraries/:id/remove-metadata`       | admin           | delete metadata files                                                              |
|     | GET    | `/libraries/:id/podcast-titles`        | jwt             | podcast title list                                                                 |
|     | GET    | `/libraries/:id/download`              | jwt+canDownload | zip-download multiple items                                                        |

Browse response envelope & filter encoding: guide §4.1–4.2.

---

## 2. Library items — `LibraryItemController` (/api/items) ★ core

| ★   | Method | Path                               | Auth                          | Purpose                                 |
| --- | ------ | ---------------------------------- | ----------------------------- | --------------------------------------- |
|     | POST   | `/items/batch/delete`              | admin+canDelete               | delete many                             |
|     | POST   | `/items/batch/update`              | jwt+canUpdate                 | update many                             |
| ★   | POST   | `/items/batch/get`                 | jwt                           | fetch many by id                        |
|     | POST   | `/items/batch/quickmatch`          | admin                         | quick-match many                        |
|     | POST   | `/items/batch/scan`                | admin                         | scan many                               |
| ★   | GET    | `/items/:id`                       | jwt                           | item detail (`?expanded=1&include=...`) |
|     | DELETE | `/items/:id`                       | admin+canDelete               | delete item                             |
|     | GET    | `/items/:id/download`              | jwt+canDownload               | download item (zip)                     |
|     | PATCH  | `/items/:id/media`                 | jwt+canUpdate                 | update media metadata                   |
| ★   | GET    | `/items/:id/cover`                 | **none** (GET in ignore list) | cover image; `?token=&raw=1&ts=`        |
|     | POST   | `/items/:id/cover`                 | jwt+canUpload                 | upload cover                            |
|     | PATCH  | `/items/:id/cover`                 | jwt+canUpdate                 | set cover by url/path                   |
|     | DELETE | `/items/:id/cover`                 | jwt+canUpdate                 | remove cover                            |
|     | POST   | `/items/:id/match`                 | jwt+canUpdate                 | match to metadata provider              |
| ★   | POST   | `/items/:id/play`                  | jwt                           | **start playback session** (book)       |
| ★   | POST   | `/items/:id/play/:episodeId`       | jwt                           | start playback (podcast episode)        |
|     | PATCH  | `/items/:id/tracks`                | jwt+canUpdate                 | reorder/update tracks                   |
|     | POST   | `/items/:id/scan`                  | admin                         | rescan item                             |
|     | GET    | `/items/:id/metadata-object`       | jwt                           | computed metadata object                |
|     | POST   | `/items/:id/chapters`              | jwt+canUpdate                 | update chapters                         |
|     | GET    | `/items/:id/ffprobe/:fileid`       | admin                         | raw ffprobe data                        |
| ★   | GET    | `/items/:id/file/:fileid`          | jwt                           | stream a file (inline)                  |
|     | DELETE | `/items/:id/file/:fileid`          | admin+canDelete               | delete a file                           |
| ★   | GET    | `/items/:id/file/:fileid/download` | jwt+canDownload               | download a file                         |
|     | GET    | `/items/:id/ebook/:fileid?`        | jwt                           | ebook file                              |
|     | PATCH  | `/items/:id/ebook/:fileid/status`  | jwt+canUpdate                 | set ebook as primary/etc.               |

Play request/response (direct vs transcode): guide §5.

---

## 3. Current user — `MeController` (/api/me) ★ core

| ★   | Method | Path                                                     | Auth               | Purpose                                                           |
| --- | ------ | -------------------------------------------------------- | ------------------ | ----------------------------------------------------------------- |
| ★   | GET    | `/me`                                                    | jwt                | current user object (incl. mediaProgress, bookmarks, permissions) |
|     | GET    | `/me/listening-sessions`                                 | jwt                | paginated history (`itemsPerPage/page`)                           |
|     | GET    | `/me/item/listening-sessions/:libraryItemId/:episodeId?` | jwt                | sessions for one item                                             |
|     | GET    | `/me/listening-stats`                                    | jwt                | aggregate stats                                                   |
|     | GET    | `/me/progress/:id/remove-from-continue-listening`        | jwt                | hide from Continue                                                |
| ★   | GET    | `/me/progress/:id/:episodeId?`                           | jwt                | get one MediaProgress                                             |
| ★   | PATCH  | `/me/progress/batch/update`                              | jwt                | upsert many progresses                                            |
| ★   | PATCH  | `/me/progress/:libraryItemId/:episodeId?`                | jwt                | **upsert one MediaProgress**                                      |
|     | DELETE | `/me/progress/:id`                                       | jwt                | delete progress                                                   |
|     | POST   | `/me/item/:id/bookmark`                                  | jwt                | create bookmark                                                   |
|     | PATCH  | `/me/item/:id/bookmark`                                  | jwt                | update bookmark                                                   |
|     | DELETE | `/me/item/:id/bookmark/:time`                            | jwt                | remove bookmark                                                   |
|     | PATCH  | `/me/password`                                           | jwt (rate-limited) | change own password                                               |
| ★   | GET    | `/me/items-in-progress`                                  | jwt                | Continue-listening shelf                                          |
|     | GET    | `/me/series/:id/remove-from-continue-listening`          | jwt                | hide series                                                       |
|     | GET    | `/me/series/:id/readd-to-continue-listening`             | jwt                | unhide series                                                     |
|     | GET    | `/me/stats/year/:year`                                   | jwt                | year-in-review stats                                              |
|     | POST   | `/me/ereader-devices`                                    | jwt                | update user's e-reader devices                                    |

Progress semantics: guide §7.

---

## 4. Sessions — `SessionController` (/api/sessions, /api/session) ★ core

| ★   | Method | Path                     | Auth                     | Purpose                                                                   |
| --- | ------ | ------------------------ | ------------------------ | ------------------------------------------------------------------------- |
|     | GET    | `/sessions`              | admin (404 to non-admin) | all sessions w/ user data, paginated (`itemsPerPage/page/sort/desc/user`) |
|     | DELETE | `/sessions/:id`          | jwt+canDelete            | delete a session                                                          |
|     | GET    | `/sessions/open`         | admin (404)              | open in-memory sessions + share sessions                                  |
|     | POST   | `/sessions/batch/delete` | admin                    | delete many (`{ sessions:[id] }`)                                         |
| ★   | POST   | `/session/local`         | jwt                      | sync **one** offline session                                              |
| ★   | POST   | `/session/local-all`     | jwt                      | sync many offline sessions ⇒ `{ results:[...] }`                          |
| ★   | GET    | `/session/:id`           | owner/admin              | get open session                                                          |
| ★   | POST   | `/session/:id/sync`      | owner/admin              | sync `{ currentTime, timeListened, duration? }` ⇒ 200/500                 |
| ★   | POST   | `/session/:id/close`     | owner/admin              | close (optional final sync body)                                          |

Open-session middleware (owner-or-admin) + offline merge rule: guide §7.2–7.3.

---

## 5. Playback streaming — HLS & public

| ★   | Method | Path                               | Auth                   | Purpose                                         |
| --- | ------ | ---------------------------------- | ---------------------- | ----------------------------------------------- |
| ★   | GET    | `/hls/:stream/:file`               | stream id must be open | HLS `.m3u8`/`.ts`; emits `stream_reset` on seek |
| ★   | GET    | `/public/session/:id/track/:index` | open session           | stream a direct audio track                     |
|     | GET    | `/public/share/:slug`              | none                   | media-item share landing                        |
|     | GET    | `/public/share/:slug/track/:index` | none                   | share audio track                               |
|     | GET    | `/public/share/:slug/cover`        | none                   | share cover                                     |
|     | GET    | `/public/share/:slug/download`     | none                   | download shared item                            |
|     | PATCH  | `/public/share/:slug/progress`     | none (share session)   | update share playback progress                  |

HLS seek/reset behavior: guide §5.3.

---

## 6. Collections — `CollectionController` (/api/collections)

| Method | Path                            | Auth          | Purpose               |
| ------ | ------------------------------- | ------------- | --------------------- |
| POST   | `/collections`                  | jwt+canUpdate | create                |
| GET    | `/collections`                  | jwt           | all (access-filtered) |
| GET    | `/collections/:id`              | jwt           | one                   |
| PATCH  | `/collections/:id`              | jwt+canUpdate | update                |
| DELETE | `/collections/:id`              | jwt+canUpdate | delete                |
| POST   | `/collections/:id/book`         | jwt+canUpdate | add book              |
| DELETE | `/collections/:id/book/:bookId` | jwt+canUpdate | remove book           |
| POST   | `/collections/:id/batch/add`    | jwt+canUpdate | add many              |
| POST   | `/collections/:id/batch/remove` | jwt+canUpdate | remove many           |

## 7. Playlists — `PlaylistController` (/api/playlists)

| ★   | Method | Path                                             | Auth  | Purpose                |
| --- | ------ | ------------------------------------------------ | ----- | ---------------------- |
| ★   | POST   | `/playlists`                                     | jwt   | create                 |
| ★   | GET    | `/playlists`                                     | jwt   | all for user           |
|     | GET    | `/playlists/:id`                                 | owner | one                    |
|     | PATCH  | `/playlists/:id`                                 | owner | update                 |
|     | DELETE | `/playlists/:id`                                 | owner | delete                 |
|     | POST   | `/playlists/:id/item`                            | owner | add item               |
|     | DELETE | `/playlists/:id/item/:libraryItemId/:episodeId?` | owner | remove item            |
|     | POST   | `/playlists/:id/batch/add`                       | owner | add many               |
|     | POST   | `/playlists/:id/batch/remove`                    | owner | remove many            |
|     | POST   | `/playlists/collection/:collectionId`            | jwt   | create from collection |

## 8. Authors — `AuthorController` (/api/authors)

| Method | Path                 | Auth                          | Purpose                           |
| ------ | -------------------- | ----------------------------- | --------------------------------- |
| GET    | `/authors/:id`       | jwt                           | one (`?include=items,series`)     |
| PATCH  | `/authors/:id`       | jwt+canUpdate                 | update                            |
| DELETE | `/authors/:id`       | admin                         | delete                            |
| POST   | `/authors/:id/match` | jwt+canUpdate                 | match metadata                    |
| GET    | `/authors/:id/image` | **none** (GET in ignore list) | author image; `?token=&raw=1&ts=` |
| POST   | `/authors/:id/image` | jwt+canUpdate                 | upload image                      |
| DELETE | `/authors/:id/image` | jwt+canUpdate                 | remove image                      |

## 9. Series — `SeriesController` (/api/series)

| Method | Path          | Auth          | Purpose                           |
| ------ | ------------- | ------------- | --------------------------------- |
| GET    | `/series/:id` | jwt           | one (`?include=progress,rssfeed`) |
| PATCH  | `/series/:id` | jwt+canUpdate | update                            |

## 10. Podcasts — `PodcastController` (/api/podcasts)

| Method | Path                               | Auth            | Purpose                         |
| ------ | ---------------------------------- | --------------- | ------------------------------- |
| POST   | `/podcasts`                        | admin           | create podcast from feed        |
| POST   | `/podcasts/feed`                   | jwt             | parse a feed URL                |
| POST   | `/podcasts/opml/parse`             | jwt             | parse OPML text                 |
| POST   | `/podcasts/opml/create`            | admin           | bulk-create from OPML feed urls |
| GET    | `/podcasts/:id/checknew`           | admin           | check for new episodes          |
| GET    | `/podcasts/:id/downloads`          | jwt             | episode download queue          |
| GET    | `/podcasts/:id/clear-queue`        | admin           | clear download queue            |
| GET    | `/podcasts/:id/search-episode`     | admin           | find an episode                 |
| POST   | `/podcasts/:id/download-episodes`  | admin           | queue episode downloads         |
| POST   | `/podcasts/:id/match-episodes`     | admin           | quick-match episodes            |
| GET    | `/podcasts/:id/episode/:episodeId` | jwt             | one episode                     |
| PATCH  | `/podcasts/:id/episode/:episodeId` | jwt+canUpdate   | update episode                  |
| DELETE | `/podcasts/:id/episode/:episodeId` | admin+canDelete | remove episode                  |

## 11. Users — `UserController` (/api/users) — admin

| Method | Path                            | Auth  | Purpose                             |
| ------ | ------------------------------- | ----- | ----------------------------------- |
| POST   | `/users`                        | admin | create user                         |
| GET    | `/users`                        | admin | list users                          |
| GET    | `/users/online`                 | jwt   | online users (from socket presence) |
| GET    | `/users/:id`                    | admin | one user                            |
| PATCH  | `/users/:id`                    | admin | update                              |
| DELETE | `/users/:id`                    | admin | delete                              |
| PATCH  | `/users/:id/openid-unlink`      | admin | unlink OIDC                         |
| GET    | `/users/:id/listening-sessions` | admin | user's history                      |
| GET    | `/users/:id/listening-stats`    | admin | user's stats                        |

## 12. Notifications — `NotificationController` (/api/notifications) — admin

| Method | Path                      | Auth  | Purpose                             |
| ------ | ------------------------- | ----- | ----------------------------------- |
| GET    | `/notifications`          | admin | settings + configured notifications |
| PATCH  | `/notifications`          | admin | update settings                     |
| GET    | `/notificationdata`       | admin | available events/variables          |
| GET    | `/notifications/test`     | admin | fire a test event                   |
| POST   | `/notifications`          | admin | create a notification               |
| DELETE | `/notifications/:id`      | admin | delete                              |
| PATCH  | `/notifications/:id`      | admin | update one                          |
| GET    | `/notifications/:id/test` | admin | send test for one                   |

## 13. Emails / e-reader — `EmailController` (/api/emails) — admin

| Method | Path                           | Auth  | Purpose                   |
| ------ | ------------------------------ | ----- | ------------------------- |
| GET    | `/emails/settings`             | admin | SMTP settings             |
| PATCH  | `/emails/settings`             | admin | update settings           |
| POST   | `/emails/test`                 | admin | send test email           |
| POST   | `/emails/ereader-devices`      | admin | manage e-reader devices   |
| POST   | `/emails/send-ebook-to-device` | jwt   | send an ebook to a device |

## 14. Search (providers) — `SearchController` (/api/search)

| Method | Path                | Auth | Purpose                 |
| ------ | ------------------- | ---- | ----------------------- |
| GET    | `/search/covers`    | jwt  | search cover images     |
| GET    | `/search/books`     | jwt  | search book metadata    |
| GET    | `/search/podcast`   | jwt  | search podcasts         |
| GET    | `/search/authors`   | jwt  | search authors          |
| GET    | `/search/chapters`  | jwt  | search chapters         |
| GET    | `/search/providers` | jwt  | list metadata providers |

## 15. RSS feeds — `RSSFeedController` (/api/feeds)

| Method | Path                                   | Auth            | Purpose                  |
| ------ | -------------------------------------- | --------------- | ------------------------ |
| GET    | `/feeds`                               | admin           | open feeds               |
| POST   | `/feeds/item/:itemId/open`             | jwt+canDownload | open feed for item       |
| POST   | `/feeds/collection/:collectionId/open` | jwt+canDownload | open feed for collection |
| POST   | `/feeds/series/:seriesId/open`         | jwt+canDownload | open feed for series     |
| POST   | `/feeds/:id/close`                     | admin           | close feed               |

## 16. Shares — `ShareController` (/api/share + /public/share)

| Method                              | Path                   | Auth | Purpose               |
| ----------------------------------- | ---------------------- | ---- | --------------------- |
| POST                                | `/share/mediaitem`     | jwt  | create a public share |
| DELETE                              | `/share/mediaitem/:id` | jwt  | delete a share        |
| (public `/public/share/*` — see §5) |                        |      |                       |

## 17. Tools — `ToolsController` (/api/tools) — admin

| Method | Path                             | Auth              | Purpose                   |
| ------ | -------------------------------- | ----------------- | ------------------------- |
| POST   | `/tools/item/:id/encode-m4b`     | admin+canDownload | encode item to M4B        |
| DELETE | `/tools/item/:id/encode-m4b`     | admin+canDownload | cancel encode             |
| POST   | `/tools/item/:id/embed-metadata` | admin+canUpdate   | embed metadata into audio |
| POST   | `/tools/batch/embed-metadata`    | admin+canUpdate   | batch embed               |

## 18. Backups — `BackupController` (/api/backups) — admin

| Method | Path                    | Auth  | Purpose           |
| ------ | ----------------------- | ----- | ----------------- |
| GET    | `/backups`              | admin | list              |
| POST   | `/backups`              | admin | create            |
| DELETE | `/backups/:id`          | admin | delete            |
| GET    | `/backups/:id/download` | admin | download          |
| GET    | `/backups/:id/apply`    | admin | restore           |
| POST   | `/backups/upload`       | admin | upload backup     |
| PATCH  | `/backups/path`         | admin | change backup dir |

## 19. API keys — `ApiKeyController` (/api/api-keys) — admin

| Method | Path            | Auth  | Purpose                           |
| ------ | --------------- | ----- | --------------------------------- |
| GET    | `/api-keys`     | admin | list keys                         |
| POST   | `/api-keys`     | admin | create key (returns the JWT once) |
| PATCH  | `/api-keys/:id` | admin | update                            |
| DELETE | `/api-keys/:id` | admin | delete                            |

## 20. Custom metadata providers — (/api/custom-metadata-providers) — admin

| Method | Path                             | Auth  | Purpose |
| ------ | -------------------------------- | ----- | ------- |
| GET    | `/custom-metadata-providers`     | admin | list    |
| POST   | `/custom-metadata-providers`     | admin | create  |
| DELETE | `/custom-metadata-providers/:id` | admin | delete  |

## 21. Filesystem — `FileSystemController` (/api/filesystem) — admin

| Method | Path                     | Auth  | Purpose             |
| ------ | ------------------------ | ----- | ------------------- |
| GET    | `/filesystem`            | admin | list server paths   |
| POST   | `/filesystem/pathexists` | admin | check a path exists |

## 22. Cache — `CacheController` (/api/cache) — admin

| Method | Path                 | Auth  | Purpose          |
| ------ | -------------------- | ----- | ---------------- |
| POST   | `/cache/purge`       | admin | purge all cache  |
| POST   | `/cache/items/purge` | admin | purge item cache |

## 23. Stats — `StatsController` (/api/stats) — admin

| Method | Path                | Auth  | Purpose           |
| ------ | ------------------- | ----- | ----------------- |
| GET    | `/stats/year/:year` | admin | server year stats |
| GET    | `/stats/server`     | admin | server stats      |

## 24. Misc / settings — `MiscController` (/api)

| Method | Path                | Auth               | Purpose                             |
| ------ | ------------------- | ------------------ | ----------------------------------- |
| POST   | `/upload`           | jwt+canUpload      | upload media files                  |
| GET    | `/tasks`            | jwt                | running/finished tasks              |
| PATCH  | `/settings`         | admin              | update server settings              |
| PATCH  | `/sorting-prefixes` | admin              | update sort-ignore prefixes         |
| POST   | `/authorize`        | jwt (rate-limited) | re-fetch login payload from a token |
| GET    | `/tags`             | jwt                | all tags                            |
| POST   | `/tags/rename`      | admin              | rename tag                          |
| DELETE | `/tags/:tag`        | admin              | delete tag                          |
| GET    | `/genres`           | jwt                | all genres                          |
| POST   | `/genres/rename`    | admin              | rename genre                        |
| DELETE | `/genres/:genre`    | admin              | delete genre                        |
| POST   | `/validate-cron`    | admin              | validate a cron expr                |
| GET    | `/auth-settings`    | admin              | auth config                         |
| PATCH  | `/auth-settings`    | admin              | update auth config                  |
| POST   | `/watcher/update`   | admin              | force watcher rescan path           |
| GET    | `/logger-data`      | admin              | recent logs                         |

> `POST /api/authorize` is how a client with only a token re-derives the full login payload
> (user + serverSettings + libraries) without re-authenticating — useful after a token refresh.
