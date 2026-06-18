# Audiobookshelf API — Re-implementation Guide

> **Purpose.** This document describes the Audiobookshelf (ABS) server API as a _contract_ — enough
> to re-implement a server that the existing ABS clients (official mobile apps and the web client)
> can connect to unmodified. It covers the parts the machine-readable OpenAPI spec (`docs/openapi.json`)
> cannot express: the auth/token lifecycle, the playback-session state machine, HLS streaming, the
> Socket.IO event contract, progress/offline-sync semantics, and the query/error conventions.
>
> **Source of truth.** Every claim here is traced to server code. Routes live in
> `server/routers/ApiRouter.js` (the canonical list), `server/routers/HlsRouter.js`,
> `server/routers/PublicRouter.js`, and `server/Auth.js`. When in doubt, the code wins.
>
> **Companion files:** [`ENDPOINTS.md`](./ENDPOINTS.md) (per-domain endpoint reference) and
> [`COVERAGE.md`](./COVERAGE.md) (route → handler → documented matrix). Server version documented
> against: see `package.json` `version` (v2.35.x line).

---

## 1. Overview & conventions

### 1.1 Route mounting

The Express app mounts three routers plus auth/discovery routes at the **router base path** (default
empty; configurable via `RouterBasePath` for reverse-proxy sub-path hosting). See `server/Server.js:286-369`.

| Prefix                                      | Router                | Auth                                     | Notes                                        |
| ------------------------------------------- | --------------------- | ---------------------------------------- | -------------------------------------------- |
| `/api/*`                                    | `ApiRouter`           | JWT required (except 2 image GETs)       | The bulk of the API, ~197 routes             |
| `/hls/*`                                    | `HlsRouter`           | token in stream path                     | HLS transcode segments/playlists             |
| `/public/*`                                 | `PublicRouter`        | per-resource (share slug / open session) | Shares + open-session track streaming        |
| `/login`, `/logout`, `/auth/*`              | `Auth.initAuthRoutes` | n/a                                      | **Mounted at router root, NOT under `/api`** |
| `/init`, `/status`, `/ping`, `/healthcheck` | `Server.js`           | none                                     | Discovery / first-run                        |
| `/feed/:slug*`                              | `Server.js`           | none                                     | RSS feed serving                             |

> ⚠️ **Critical for compatibility:** auth and discovery routes are **not** under `/api`. A client
> POSTs to `/login`, not `/api/login`.

**Reverse-proxy base path.** If `RouterBasePath` is set, every request URL is rewritten to include
the prefix (`Server.js:289-299`), and `req.originalHostPrefix` (`{protocol}://{host}{prefix}`) is used
when building absolute URLs (e.g. RSS feeds). A re-implementation hosting under a sub-path must
replicate this so client-built URLs resolve.

### 1.2 Body parsing limits

- `express.urlencoded({ extended: true, limit: '5mb' })`
- `express.json({ limit: '10mb' })` (skipped for `/internal-api`)
- File uploads via `express-fileupload` with temp files (`Server.js:305-316`).

### 1.3 Discovery handshake

A client bootstraps by calling these **before** authenticating:

- `GET /ping` → `{ "success": true }`. Liveness only.
- `GET /healthcheck` → `200` empty. For load balancers.
- `GET /status` → server identity + init state. The client uses this to decide whether to show the
  first-run "create root user" screen and which auth methods to offer:

```jsonc
{
  "app": "audiobookshelf",
  "serverVersion": "2.35.1",
  "isInit": true, // false => no root user yet
  "language": "en-us",
  "authMethods": ["local"], // subset of: local, openid
  "authFormData": {
    /* openid button text etc. */
  },
  // only when !isInit:
  "ConfigPath": "/config",
  "MetadataPath": "/metadata",
}
```

- `POST /init` → only valid when `isInit === false` (no root user). Creates the first admin user.
  Returns `500` if a root user already exists. (`Server.js:341-364`.)

---

## 2. Authentication & token lifecycle

ABS uses **JWT access tokens + opaque-rotating refresh tokens**, with two transport modes (web
cookies vs mobile headers), plus **API keys** and **OIDC**. Implementation: `server/Auth.js`,
`server/auth/TokenManager.js`, `server/auth/LocalAuthStrategy.js`, `server/auth/OidcAuthStrategy.js`.

