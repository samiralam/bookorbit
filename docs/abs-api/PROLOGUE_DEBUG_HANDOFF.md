# Prologue "empty library" debug — session handoff

**Status:** in progress. Branch `implement-abs-api`. Test instance: `bookorbit-test.home.samiralam.com`.
**Symptom:** logging into the test instance from Prologue (iOS Audiobookshelf client) shows libraries
but no books. Login works; libraries list works.

> **2026-07-07 update — read "Session 2026-07-07" at the bottom first.** The `missing.authors` filter
> is fixed+deployed+verified and did NOT fix it. Decisive new facts: (a) the sync DOES retry ~2s apart
> (3–7×/app-launch — decode-failure tell-tale after all), (b) ShelfPlayerKit source (Prologue's kit;
> confirmed by its base64-padding quirk) has been cloned and EVERY response body from today's capture
> passes a programmatic simulation of its strict-Codable models — items, series, collections, authors,
> `/api/me`, listening-sessions all decode and convert. Static analysis is exhausted. Next: stream the
> device's OSLog (`io.rfk.ShelfPlayerKit`) via Console.app — the converters/API client log every skip
> and failure with the reason.

> **2026-06-22 update — the diagnosis has shifted. STOP hunting for a missing/mistyped item key.**
> As of this session every response Prologue fetches (`/api/me`, `/api/libraries`, authors, per-author
> `/items`, series, the envelopes) has been verified field-by-field against the ABS source and **decodes
> cleanly** — all required keys present, no type variance, extras are harmless supersets. The library is
> still empty and **still zero cover requests**. So the blocker is no longer item-level strict-Codable.
> The new lead is the **request pattern** (Prologue syncs author-by-author and never calls `/personalized`
> or unfiltered `/items`) plus the broken `missing.authors` filter. See "Session 2026-06-22" below — read
> that section first.

Prologue is a Swift app that decodes JSON with **strict `Codable`**: if any non-optional key is
missing/mistyped in a response, the whole object (often the whole screen) silently fails to decode
and renders empty — no error surfaced. A **retry loop** (same endpoints re-fetched every ~2s) is the
tell-tale sign of a failed decode.

## Tooling / how to reproduce

- Capture proxy: `UPSTREAM=https://bookorbit-test.home.samiralam.com PORT=9000 DUMP=1 pnpm abs:capture`
  - **Must run with the sandbox disabled** (`dangerouslyDisableSandbox`) — it binds `0.0.0.0:9000`
    for inbound from the phone; sandbox blocks `listen` with `EPERM`.
  - Point Prologue's server URL at `http://<mac-LAN-ip>:9000` (LAN IP was `10.1.1.102`). Phone must
    be on the same Wi-Fi.
  - `DUMP=1` writes each JSON body to `./abs-capture/` (gitignored). Proxy log is the background task
    output file.
- **Authoritative ABS reference is the server source, NOT api.audiobookshelf.org** (the website is
  incomplete and led me to a wrong conclusion once). Local clone added this session:
  `/Users/samiralam/Projects/Audiobookshelf` — read `server/controllers/*.js` and
  `server/models/*.js` (`toOldJSON` / `toOldJSONExpanded`).
- Probing endpoints directly with the captured bearer token works (host is reachable), but **do not
  persist the token to a file** — the auto-approver blocks it. Use it inline in a single `curl`.
  Write curl output to `$TMPDIR`, not `/tmp` (sandbox).

## Fixes made so far (all committed to the working tree, NOT yet git-committed)

All three are real and verified deployed (confirmed in captures). 273 server tests pass, server
typecheck clean.

1. **`MediaProgress` missing `createdAt`/`updatedAt`** — `abs-progress.service.ts` `toMediaProgress`.
   ABS `MediaProgress` carries non-nullable `createdAt`/`updatedAt`; we omitted them, failing the
   `/api/me` decode (which embeds `mediaProgress`). BookOrbit tracks one timestamp on the row, so both
   mirror it. Regression test added in `abs-progress.service.test.ts`.

2. **Author objects missing required `libraryId`** — `abs-author.mapper.ts` (THE original cause of the
   empty _library_). ABS `Author.toOldJSON` includes a non-optional `libraryId`; we omitted it, so the
   authors array failed Prologue's strict decode → zero authors → everything empty. BookOrbit authors
   are global, so `libraryId` = the library being listed under (route param); for `/api/authors/:id`
   it's derived from any of the author's books via new repo method `libraryIdForAuthor`
   (`abs-read.repository.ts`).

