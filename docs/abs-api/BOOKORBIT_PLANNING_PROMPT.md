# BookOrbit — ABS-compatibility planning prompt

A portable prompt to start **Step 2** in a fresh Claude Code session **inside the BookOrbit repo**.

## Before you run it

1. Copy this whole `reimpl/` folder into the BookOrbit repo (e.g. to `docs/abs-api/`), so the agent
   can read the contract locally. The four reference files are:
   `REIMPLEMENTATION_GUIDE.md`, `ENDPOINTS.md`, `COVERAGE.md`, plus the OpenAPI object schemas
   `PlaybackSession.yaml` / `MediaProgress.yaml` if you brought those too.
2. Open Claude Code in the BookOrbit repo, ideally in **plan mode**, and paste everything below the
   line.

---

I'm adding an **Audiobookshelf (ABS)-compatible API** to this service (BookOrbit) so that the
existing ABS clients — the official mobile apps and web client — can connect to BookOrbit
**unmodified**. This is a server-side compatibility layer: BookOrbit must speak the ABS wire
protocol.

**The contract is already documented.** Read these first (under `docs/abs-api/` — adjust path if you
put them elsewhere):

- `REIMPLEMENTATION_GUIDE.md` — auth/token lifecycle, data models, query/error conventions,
  streaming & HLS, the Socket.IO event contract, and progress/offline-sync semantics. §8 is the
  minimum-viable-compatibility checklist.
- `ENDPOINTS.md` — every ABS route (★ = client-critical).
- `COVERAGE.md` — coverage matrix + scope guidance.

**Do not re-derive the ABS protocol** — treat those docs as the source of truth for what BookOrbit
must emit/accept.

### Your tasks (planning only — don't write implementation code yet)

1. **Explore BookOrbit** (use read-only exploration). Establish:
   - Language, web framework, ORM/database, and how routes/controllers are currently structured.
   - The existing domain model and how it maps to ABS concepts: **Library, LibraryItem (book vs
     podcast), Author, Series, Collection, Playlist, User, MediaProgress, PlaybackSession, AudioFile/
     AudioTrack**. Note where BookOrbit's model diverges (these are the hard adaptation points).
   - Existing auth (sessions/JWT/OAuth?), existing media streaming, and any existing real-time layer
     (WebSocket/SSE) — can any of it be reused for ABS's JWT + Socket.IO requirements?
   - How audio files are stored/served today (direct file serving? transcoding? a CDN?).

2. **Gap analysis.** For each ★ client-critical area, classify BookOrbit as: _reuse as-is_,
   _adapt existing_, or _build new_:
   - Discovery (`/status`, `/ping`, `/init`)
   - Auth (`/login`, `/auth/refresh` with rotation + grace window + server-side sessions, `/logout`;
     JWT HS256 accepted via `Authorization: Bearer` **and** `?token=`)
   - User + libraries + browse (`/api/me`, `/api/libraries`, `/api/libraries/:id/items` with the
     `limit/page/sort` + `filter=group.base64` conventions, `/personalized`, `/filterdata`)
   - Item detail + cover (`/api/items/:id`, `/api/items/:id/cover` unauthenticated GET)
   - **Playback** (`/api/items/:id/play` direct-vs-transcode negotiation; HLS serving with the
     `stream_reset` seek behavior; `/public/session/:id/track/:index`)
   - **Progress/session sync** (open-session `sync`/`close`; `/api/me/progress`; offline
     `/session/local-all` with the newest-`updatedAt`-wins merge)
   - **Socket.IO** (`/socket.io`, the `auth`→`init` handshake, `user_item_progress_updated`,
     `user_session_closed`, `stream_reset`, `item_*`)

3. **Decide scope and surface it as a question:** full ABS surface vs the ★ client-driven subset.
   Recommend the subset unless there's a reason not to — it's a fraction of the ~215 routes and is
   all the official clients exercise. Confirm with me before finalizing.

4. **Flag the highest-risk adaptation points explicitly** (call these out, don't bury them):
   - Refresh-token **rotation with a 1-minute grace window** backed by server-side session rows —
     stateless JWT refresh will not be wire-compatible and will cause spurious logouts.
   - **Direct-play vs transcode** negotiation via the client's `supportedMimeTypes`, and the two
     different `PlaybackSession.audioTracks` shapes.
   - **HLS seek = `stream_reset`** over the socket (not HTTP range requests). If BookOrbit streams
     differently (e.g. CDN/range-based), this is the biggest design decision.
   - The **dual progress model** (stateless `/me/progress` vs stateful open-session sync) and the
     offline merge rule.
   - ABS's **non-uniform error conventions** (per-endpoint status/body; some admin reads return 404
     not 403) — BookOrbit must match per endpoint, not impose a global error envelope.
   - ID format/shape differences (ABS uses UUIDs and a specific JSON shape per object) — clients may
     parse these strictly.

5. **Produce a phased implementation plan** that:
   - Sequences delivery so an ABS client can **log in → browse → play → sync progress** as early as
     possible (vertical slice first), then fills out the rest of the ★ subset, then optional admin
     surface.
   - Names the concrete BookOrbit files/modules to add or change for each phase, reusing existing
     framework/ORM/streaming patterns (cite the files you found).
   - Defines an **end-to-end verification strategy**: ideally point an unmodified ABS client (mobile
     or web) at BookOrbit and walk the §8 checklist; otherwise capture the official ABS client's
     traffic and assert BookOrbit's request/response/socket shapes match.

Ask me clarifying questions about BookOrbit's product constraints where the codebase doesn't answer
them (e.g. multi-tenant?, existing transcoding?, which clients must be supported?). Then present the
plan for approval before any code is written.