### 2.1 Tokens at a glance

| Token       | Lifetime                           | Signed payload (JWT)                              | Where stored                                                                                                    |
| ----------- | ---------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Access**  | 1h (`ACCESS_TOKEN_EXPIRY`, secs)   | `{ userId, username, jti, type: "access", exp }`  | client memory; sent as `Authorization: Bearer`                                                                  |
| **Refresh** | 30d (`REFRESH_TOKEN_EXPIRY`, secs) | `{ userId, username, jti, type: "refresh", exp }` | web: httpOnly `refresh_token` cookie; mobile: client storage; **server also persists it in a `Session` DB row** |
| **API key** | configurable / none                | `{ userId?, keyId, type: "api", exp? }`           | created via `/api/api-keys`; sent as Bearer                                                                     |

- Secret: `JWT_SECRET_KEY` env var, else auto-generated 256-byte base64 stored in server settings
  (`TokenManager.initTokenSecret`). HS256.
- JWT is accepted from the `Authorization: Bearer` header **or** a `?token=` query param
  (`Auth.js:126`, `ExtractJwt.fromUrlQueryParameter('token')`). The query-param form is how
  `<img>`/`<audio>` tags authenticate (covers, tracks).
- Expiration is checked **manually** in `jwtAuthCheck` (`ignoreExpiration: true` on the strategy),
  so that expired API keys can be deactivated as a side effect (`TokenManager.js:255-313`).

> 🔎 **Legacy tokens.** Old clients may present a JWT with **no `exp`** (the deprecated
> `generateAccessToken`). The server still accepts these and flags `user.isOldToken`. A
> re-implementation should accept non-expiring legacy access tokens if it must serve old app builds,
> otherwise it can reject tokens without `type`/`exp`.

### 2.2 Local login — `POST /login`

Rate-limited (`authRateLimiter`). Passport `local` strategy validates `{ username, password }`.
On success the server calls `handleLoginSuccess(req, res, returnTokens)`:

- **Mobile flow:** client sends header `x-return-tokens: true`. Response **body** includes both
  `user.accessToken` and `user.refreshToken`. No cookie is relied upon.
- **Web flow:** no header. `user.refreshToken` in the body is `null`; instead the server sets an
  httpOnly `refresh_token` cookie (`sameSite=lax`, `secure` when behind https) via
  `setRefreshTokenCookie`.

Each login creates a **server-side `Session` row** (`createTokensAndSession`) keyed by the refresh
token, storing IP + user-agent + `expiresAt`.

**Login/refresh response payload** (`Auth.getUserLoginResponsePayload`, `Auth.js:96-105`):

```jsonc
{
  "user": { /* user.toOldJSONForBrowser() */
    "id": "...", "username": "...", "type": "root|admin|user|guest",
    "token": "...",          // legacy non-expiring token (still emitted for old clients)
    "accessToken": "...",    // 1h JWT  (added in handleLoginSuccess)
    "refreshToken": "..."|null, // present only for mobile/api flow
    "mediaProgress": [ /* MediaProgress[] */ ],
    "bookmarks": [...], "permissions": {...}, "librariesAccessible": [...], ...
  },
  "userDefaultLibraryId": "lib_...",
  "serverSettings": { /* ServerSettings.toJSONForBrowser() */ },
  "ereaderDevices": [ /* e-reader device configs visible to user */ ],
  "Source": "docker|..."     // global.Source
}
```

### 2.3 Refresh — `POST /auth/refresh`

Rate-limited. The refresh token is taken from the `refresh_token` **cookie** (web) **or** the
`x-refresh-token` **header** (mobile). If the header is used, the rotated refresh token is returned
in the response body; otherwise it's only set as a cookie. (`Auth.js:329-357`.)

**Rotation with grace period** (`TokenManager.handleRefreshToken` / `rotateTokensForSession`):

1. Verify JWT signature + `type === "refresh"`.
2. Find the `Session` row where `refreshToken == token` **OR** `lastRefreshToken == token`.
3. If it matched `refreshToken`: check DB `expiresAt`; if expired, destroy session → `401`.
   Otherwise rotate: generate new access + refresh tokens, store the **old** refresh token as
   `lastRefreshToken` with a **1-minute grace window** (`lastRefreshTokenExpiresAt`), and `UPDATE`
   the row **only if** `refreshToken` still equals the value we read (optimistic concurrency).