3. **Authors envelope** — `abs-catalog.service.ts` `listAuthors`. ABS `LibraryController.getAuthors`
   returns paginated `{ results, total, limit, page, … }` when `limit`+`page` are present (Prologue
   sends `limit=50&page=0`, reads `.results`), else bare `{ authors }`. NOTE: I briefly "simplified"
   this to always-`{ authors }` — that was WRONG; it's reverted to the dual ABS shape. Don't redo it.

Tests touched: `abs-author.mapper.test.ts`, `abs-catalog.service.test.ts`,
`abs-libraries.controller.test.ts`, `abs-progress.service.test.ts`.

## 429 rate limiting — FIX IMPLEMENTED (awaiting redeploy + recapture)

`@SkipThrottle()` (from `@nestjs/throttler`) added at class level to all ABS browse/data
controllers under `server/src/modules/abs/controllers/` (authorize, authors, hls, items,
libraries, me, playlists, public, sessions) plus the discovery controller (`auth/abs-discovery`,
which serves the polled `/ping`, `/healthcheck`, `/status`). Login (`auth/abs-auth.controller` —
`/login`, refresh, logout) and OIDC (`auth/abs-openid.controller`) intentionally stay throttled,
matching real ABS which only rate-limits login. 273 server tests pass, typecheck clean.

**Next: redeploy `bookorbit-test`, recapture, verify** the `/items?filter=authors.*` burst returns
200s and Prologue shows books. Status distribution should no longer contain 429s. If still empty,
see "After the 429 fix" below.

### Original analysis (kept for reference)

After fix #2, Prologue advanced and now requests `/items`, `/series`, `/collections` (it never did
before). Its browse model fires a **burst of ~25 `GET /api/libraries/lib_4/items?filter=authors.<b64>`
requests** (one per author) plus series/collections, on top of `/api/me` + `/ping` polling.

The latest capture shows **123 of these returning `429`** (status distribution: 358×200, 4×302,
123×429). The per-author item loads are being rate-limited, so the books never populate → library
still appears empty.

Cause: global throttler in `server/src/app.module.ts`:

```
ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }] })
```

applied app-wide via `{ provide: APP_GUARD, useClass: ThrottlerGuard }`. 120 req/min is far too low
for one ABS client's burst. Real ABS only rate-limits **login** (`rateLimitLoginRequests`), not browse
endpoints.

### Proposed next step

