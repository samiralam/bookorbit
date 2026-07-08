# Prologue "empty library" debug — session handoff

**Status:** in progress. Branch `implement-abs-api`. Test instance: `bookorbit-test.home.samiralam.com`.
**Symptom:** logging into the test instance from Prologue (iOS Audiobookshelf client) shows libraries
but no books. Login works; libraries list works.

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

## Don't re-do

- Don't trust api.audiobookshelf.org for exact shapes — use the local ABS clone.
- Don't change the authors envelope back to always-`{ authors }`.
- Don't commit any captured bearer tokens or the `abs-capture/` dir (gitignored).