4. If it matched `lastRefreshToken` and we're still inside the grace window: don't rotate again —
   issue a fresh access token and return the _current_ refresh token. (Handles races where a client
   fires two refreshes near-simultaneously.)
5. Concurrency: if the conditional `UPDATE` affects 0 rows, re-read the row and use its current
   tokens.

> 🧠 **Why this matters for re-impl:** mobile clients refresh aggressively and sometimes
> concurrently. Without the `lastRefreshToken` grace window you will spuriously log users out. You
> must persist sessions server-side; pure stateless JWT refresh will not be wire-compatible.

### 2.4 Logout — `POST /logout`

Reads refresh token from cookie or `x-refresh-token` header, clears the `refresh_token` cookie,
**destroys the matching `Session` row** (`invalidateRefreshToken`), runs `req.logout()`, and returns
`{ "redirect_url": <oidc end-session url|null> }`. For OIDC sessions it also clears `openid_id_token`.

### 2.5 API keys

JWTs with `type: "api"` and a `keyId`. On each request `jwtAuthCheck` loads the `ApiKey` row, checks
`isActive`, and if `exp` has passed it **deactivates the key** (`isActive=false`) and denies. The key
resolves to its owning `userId`. Managed via `GET/POST/PATCH/DELETE /api/api-keys` (admin).

> Note: API-key auth is **not** currently supported over the socket connection (see §6.1).

### 2.6 OIDC (OpenID Connect)

Optional, enabled when `authActiveAuthMethods` includes `openid`. Routes (`Auth.js:359-472`):

- `GET /auth/openid` — builds the provider authorize URL, stashes callback/state in short-lived
  cookies (`paramsToCookies`, 2-min TTL). Web callbacks must be **same-origin** (validated).
- `GET /auth/openid/callback` — exchanges the code; supports PKCE `code_verifier` forwarded by the
  client (crucial for mobile). On success behaves per the stored `auth_method` cookie (§2.7).
- `GET /auth/openid/mobile-redirect` — bounces to an app link `audiobookshelf://oauth` for native apps.
- `GET /auth/openid/config?issuer=...` — admin helper to read `.well-known/openid-configuration`.

**`auth_method` cookie** drives callback behavior: `local`, `api` (mobile native login), `openid`
(web), `openid-mobile`. API-based methods (`api`, `openid-mobile`) get tokens in the JSON body;
web methods redirect to the stored callback URL with `?setToken=<legacy>&accessToken=<jwt>&state=...`.

### 2.7 Socket auth handshake

The Socket.IO connection authenticates **separately** from HTTP — see §6.1.

---

## 3. Core data models

These are the shapes clients read. The OpenAPI `docs/objects/*` schemas define the entity bodies
(LibraryItem, Book, Podcast, Author, Series, AudioFile, AudioTrack, metadata, etc.); below are the
client-contract models that are **not** in the spec yet.

### 3.1 PlaybackSession (`server/objects/PlaybackSession.js`)

Returned by `POST /api/items/:id/play`, `GET /api/session/:id`. `toJSONForClient`:

```jsonc
{
  "id": "uuid",
  "userId": "uuid",
  "libraryId": "uuid",
  "libraryItemId": "uuid",
  "bookId": "uuid|null",        // null for podcast episode sessions
  "episodeId": "uuid|null",     // set for podcast episodes
  "mediaType": "book|podcast",
  "mediaMetadata": { /* book/podcast metadata snapshot */ },
  "chapters": [ { "id", "start", "end", "title" } ],
  "displayTitle": "string",
  "displayAuthor": "string",
  "coverPath": "string|null",
  "duration": 0,                // seconds (float)
  "playMethod": 0,              // 0=direct, 1=directStream, 2=transcode, 3=local (see PlayMethod)
  "mediaPlayer": "string",
  "deviceInfo": { "id", "deviceId", "ipAddress", "clientName", "deviceName", ... },
  "serverVersion": "2.35.1",
  "date": "YYYY-MM-DD",
  "dayOfWeek": "Monday",
  "timeListening": 0,           // accumulated seconds listened this session
  "startTime": 0,               // media position (s) at session start = resume point
  "currentTime": 0,             // last reported position (s)
  "startedAt": 1680000000000,   // epoch ms
  "updatedAt": 1680000000000,
  "audioTracks": [ AudioTrack ],   // see §5.2 — direct vs transcode differ here
  "libraryItem": { /* expanded library item */ },
  "coverAspectRatio": 1            // present only for share sessions
}
```