Exempt ABS routes from the global throttler (or give them a much higher/separate limit), matching ABS
(which doesn't throttle browse). Options, in rough order of preference:

- Add `@SkipThrottle()` to the ABS controllers (controllers under `server/src/modules/abs/`), keeping
  throttling on real auth/login. Simplest and closest to ABS behavior.
- Or a dedicated higher-limit throttler bucket for `/api/...` ABS paths.
- Confirm the ABS auth/login endpoints keep sensible throttling after the change.

Then redeploy `bookorbit-test`, recapture, and verify: the `/items?filter=authors.*` burst returns
200s with results, and Prologue finally shows books.

### 429 fix VERIFIED + minified-shape fix (FIX IMPLEMENTED, awaiting recapture)

Recapture after the throttle fix: status distribution **166×200, 2×302, 1×401 — zero 429s**. The
`/items?filter=authors.*` burst returns 200s with results, `/ping` is back to a normal heartbeat
(no 2s retry loop). Throttle blocker is fully resolved. **But the library was still empty** → it was
a second, independent bug: the item LIST shape.

**Root cause #2 (fixed):** ABS's `getLibraryItems` serializes list rows via `toOldJSONMinified()`
**unconditionally** (the `?minified` query param is only echoed in the envelope, never affects the
item shape — see `LibraryItem.getByFilterAndSort` line ~301 in the ABS clone). Our `listLibraryItems`
passed `minified: query.minified`, which is `false` when Prologue omits the param, so we returned the
**expanded** media — which omits `numAudioFiles`/`numChapters`. Prologue decodes the list with its
minified `Book` model (those keys required), so every item failed strict Codable → empty shelves.

Same class of bug on the other list endpoints — matched to ABS exactly:

- `listLibraryItems` → **always minified** (`abs-catalog.service.ts`).
- `listSeries` → **always minified** (ABS `seriesFilters.getFilteredSeries` uses
  `toOldJSONMinified()`).
- `listCollections` → **always expanded** (ABS `Collection.toOldJSONExpanded()` uses the expanded
  book shape) — Prologue's collections were empty (user has none) so not the active blocker, but
  aligned for correctness.
- Item detail (`GET /api/items/:id`) stays expanded — matches ABS. Search already minified.

Regression test added in `abs-catalog.service.test.ts` ("always emits minified item media…").
273+1 ABS tests pass, typecheck clean. **Next: redeploy `bookorbit-test`, recapture, confirm books
now render under each author and on the Books/Home tabs.**

### Root cause #3 (DEPLOYED + VERIFIED — but did NOT fix the empty library) — `oldLibraryItemId`

After the minified fix deployed and was VERIFIED in capture (media now has
`numAudioFiles`/`numChapters`, no `audioFiles`) the library was **still empty**. Decisive new
evidence from that capture:

- **Zero cover requests** (`grep` for `/cover`/`/metadata` in the proxy log = nothing). A client
  rendering even one book always fetches its cover. Zero covers ⇒ zero _displayable_ items.
- **No retry loop** — endpoints hit ~once per manual refresh, then `/ping` idle. So decode is NOT
  failing the whole response; items are being **silently dropped per-element** (Swift `try?`-per-item
  array decode skips bad elements with no error and no retry).
- Library was empty with **both** the old expanded AND the new minified item shape ⇒ the bad field
  is **common to both**.

Diffing our item vs ABS `LibraryItem.toOldJSONMinified`, the ONLY field we omitted was top-level
**`oldLibraryItemId`** (ABS always sends it, value `null`). Swift's `decode(String?.self, forKey:)`
**throws on a missing key** even though it accepts an explicit `null` — so every item failed
per-element decode and was dropped. Fixed: `abs-item.mapper.ts` now always emits
`oldLibraryItemId: null`. (Series/collection books go through the same mapper, so they're covered.)

Other ABS-shape gaps fixed in the same pass (objective deviations found while diffing):

- **Library** (`abs-library.mapper.ts`): added `lastScan` (mirrors updatedAt) + `lastScanVersion`
  (ABS `Library.toOldJSON` always has them; a null `lastScan` can read as "never scanned").
- **Series object** (`abs-catalog.service.ts` `listSeries`): added `libraryId`, `description` (null),
  `updatedAt` (0) to match ABS `Series.toOldJSON`.

Regression tests added (`abs-item.mapper.test.ts`, `abs-library.mapper.test.ts`). 274+1 ABS tests
pass, typecheck clean.

**Recapture verdict (2026-06-22):** the fix is deployed (items now carry `oldLibraryItemId: null`),
but the library is **still empty and still fetches zero covers**. So this was a real ABS-shape gap
worth closing, but it was NOT the cause. Don't keep adding "one more missing key" — see below.

## Session 2026-06-22 — everything decodes, still empty; pivot to request-pattern analysis

Recaptured after the root-cause-#3 deploy (capture in `abs-capture/`, ~170 requests). Verified every
response Prologue touches against the ABS source:

| Response             | Verified against ABS                                                                                                | Result                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/api/me`            | `User.toOldJSONForBrowser`                                                                                          | decodes; `librariesAccessible: [lib_4, lib_3]`, `permissions` present, `mediaProgress` carries `createdAt/updatedAt`                                         |
| `/api/libraries`     | `Library.toOldJSON`                                                                                                 | exact key match (id, name, folders, displayOrder, icon, mediaType, provider, settings, lastScan, lastScanVersion, createdAt, lastUpdate)                     |
| authors (`limit=50`) | `Author.toOldJSON` + getAuthors paginated envelope                                                                  | all keys (id, asin, name, description, imagePath, libraryId, addedAt, updatedAt, numBooks) + extra `lastFirst`; **no type variance across all 25**           |
| per-author `/items`  | `LibraryItem.toOldJSONMinified` + `Book.toOldJSONMinified` + `oldMetadataToJSONMinified` + getLibraryItems envelope | exact superset; `oldLibraryItemId: null` present; media has `numAudioFiles/numChapters/numTracks/coverPath/duration/size`; metadata has all 17 minified keys |
| series (`limit=5`)   | `Series.toOldJSON`                                                                                                  | has id/name/nameIgnorePrefix/description/libraryId/libraryItemIds/books/addedAt/updatedAt/totalDuration                                                      |
| collections          | —                                                                                                                   | `{results: [], total: 0, …}` (user has none)                                                                                                                 |
| listening-sessions   | —                                                                                                                   | `{total: 0, sessions: [], …}`                                                                                                                                |

**Conclusion: nothing fails strict-Codable anymore.** The item/author/library/me shapes are all
correct. Yet the library renders empty and Prologue **never requests a single cover** — so the items
aren't reaching the displayed collection. The bug is no longer "a missing key."

### The real anomaly: Prologue's request pattern is entirely author-centric

Distinct endpoints Prologue hit this session (normalized counts):

- `…/items?filter=authors.<b64>` ×75 ← per-author, iterates **all 25 authors**, ~3 passes
- `/api/me` ×28, `/ping` ×14, `/status` ×9
- `…/items?filter=missing.<b64>` ×14 ← `missing.authors` (books with no author)
- `…/series?limit=5` ×7, `/api/libraries` ×7, `…/collections?limit=5` ×6
- `…/me/listening-sessions` ×6, `…/authors?limit=50` ×7 (sorted + unsorted variants)

**What Prologue NEVER requests:** unfiltered `GET …/items` (the Books grid), `…/personalized`
(the Home rows), or single `GET /api/libraries/:id`. The whole library is assembled from the
**authors list → per-author items → `missing.authors`** loop (the ShelfPlayer/Prologue author-centric
sync; Prologue and ShelfPlayer share a codebase, same dev `rasmuslos`). It's a repeating multi-phase
cycle that _completes_ and restarts — NOT the tight ~2s decode-retry loop, confirming decode succeeds.

So the question is no longer "which key is missing" but **"why don't the decoded items render / why is
no cover ever requested."** Two leads, in priority order, in Next Steps.

### Next steps (for the next session) — in priority order

1. **Capture a known-good Prologue ↔ real-ABS session and diff the request pattern. (HIGHEST VALUE —
   stop reverse-engineering blind.)** Run the local ABS clone (`/Users/samiralam/Projects/Audiobookshelf`,
   `npm start`) with one or two audiobooks, point Prologue at it through the same capture proxy, and
   record the request sequence. Diff it against this session's capture. This answers definitively:
   does working-ABS Prologue call `/personalized` / unfiltered `/items`? Is the `missing.authors`
   step expected to return empty? What triggers the first cover fetch? Everything below is a guess
   until we have this reference.

2. **[DONE 2026-07-07 — see "Known remaining bug" section below; awaiting redeploy+recapture]
   Fix the `missing.authors` filter — now the PRIME on-server suspect, not a side bug.** It currently
   returns ALL 65 items instead of books with no author (see section below). In an author-centric sync,
   `missing.authors` is the "uncategorized books" bucket; returning the entire library there is very
   likely poisoning Prologue's reconciliation/dedup of which items belong where. Fix `buildFilterWhere`
   to handle the `missing.<field>` group (`abs-catalog.service.ts` / `abs-filter.util.ts`), have it
   return only author-less books, add a test, redeploy, recapture. Cheap, clearly-wrong, and plausibly
   _the_ cause — do this regardless of #1.

3. **Read the ShelfPlayerKit source (`github.com/rasmuslos/ShelfPlayer`, default branch `main`).** It's
   the open-source sibling of Prologue. Map (a) how a library's main grid/home is populated from the
   author-centric calls, (b) what field gates whether an item is shown / its cover loaded, (c) whether
   it expects `missing.authors` to be empty. Look at the networking layer (`ShelfPlayerKit`) models and
   the library/home view-models.

4. **Lower-probability shape gaps to rule out while in there** (none proven to break decode, but worth a
   pass): our `/api/me` sends `token: null` / `refreshToken: null` which ABS omits entirely; our library
   `settings` object is a partial subset of ABS's (missing `audiobooksOnly`, `hideSingleBookSeries`,
   `metadataPrecedence`, etc.); library `icon` is `'Mic'` / `displayOrder: 0` which aren't valid ABS
   values (ABS icons are a lowercase enum). Confirm against the reference capture from #1 before changing.

### Known remaining bug — `missing.*` filter — FIX IMPLEMENTED 2026-07-07 (awaiting redeploy + recapture)

`GET /items?filter=missing.authors` returned ALL 65 items instead of only books with no author — the
`missing.<field>` filter group wasn't handled, and `filterWhere`'s `default: undefined` meant "no
filtering". **Fixed in `abs-read.repository.ts`:** new `missing` case in `filterWhere` →
`missingWhere(field)`, matching ABS `libraryItemsBookFilters` semantics exactly:

- `missing.authors` / `series` / `narrators` / `genres` / `tags` → `books.id NOT IN (junction)`.
- `missing.subtitle` / `description` / `publisher` / `language` → null-or-empty on `bookMetadata`
  (books with no metadata row also count as missing); `publishedYear` → null; `isbn` → neither
  isbn10 nor isbn13 set.
- Unknown fields (e.g. `asin`, which we don't store) → `undefined` = no filtering, same as ABS's
  fall-through.
  No service-layer change needed — `buildFilterWhere` already passes non-id groups through verbatim.
  Unit tests in new `abs-read.repository.test.ts` (builds real drizzle SQL with an unconnected pg
  Pool, asserts the rendered predicates). Typecheck clean; full server suite passes except a
  **pre-existing** `architecture-boundaries.test.ts` failure (abs-session/abs-bookmark/abs-progress
  services inject DB directly but aren't on the allowlist — fails on the committed branch too,
  unrelated to this fix; needs its own cleanup).

**Next: redeploy `bookorbit-test`, recapture, verify** `filter=missing.<b64>` now returns only
author-less books (likely 0 of 65) and check whether Prologue finally renders books / fetches
covers. If STILL empty → go straight to Next Step #1 (reference capture against real ABS).

### If STILL empty after the oldLibraryItemId fix — UPDATE: it was, and the key-diff is now DONE

This is the path we were on. As of 2026-06-22 the full key-by-key diff against
`Book.toOldJSONMinified` / `oldMetadataToJSONMinified` / `Author.toOldJSON` / `Library.toOldJSON` has
been completed (see the "Session 2026-06-22" section and table above) and **all shapes decode**. The
"find the missing/mistyped key" lead is exhausted — do NOT keep grinding on it. Move to the request-
pattern leads in "Next steps" above (reference capture from real ABS, then the `missing.authors`
filter, then ShelfPlayerKit source).

## Useful facts captured

- User `usr_3` (samir.alam), non-superuser, `librariesAccessible: ["lib_4","lib_3"]`,
  `userDefaultLibraryId: "lib_4"`. `accessAllLibraries: false`.
- lib_4 = "Audiobooks" (`mediaType: book`), 65 items, 25 authors. lib_3 = "Books".
- Prologue build 10830. Auth via OIDC (`prologue://oauth`), works.
- Prologue does NOT open Socket.IO at all (no `/socket.io/` polling, no WS upgrade) — appears to be
  by design; not the blocker.
- Memory written: `abs-strict-codable-empty-library` (in the project memory dir).

## Session 2026-07-07 — missing.\* fixed (not the cause); ShelfPlayerKit source analyzed; all shapes provably decode

- **`missing.*` filter fix deployed + verified** (commit `208ce06a`, semantics in the "Known remaining
  bug" section above). `filter=missing.authors` now returns 1 of 65 items — `li_385`, a real
  author-less book **with an empty title** (data oddity worth fixing in the library, but Prologue
  tolerates it: title `""` is non-nil). Library still empty, still zero cover requests.
- **The retry loop IS present after all.** Timeline reconstruction of today's capture (5 app-launches,
  752 requests): each launch runs the full author-centric sync (authors → 25×per-author items →
  missing → series → collections → me → listening-sessions) then repeats it ~2s later, 3–7 times, then
  goes idle. The 2026-06-22 "no retry loop" conclusion was wrong (passes 25s apart were misread).
  ShelfPlayerKit requests carry `maxAttempts` (2–4) with ~2s spacing — these are failure retries.
  So SOMETHING in the sync transaction fails every time.
- **ShelfPlayerKit source cloned and analyzed** (`github.com/rasmuslos/ShelfPlayer`, full history, in
  session scratchpad — re-clone as needed). Prologue is confirmed built on it: our captures show its
  exact base64 quirks (`%3D%3D` padding on authors/series filters, raw unencoded narrator names).
  Key mechanics learned:
  - Item lists decode as `ResultResponse { total, results: [ItemPayload] }` then convert via
    failable `Audiobook(payload:)` in `compactMap` → bad items are DROPPED silently (explains
    zero-covers without decode errors); but a TYPE mismatch anywhere (e.g. `publishedYear` must be
    String-or-null, `genres` is REQUIRED `[String]`, chapters `{id Int, start/end Double, title
String}` all required) throws and fails the WHOLE response → retry.
  - Conversion guards (current kit): media present, `numAudioFiles > 0`, libraryId, non-nil title.
    All 1582 items in today's capture pass every guard.
  - `MeResponse` requires `id/username/type/isActive/isLocked`; sessions envelope requires
    `total/numPages/page/itemsPerPage/sessions`. Both verified present in our responses.
- **Programmatic strict-Codable validation of today's ENTIRE capture: zero violations.** Script at
  scratchpad `validate_payloads.py` (rewrite from this doc if lost): simulates decodeIfPresent
  type-throwing for every ItemPayload/MediaPayload/MetadataPayload field over all items/series/
  collections files (1582 items), plus authors list, /api/me, listening-sessions checked by hand.
  All 752 bodies are valid JSON (no error/redirect bodies hiding in the dump).
- **Interpretation:** against the CURRENT kit models nothing we send fails — yet the sync retries like
  a decode failure. Either Prologue 10830 pins an older/stricter ShelfPlayerKit (private fork; public
  repo has no Prologue refs) or the failure is app-level (persistence, not network decode).

### 2026-07-07 evening — device logs obtained; ShelfPlayerKit attribution DISPROVEN

Console.app stream from the iPhone (process filter `Prologue`, info+debug enabled):

- **Prologue is NOT built on ShelfPlayerKit.** Its bundle id is `me.charlick.prismbooks`
  (app group `group.me.charlick.prism.core`, internal name "Prism Books", dev "charlick") — no
  `io.rfk.*` subsystems at all, and no ShelfPlayer/charlick cross-references in either codebase.
  The earlier "confirmed via base64-padding quirk" inference was wrong (that padding is just
  standard base64). All ShelfPlayerKit model analysis is now **non-binding** (still useful as a
  reference for how Swift ABS clients decode, but not Prologue's actual models — those are
  closed-source). The "2s retry = maxAttempts decode retry" interpretation loses its foundation too;
  the repeating passes may just be Prologue's per-view refresh.
- **Every request succeeds at the network layer on-device**: CFNetwork `summary for task success`,
  `response_status=200` for the whole burst, no app-level error/decode logs whatsoever (the app
  doesn't appear to log decode failures).
- **Prologue applies persisted client-side list filters on every render**: constant pref reads of
  `book-list-view-mode`, `book-list-ordering`, **`book-list-filters`** (domain `me.charlick.prismbooks`).
  A stuck/non-default filter (e.g. Downloaded-only, In-progress) would render an EMPTY library with
  zero cover fetches while all network traffic looks perfectly healthy — this now fits ALL evidence
  and is the cheapest thing to check.

### Next steps 2026-07-07 — in priority order (REVISED after device logs)

1. **Check Prologue's client-side library filter/view settings (10 seconds).** In the library book
   list, open the filter/sort control and clear any active filter (set to All); also try switching
   view mode. If a filter was set, everything is explained. Also consider deleting + reinstalling
   the app (or removing/re-adding the server connection) to reset `book-list-*` prefs and any stale
   local sync DB.
2. **Reference capture against real ABS** (unchanged) — run the local ABS clone with 1–2 audiobooks,
   point Prologue at it through the capture proxy, verify books DO render, then byte-diff the same
   endpoints against BookOrbit's responses. With Prologue closed-source this is the only remaining
   systematic way to find what its models require.
3. If #2 shows books render against real ABS, diff the response bodies field-by-field for the exact
   same request sequence (the validator script in the scratchpad can be adapted to diff two captures).

## Session 2026-07-07 (late) — REFERENCE CAPTURE DONE; Prologue works vs real ABS; concrete diffs found + FIXED

Ran the local ABS clone (2.35.1) with 2 generated audiobooks (setup lives in the session scratchpad
`abs-ref/`; ABS on :3333, capture proxy on :9001 — the user's old :9000 proxy pointed at bookorbit
was still running, so `abs-capture/` got BOTH servers side-by-side; bookorbit's older captures are
archived in `abs-capture/archive-bookorbit-2026-07-07/`). **Prologue rendered both authors and
books and played audio against real ABS through the same proxy** — so the bug is in our response
bodies, full stop. Sync sequence identical (author-centric), ran ONCE (no retry loop), and Prologue
even issued an unfiltered `/items` + item-detail + `POST /api/session/local/all` — requests it
never sent to BookOrbit.

Key-path/type/value diff (script: scratchpad `diff_captures.py`) found these REAL deviations, all
**fixed in this session** (uncommitted):

1. **`/api/me` `token: null`** — live ABS always sends a real JWT string. PRIME SUSPECT: a
   non-optional `token: String` decode fails on null, and `/api/me` was Prologue's most-refetched
   endpoint (74–102×/day). Fix: `abs-me.controller.ts` echoes the caller's bearer via new
   `legacyToken` extra in `abs-user.mapper.ts`.
2. **`mediaProgress[].userId` missing** — ABS always sends it. Fix in `abs-progress.service.ts`.
3. **`mediaProgress[].ebookProgress: null`** — live ABS sends a number (0 for audio; it coalesces
   null→0 on write). Fix: emit 0.
4. **`permissions.selectedTagsNotAccessible` missing** — added (false).
5. **Library `settings` missing 8 keys** (audiobooksOnly, epubsAllowScriptedContent,
   hideSingleBookSeries, onlyShowLaterBooksInContinueSeries, metadataPrecedence,
   markAsFinishedPercentComplete, markAsFinishedTimeRemaining) — added with ABS defaults.
6. **`icon: "Mic"`** — not a valid ABS icon; icons are a fixed lowercase set and enum decodes throw
   on unknown values. Fix: `toAbsIcon()` whitelist/normalizer in `abs-library.mapper.ts`.
7. **`settings.coverAspectRatio` was INVERTED** — ABS `BookCoverAspectRatio`: 0=standard 1.6:1,
   1=square (we sent 0 for square). Fixed.
8. **`displayOrder: 0`** — ABS is 1-based; now `bookorbit displayOrder + 1`.

Also noted (NOT bugs): earlier "fix #1" added `createdAt`/`updatedAt` to mediaProgress claiming ABS
requires them — live ABS 2.35.1 /api/me mediaProgress does NOT include them; left in as harmless
extras. Our minified item lists carry extra keys ABS omits (metadata.authors/series/narrators
arrays, media.libraryItemId, userMediaProgress, …) — harmless supersets, left alone.

Tests updated (`abs-me.controller.test.ts`, `abs-library.mapper.test.ts`,
`abs-progress.service.test.ts`); 282 ABS tests pass, typecheck clean.

**Next: redeploy `bookorbit-test`, have Prologue re-sync the bookorbit connection (proxy :9000
still up), and check for books + cover requests.** If STILL empty, the remaining lever is the
side-by-side capture: same app session, both servers — diff `items_filtered` bodies value-by-value
(not just shape), and consider stripping our extra superset keys to match ABS minified exactly.

## Session 2026-07-08 — UUID-id hypothesis REFUTED; superset keys stripped to exact ABS minified shape

**UUID-id hypothesis tested and killed.** Built `tools/abs-capture-proxy/abs-id-rewrite-proxy.mjs`
(phone → :9002 id-rewriter → :9000 dump proxy → bookorbit-test): presents every prefixed id as a
UUID-shaped string (`li_413` → `00000000-0003-4000-8000-…019d`) and reverse-maps ids in paths,
query params, base64 `filter` values, and JSON request bodies. Proxy logs prove the test was valid —
Prologue round-tripped the UUIDs through its whole pipeline (UUID library id in paths, UUID author
ids inside base64 filters). **Still no books.** Prologue does NOT require UUID-parseable ids.

**Sync-abort point located.** Comparing request sequences: against real ABS, Prologue runs the same
per-author phase (authors list → per-author filtered items → missing.authors → series → collections
→ listening-sessions) and then PROCEEDS to item detail (`/api/items/:id?expanded=1&include=authors,progress…`)
and `POST /api/session/local/all`. Against BookOrbit it finishes the per-author phase and loops.
The failure is in decoding one of those five phase responses.

**Root-cause candidate found by field-level diff (capture 0010 real-ABS vs 0800s BookOrbit):**
our minified items were a SUPERSET of ABS `toOldJSONMinified` — we sent `metadata.authors/[{id,name}]`,
`metadata.narrators`, `metadata.series`, `media.libraryItemId`, `numMissingParts`,
`numInvalidAudioFiles`, and `userMediaProgress` on list rows. Real ABS 2.35.1 emits NONE of those in
minified/list contexts (verified in `models/Book.js` `toOldJSONMinified`/`oldMetadataToJSONMinified`
and `models/LibraryItem.js`). **Extra keys are as dangerous as missing ones**: a client property
declared optional decodes fine when the key is ABSENT (decodeIfPresent skips), but THROWS when the
key is PRESENT with a narrower object than the client's model — e.g. our `{id,name}` author stubs
vs a full Author model. That would fail only against BookOrbit, silently, with healthy 200s.

Fixes (working tree, tests updated, 283 ABS tests pass, typecheck clean):

- `abs-item.mapper.ts` — minified media/metadata now EXACTLY match ABS `toOldJSONMinified` key sets
  (arrays, libraryItemId, part counts removed); `authorNameLF` now real "Last, First" (was plain
  name); expanded metadata gains `descriptionPlain` (matches `oldMetadataToJSONExpanded`).
- `abs-catalog.service.ts` — `userMediaProgress` no longer attached to any list-shaped response
  (browse/series books/search/shelves/batch), only item detail; items/series/collections/authors
  envelopes now echo `sortBy`/`filterBy`/`include` verbatim and OMIT them when the client didn't
  send them (ABS `payload.sortBy = req.query.sort` semantics); series envelope loses `offset`,
  gains `include`; series elements lose `libraryItemIds`/`totalDuration` (not in ABS output).
- `abs-libraries.controller.ts` — passes `rawSort` through for envelope echo.

**Next: redeploy `bookorbit-test`, Prologue re-sync (fresh connection or clear app), check books.**
If STILL empty after this, the phase responses are byte-shape-identical to ABS modulo values; next
lever is value-level scrutiny (e.g. authors `addedAt: 0`, empty `folderId`/`path`/`relPath`) and/or
replaying Prologue's exact request list against both servers with a scripted differ.

## Session 2026-07-08 (later) — BOOKS RENDER; "Unable to load book contents" fixed (expanded item lacked tracks)

**The superset fix WORKED — Prologue shows books and fetches covers.** Sync stats from the capture
log: a pull-to-refresh is ~750–1500 requests (one `/items?filter=authors.<id>` per author + one
`/items?filter=series.<id>` per series + paged series/collections); BookOrbit answers at p50=8ms,
p99=19ms — the ~8s refresh is Prologue's sync pattern, not server latency. The `@SkipThrottle()`
fix is essential at this volume.

**Next failure: opening a book showed "Unable to load book contents", play disabled.** Capture log
showed the decode-retry tell-tale on `GET /api/items/:id?expanded=1&include=authors,progress`
(re-fetched every ~4s, no play request ever). Diff vs the real-ABS expanded item (ref capture 0030):
our expanded item was missing **`media.tracks`** (the book's playable contents — the literal cause),
**`libraryFiles`**, and `lastScan`/`scanVersion`; it also carried not-in-ABS extras (`media.numTracks`,
top-level `numFiles`) and omitted `userMediaProgress` when null (ABS emits the key as explicit null
on `?include=progress`).

**Key discovery about Prologue's playback model:** the real-ABS capture contains NO
`POST /api/items/:id/play` at all. Prologue plays by streaming `tracks[].contentUrl`
(`/api/items/:id/file/:ino`, Range requests) directly from the expanded item, then reports progress
via `POST /api/session/local-all` (hyphen route, per ABS `ApiRouter.js:234`; the capture filename's
trailing `_` is an empty `?`, NOT a trailing slash — our route was already correct). So `tracks`
is the playback-critical field, and our existing `GET :id/file/:fileid` route serves it.

Fixes (working tree; 284 ABS tests pass, typecheck+lint clean):

- `abs-item.mapper.ts` — expanded media now EXACTLY `Book.toOldJSONExpanded`: adds `tracks`
  (audio-file JSON + title/startOffset/contentUrl per `getTracklist`), `ebookFile` placement, drops
  `numTracks`; expanded top level now EXACTLY `LibraryItem.toOldJSONExpanded`: adds `lastScan`,
  `scanVersion` (ABS_SERVER_VERSION), `libraryFiles` (built from audio files), drops `numFiles`
  (minified keeps it); AudioFile `index` is now 1-based like ABS; shared `toAbsFileMetadata` helper.
- `abs-catalog.service.ts` + `abs-items.controller.ts` — `?include=progress` now emits
  `userMediaProgress` even when null (explicit null); without the include the key is omitted.

**Next: redeploy, open a book, hit play, scrub, background the app** — first live exercise of the
file-stream route and `POST /api/session/local-all` write path.

## Session 2026-07-08 (later still) — PLAYBACK WORKS (capture proxy was buffering); download-queue "?" fix

**Playback initially silent through the proxy — the CAPTURE PROXY was the cause, not the server.**
Symptom: play didn't advance, no audio; log showed healthy 206s but Prologue re-pulled ~370MB
ranges of the same file every ~5s. The capture proxy buffered every response fully in memory
before forwarding, so each range request delivered zero bytes to the phone for 5–6s → AVPlayer
stalled/cancelled/retried. (The 380KB test-tone books masked this against real ABS.) Fixed the
proxy (`abs-capture-proxy.mjs`): non-JSON/text bodies now stream through unbuffered (pipe), client
aborts propagate upstream, and media log lines include the `Range:` header. **After the proxy fix,
playback works with a textbook AVPlayer pattern** (bytes=0-1 probe → header read → 64KB chunk
reads), `?token=` auth on the file route works, and `POST /api/session/local-all` returns the ABS
`{results:[{id,success,progressSynced}]}` shape. When debugging media through the proxy, remember:
logged byte counts are what UPSTREAM sent, not what the phone consumed.

**Download works; queue shows "?" instead of title/cover (open).** The per-file download
(`GET /api/items/:id/file/:ino/download`) returns 200 with a proper Content-Disposition filename;
no request around it fails — so the "?" is rendered from decoded data. Best remaining value-level
deviation: our audio files carried `metaTags: {}` and zeroed timestamps, while real ABS files always
have `tagTitle`/`tagArtist`/`tagAlbum` (a queue row titled by tag renders "?" when nil). Fix applied
(hypothesis, awaiting retest): `abs-item.mapper.ts` audio files/tracks/libraryFiles now carry
`metaTags` (tagTitle/tagAlbum = book title, tagArtist = authors) and the item's real
added/updated timestamps; also removed the not-in-ABS `invalid` key from audio files.

## Don't re-do

- Don't trust api.audiobookshelf.org for exact shapes — use the local ABS clone.
- Don't change the authors envelope back to always-`{ authors }`.
- Don't commit any captured bearer tokens or the `abs-capture/` dir (gitignored).
- Don't re-verify response shapes against the CURRENT public ShelfPlayerKit models — done
  programmatically 2026-07-07, zero violations (see Session 2026-07-07).
- Don't re-test the UUID-id hypothesis — refuted 2026-07-08 via the id-rewrite proxy (see above).
- Don't re-add "harmless" superset keys to minified shapes — that was the 2026-07-08 lead suspect.