`PlayMethod` constants (`server/utils/constants.js`): `DIRECTPLAY=0`, `DIRECTSTREAM=1`,
`TRANSCODE=2`, `LOCAL=3`.

### 3.2 MediaProgress (the `mediaProgressObject` shape)

The unit of progress sync. The server upserts these via `User.createUpdateMediaProgressFromPayload`.
The session's contribution (`PlaybackSession.mediaProgressObject`) is:

```jsonc
{
  "duration": 0,
  "currentTime": 0,
  "progress": 0.0,
  "lastUpdate": 1680000000000,
}
```

`progress` is `clamp(currentTime / duration, 0..1)`. A stored MediaProgress (as seen in
`user.mediaProgress[]` and emitted on `user_item_progress_updated`) additionally carries:
`id`, `libraryItemId`, `episodeId|null`, `mediaItemId`, `isFinished`, `hideFromContinueListening`,
`startedAt`, `finishedAt`, `createdAt`, `updatedAt`.

**Auto-finish rules** (passed into every upsert from the item's library settings):
`markAsFinishedPercentComplete` and `markAsFinishedTimeRemaining` — when the reported position
crosses either threshold the item is marked finished. A re-implementation must apply the _library's_
settings, not a global default.

### 3.3 DeviceInfo

Built server-side from request IP + user-agent merged with the client-supplied `deviceInfo`
(`PlaybackSessionManager.getDeviceInfo`). If the client sends `deviceInfo.deviceId`, the server
upserts a `Device` row keyed by it, so sessions from the same device coalesce. Client-supplied fields
typically include: `deviceId`, `clientName`, `clientVersion`, `manufacturer`, `model`, `sdkVersion`.

---

## 4. Query & response conventions

### 4.1 Pagination & sort

Two conventions coexist (be careful):

- **Library items** (`GET /api/libraries/:id/items`): `limit` (0 = no limit), `page` (0-based);
  `offset = page * limit`. Sort: `sort=<field>`, `desc=1`. (`LibraryController.getLibraryItems:604`.)
  Response: `{ results, total, limit, page, sortBy, sortDesc, filterBy, mediaType, minified,
collapseseries, include, offset }`.
- **Sessions / listening history** (`GET /api/sessions`, `/api/me/listening-sessions`):
  `itemsPerPage` (default 10), `page` (0-based), `sort`, `desc=1`. Response:
  `{ total, numPages, page, itemsPerPage, sessions }`. (`SessionController.getAllWithUserData:29`.)

> ⚠️ Don't unify these. The item endpoint uses `limit`; the session endpoints use `itemsPerPage`,
> with a whitelist of sortable columns and a different response envelope (`numPages`).

### 4.2 Filtering — the base64 encoding

Library item / series / collection list endpoints accept `filter=<group>.<base64url(value)>`.
The server splits on the **first** `.`, takes the group, and base64-decodes the remainder
(`libraryFilters.decode`, used at `LibraryController.js:627-631`). Groups include `genres`,
`tags`, `series`, `authors`, `narrators`, `languages`, `progress`, `missing`, `ebooks`, etc.

Example: filter by narrator "Stephen Fry" →
`filter=narrators.` + `base64url("Stephen Fry")`. For ID-based groups the decoded value is the entity
id; for narrators it's the base64 of the _name_. Get the valid values/ids per library from
`GET /api/libraries/:id/filterdata`.

### 4.3 Common query flags

| Flag               | Endpoints                  | Meaning                                                           |
| ------------------ | -------------------------- | ----------------------------------------------------------------- |
| `minified=1`       | item lists                 | return reduced item objects                                       |
| `collapseseries=1` | item lists                 | collapse books of a series into one entry                         |
| `include=<csv>`    | items, libraries           | eager-load extras: e.g. `include=rssfeed,authors,downloads,share` |
| `expanded=1`       | `GET /api/items/:id`       | full nested media object                                          |
| `desc=1`           | sortable lists             | descending                                                        |
| `token=<jwt>`      | cover/image/track GETs     | auth via query param instead of header                            |
| `raw=1`            | `GET /api/items/:id/cover` | return original cover, bypass resize                              |
| `ts=<epoch>`       | cover GETs                 | cache-buster                                                      |

### 4.4 Error conventions ⚠️ NOT uniform

There is **no single error-body schema**. Handlers variously use:

- `res.sendStatus(4xx/5xx)` — empty body (very common; e.g. all of `HlsRouter`, much of
  `SessionController`, every `middleware` permission check returns bare `403/404`).
- `res.status(4xx).send("plain text message")` — e.g. validation failures.
- `res.status(4xx).json({ error: "..." })` — auth routes (`/auth/refresh` → `{ error }`).
- `200` with a domain payload that itself carries `{ error }` / `{ success:false }` (e.g.
  `syncLocalSessions` returns `{ results: [{ id, success, error? }] }`).

A re-implementation must match **per-endpoint** behavior, not impose a global error envelope, or
clients that branch on status-only (most of them) vs. body will misbehave. The endpoint reference
notes the status codes per route where they're non-obvious.

> Notable status quirks: admin-only endpoints often return **`404`** (not `403`) to non-admins to
> avoid leaking existence (e.g. `SessionController.getAllWithUserData` → `404`). Others return `403`.
> Follow the code per endpoint.

---

## 5. Streaming & HLS

This is the highest-risk area for compatibility. Entry point:
`POST /api/items/:id/play` (and `/play/:episodeId`) → `PlaybackSessionManager.startSession`.

### 5.1 Direct-play vs transcode decision

Request body (`startSessionRequest` → `startSession`, `PlaybackSessionManager.js:80-364`):

```jsonc
{
  "deviceInfo": { "deviceId": "...", "clientName": "...", "clientVersion": "..." },
  "mediaPlayer": "AVPlayer|ExoPlayer|...",
  "forceDirectPlay": false,
  "forceTranscode": false,
  "supportedMimeTypes": ["audio/mpeg", "audio/mp4", "audio/flac", ...]
}
```

Decision: `shouldDirectPlay = forceDirectPlay || (!forceTranscode && media.checkCanDirectPlay(supportedMimeTypes, episodeId))`.

- **Resume point:** the server seeds `startTime`/`currentTime` from the user's saved MediaProgress
  (`userProgress.currentTime`), unless the item is **finished**, in which case it starts at 0 (the
  client restarts the title). The returned session tells the client where to seek.
- Starting a new session for a (user, device) pair **closes any already-open session** for that pair
  first (so a device has at most one open session).

### 5.2 The two response shapes

**Direct play** (`playMethod = 0`):

- `audioTracks` = the item's real track list (`libraryItem.getTrackList(episodeId)`), one entry per
  audio file. Each `AudioTrack` has `index`, `startOffset`, `duration`, `title`, `contentUrl`,
  `mimeType`, and `metadata.path`. The `contentUrl` points at the file-serving endpoint; the client
  fetches the actual bytes (with `?token=`), or for an open session via
  `GET /public/session/:id/track/:index`.

**Transcode** (`playMethod = 2`):

- The server creates a `Stream`, generates an HLS playlist, and **starts ffmpeg**
  (`stream.generatePlaylist()` + `stream.start()`).
- `audioTracks` = a **single** synthetic track (`stream.getAudioTrack()`) whose `contentUrl` is the
  HLS `.m3u8` under `/hls/:streamId/...`. The client plays the playlist.

> 🧩 **Negotiation must be exact.** If `supportedMimeTypes` is wrong/empty the server transcodes
> unnecessarily (or fails to). Mirror `checkCanDirectPlay`: it compares each audio file's codec/mime
> against the client's `supportedMimeTypes` and the container's direct-play eligibility.

### 5.3 HLS segment serving — `GET /hls/:stream/:file`

`HlsRouter.streamFileRequest` (`HlsRouter.js:51-98`):

1. The `:stream` segment is the **session/stream id**; the stream must be open in memory
   (`playbackSessionManager.getStream`) → else `404`.
2. Path traversal is blocked: the resolved file must stay inside the stream dir, and extension must
   be `.ts` or `.m3u8` (else `400`).
3. If the requested `.ts` segment **doesn't exist yet**:
   - parse its segment number from the filename (`output-<n>.ts`);
   - if the stream `isResetting`, just `404` (client retries);
   - else call `stream.checkSegmentNumberRequest(segNum)`. If that returns a `startTimeForReset`
     (the requested segment is **outside the currently-transcoded window** — i.e. the user seeked),
     the server **kicks the transcoder to that time** and emits a socket event:
     ```js
     SocketAuthority.emitter("stream_reset", { startTime, streamId });
     ```
     then `404`s the segment. HLS.js restarts playback at the new `startTime`.

> 🚨 **You must implement `stream_reset`.** Seeking forward/backward beyond the buffered window does
> **not** work via range requests — the server re-bases the transcode and notifies the client over
> the socket. A client that ignores `stream_reset` appears to "stick" on seek.

### 5.4 Serving direct track bytes — `GET /public/session/:id/track/:index`

`SessionController.getTrack` (public router, `:279-330`). While a session is open, the client streams
each audio track here by index. Notable behaviors to replicate:

- Podcast index quirk: index `0` falls back to the first track (old episodes had `null` index).
- If the session is **transcode** and the track has a `contentUrl`, it **302-redirects** to the HLS
  URL (compat shim for an old Android build).
- `X-Accel-Redirect` support when `global.XAccel` is set (nginx internal redirect).
- Correct audio mime types are forced for `.m4b` etc. (Express guesses wrong) — see
  `getAudioMimeTypeFromExtname`.

Also relevant: `GET /api/items/:id/file/:fileid[/download]`, `GET /api/items/:id/download` (zip of
whole item), `GET /api/items/:id/ebook/:fileid?` for ebooks.

---

## 6. Socket.IO event contract

Real-time state is delivered over Socket.IO (`server/SocketAuthority.js`). Clients depend on it for
live progress sync across devices, library updates, download progress, and the seek `stream_reset`.

### 6.1 Connection & auth

- Path: `/socket.io` (and additionally `<RouterBasePath>/socket.io` when a base path is set — a
  **second** Socket.IO server is created, `SocketAuthority.js:168-174`).
- CORS: `origin: '*'`, methods `GET, POST`.
- After connecting, the client **must emit `auth`** with its **access-token JWT** (not an API key):
  ```js
  socket.emit("auth", accessTokenJwt);
  ```
  The server validates the JWT directly (`TokenManager.validateAccessToken`), loads the active user,
  associates the socket with the user, and replies with **`init`**:
  ```jsonc
  // to the authing socket
  {
    "userId": "...",
    "username": "...",
    "usersOnline": [
      /* admins only */
    ],
  }
  ```
  On failure it emits **`auth_failed`** `{ "message": "Invalid token" | "Invalid user" }`.
- API keys over the socket are **not** supported yet (`TokenManager.validateAccessToken` only).

### 6.2 Client → server events

| Event                 | Payload                                           | Auth  | Purpose                            |
| --------------------- | ------------------------------------------------- | ----- | ---------------------------------- |
| `auth`                | `token` (JWT string)                              | —     | associate socket with user (above) |
| `ping`                | —                                                 | any   | server replies `pong`              |
| `cancel_scan`         | `libraryId`                                       | admin | cancel a running library scan      |
| `search_covers`       | `{ requestId, title, author, provider, podcast }` | user  | stream cover-search results        |
| `cancel_cover_search` | `requestId`                                       | user  | cancel a cover search              |
| `set_log_listener`    | `level` (int LogLevel)                            | admin | stream server logs to this socket  |
| `remove_log_listener` | —                                                 | admin | stop log streaming                 |
| `message_all_users`   | `{ message }`                                     | admin | broadcast `admin_message` toast    |

### 6.3 Server → client events (the ones clients act on)

Emitted via three fan-out helpers — **match the targeting**, it's part of the contract:
`emitter` (all authed clients), `clientEmitter(userId, …)` (one user's sockets),
`adminEmitter` (admins only), plus `libraryItemEmitter`/`libraryItemsEmitter` (access-filtered).

| Event                                                                                                      | Target            | Payload                                                     | Meaning                                                                        |
| ---------------------------------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `init`                                                                                                     | socket            | `{ userId, username, usersOnline? }`                        | post-auth bootstrap                                                            |
| `auth_failed`                                                                                              | socket            | `{ message }`                                               | socket auth rejected                                                           |
| `pong`                                                                                                     | socket            | —                                                           | reply to `ping`                                                                |
| `user_item_progress_updated`                                                                               | user              | `{ id, sessionId, deviceDescription, data: MediaProgress }` | **another device updated progress** — clients re-sync the now-playing position |
| `user_session_closed`                                                                                      | user              | `sessionId` (string)                                        | a playback session was closed                                                  |
| `user_stream_update`                                                                                       | admin             | `user.toJSONForPublic(sessions)`                            | a user's open streams changed                                                  |
| `user_online` / `user_offline`                                                                             | admin             | `user.toJSONForPublic(sessions)`                            | presence                                                                       |
| `stream_reset`                                                                                             | all               | `{ startTime, streamId }`                                   | **seek re-base** (see §5.3)                                                    |
| `item_updated` / `item_added` / `item_removed`                                                             | access-filtered   | expanded LibraryItem                                        | library item changes                                                           |
| `items_added` / `items_updated`                                                                            | access-filtered   | LibraryItem[]                                               | batch item changes                                                             |
| `library_added`/`_updated`/`_removed`                                                                      | all               | Library                                                     | library CRUD                                                                   |
| `series_added`/`_updated`/`_removed`                                                                       | all               | Series                                                      | series changes                                                                 |
| `author_added`/`_updated`/`_removed`                                                                       | all               | Author                                                      | author changes                                                                 |
| `collection_added`/`_updated`/`_removed`                                                                   | all               | Collection                                                  | collection changes                                                             |
| `playlist_added`/`_updated`/`_removed`                                                                     | user              | Playlist                                                    | playlist changes                                                               |
| `episode_download_queued`/`_started`/`_finished`/`_queue_cleared`                                          | admin             | download item                                               | podcast episode downloads                                                      |
| `task_started`/`task_finished`/`task_progress`                                                             | varies            | Task                                                        | long-running jobs (scan, m4b encode, embed)                                    |
| `admin_message`                                                                                            | all               | string                                                      | toast from an admin                                                            |
| `cover_search_result`/`_complete`/`_provider_error`/`_error`/`_cancelled`                                  | requesting socket | `{ requestId, ... }`                                        | streamed cover search                                                          |
| `rss_feed_open`/`rss_feed_closed`                                                                          | varies            | feed                                                        | RSS feed lifecycle                                                             |
| `metadata_embed_queue_update`, `backup_applied`, `notifications_updated`, `ereader-devices-updated`, `log` | varies            | —                                                           | misc admin/UI updates                                                          |

> For a minimal compatible client you must handle at least: `init`, `auth_failed`,
> `user_item_progress_updated`, `user_session_closed`, `stream_reset`, and the `item_*` updates.

---

## 7. Progress & session sync semantics

There are **two overlapping mechanisms**. A re-implementation must support both because different
clients/states use different ones.

### 7.1 Stateless progress upsert — `PATCH /api/me/progress/:libraryItemId/:episodeId?`

Direct upsert of a MediaProgress for the current user (`MeController.createUpdateMediaProgress`).
Body carries some/all of `{ duration, currentTime, progress, isFinished, hideFromContinueListening,
ebookLocation, ebookProgress, finishedAt, markAsFinished... }`. Used for quick "set finished",
ebook progress, and lightweight position saves. Batch variant: `PATCH /api/me/progress/batch/update`
(array of such payloads). Remove: `DELETE /api/me/progress/:id`. Read:
`GET /api/me/progress/:id/:episodeId?`.

### 7.2 Stateful open session — `/api/session/:id/sync` & `/close`

Used during active playback. Lifecycle:

1. `POST /api/items/:id/play` opens a session (held **in memory** in `playbackSessionManager.sessions`).
2. Periodically the client `POST /api/session/:id/sync` with
   `{ currentTime, timeListened, duration? }` (`SessionController.sync`).
   - `syncSession` (`PlaybackSessionManager.js:373-412`): sets `currentTime`, **adds** `timeListened`
     to the session's `timeListening`, then upserts MediaProgress (applying the library's
     auto-finish thresholds) and emits `user_item_progress_updated` to the user's other sockets.
   - Responds **`200`** on success, **`500`** on failure (no body).
3. `POST /api/session/:id/close` with optional final sync body (same shape). If a body is present it
   syncs first; then saves, emits `user_stream_update` + `user_session_closed`, and removes the
   in-memory session. Closing requires the open-session middleware (owner or admin, else `403/404`).
4. `GET /api/session/:id` returns the open session (`toJSONForClient`).

**Accounting details to replicate:**

- `timeListening` accumulates _reported listened seconds_, not wall-clock or position delta.
- `date` / `dayOfWeek` are stamped (`YYYY-MM-DD`, e.g. `Monday`) and drive listening stats.
- A session is **only persisted to the DB once it has non-zero `timeListening`** (`saveSession`).
- Stale open sessions (no update in 36h) are dropped; orphan stream dirs are GC'd.

### 7.3 Offline reconciliation — `POST /api/session/local` & `/local-all`

How the mobile app uploads playback recorded while offline
(`PlaybackSessionManager.syncLocalSession`, `:127-274`):

- `/session/local` syncs **one** local session; `/session/local-all` takes `{ sessions: [...] }` and
  returns `{ results: [{ id, success, progressSynced, error? }] }`.
- Local sessions arrive with client-generated ids (legacy `play_local_*` ids get remapped to UUIDs
  and remembered in `oldPlaybackSessionMap`). Legacy `li_`/`ep_`/`lib_`/`local_` ids are stripped.
- The server backfills missing `mediaMetadata`/`displayTitle`/`displayAuthor`/`duration` from the
  current library item, inserts or updates the persisted session, then **conditionally** updates
  MediaProgress: it **skips** updating if the stored progress is _newer_ than the incoming session
  (`userProgress.updatedAt > session.updatedAt`) — a last-write-by-timestamp merge. On success emits
  `user_item_progress_updated`.

> 🧠 **Conflict rule to copy exactly:** newest `updatedAt` wins per media item. Getting this wrong
> causes offline listening to silently overwrite newer cross-device progress (or vice-versa).

### 7.4 Continue-listening

- `GET /api/me/items-in-progress` — the "Continue" shelf.
- `GET /api/me/progress/:id/remove-from-continue-listening` — hide one item.
- `GET /api/me/series/:id/remove-from-continue-listening` / `.../readd-to-continue-listening`.
- Items auto-marked finished (via thresholds) drop off; `hideFromContinueListening` suppresses
  manually.

---

## 8. Re-implementation checklist (minimum viable client compatibility)

1. **Discovery:** `GET /status`, `/ping`; `POST /init` first-run.
2. **Auth:** `POST /login` (both `x-return-tokens` and cookie modes), `POST /auth/refresh`
   (header + cookie, with `lastRefreshToken` grace window + server-side `Session` rows),
   `POST /logout`. JWT HS256 with `{ userId, username, jti, type, exp }`; accept Bearer and `?token=`.
3. **User/libraries:** `GET /api/me`, `GET /api/libraries`, `GET /api/libraries/:id`.
4. **Browse:** `GET /api/libraries/:id/items` (limit/page/sort/`filter=group.base64`),
   `/personalized`, `/filterdata`, `/search`, `/series`, `/collections`, `/recent-episodes`.
5. **Item + cover:** `GET /api/items/:id` (`?expanded=1`), `GET /api/items/:id/cover` (token in query,
   unauthenticated path).
6. **Playback:** `POST /api/items/:id/play(/:episodeId)` with correct `supportedMimeTypes`; handle
   both direct-play `audioTracks` and transcode `.m3u8`; serve `/hls/:stream/:file` and emit
   `stream_reset` on out-of-window seeks; serve `/public/session/:id/track/:index`.
7. **Sync:** `POST /api/session/:id/sync` + `/close`; `PATCH /api/me/progress/...`;
   `POST /api/session/local-all` with newest-`updatedAt`-wins merge.
8. **Socket:** `/socket.io`, emit `auth`, handle `init`/`auth_failed`/`user_item_progress_updated`/
   `user_session_closed`/`stream_reset`/`item_*`.
9. **Conventions:** dual pagination envelopes, base64 filters, per-endpoint error/status behavior.

See [`ENDPOINTS.md`](./ENDPOINTS.md) for the full per-route reference and [`COVERAGE.md`](./COVERAGE.md)
for the completeness matrix.
