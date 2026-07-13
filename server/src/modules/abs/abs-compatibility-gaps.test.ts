/**
 * Documented-but-unimplemented ABS contract (docs/abs-api README §8 checklist).
 *
 * Every test in this file encodes a behavior the re-implementation guide requires for full client
 * compatibility but which the current vertical slice does NOT yet provide. They are therefore
 * EXPECTED TO FAIL until the corresponding feature lands — the suite doubles as an executable gap
 * list. As each capability is implemented, its test here should flip to green (and can move into the
 * relevant feature spec).
 *
 * Run just this file to see the outstanding work:
 *   pnpm vitest run src/modules/abs/abs-compatibility-gaps.test.ts
 */
import { ConfigService } from '@nestjs/config';
import { tmpdir } from 'os';

import type { LibraryService } from '../library/library.service';
import type { AbsPlaybackSessionRepository } from './abs-playback-session.repository';
import type { AbsAudioFileRow, AbsItemRow, AbsReadRepository } from './abs-read.repository';
import { AbsSocketGateway } from './abs-socket.gateway';
import { AbsItemsController } from './controllers/abs-items.controller';
import { AbsLibrariesController } from './controllers/abs-libraries.controller';
import { AbsMeController } from './controllers/abs-me.controller';
import { AbsPlaybackService } from './services/abs-playback.service';
import type { AbsTranscodeService } from './services/abs-transcode.service';
import type { AbsCatalogService } from './services/abs-catalog.service';
import type { AbsProgressService } from './services/abs-progress.service';
import { makeAbsUser } from './__testing__/abs-test-helpers';

/** Asserts a route handler / method exists on a class instance (the documented contract surface). */
function expectHandler(instance: object, method: string): void {
  expect(typeof (instance as Record<string, unknown>)[method]).toBe('function');
}

// ---------------------------------------------------------------------------------------------
// §5 Streaming — transcode / HLS
// ---------------------------------------------------------------------------------------------

// Implemented — transcode negotiation, HLS serving (/hls/:stream/:file), and stream_reset are wired
// up (see abs-transcode.service.ts, abs-hls.controller.ts).
describe('GAP §5.1–5.3 — transcode playback (playMethod=2 / HLS)', () => {
  function item(): AbsItemRow {
    return {
      id: 3,
      libraryId: 5,
      status: 'ready',
      addedAt: new Date(),
      updatedAt: new Date(),
      title: 'T',
      subtitle: null,
      description: null,
      publishedYear: null,
      publisher: null,
      language: 'en',
      isbn13: null,
      isbn10: null,
      seriesName: null,
      seriesIndex: null,
      durationSeconds: null,
      chapters: [],
    };
  }
  function file(id: number): AbsAudioFileRow {
    return { id, bookId: 3, format: 'flac', sortOrder: id, durationSeconds: 100, sizeBytes: 1000, absolutePath: `/b/${id}.flac` };
  }

  function buildPlayback() {
    const readRepo = {
      findItem: vi.fn().mockResolvedValue(item()),
      audioFilesByBookId: vi.fn().mockResolvedValue([file(10), file(11)]),
      authorsByBookIds: vi.fn().mockResolvedValue([]),
      narratorsByBookIds: vi.fn().mockResolvedValue([]),
      seriesByBookIds: vi.fn().mockResolvedValue([]),
      genresByBookIds: vi.fn().mockResolvedValue([]),
    } as unknown as AbsReadRepository;
    const progressService = { getMediaProgress: vi.fn().mockResolvedValue(null), upsertFromCurrentTime: vi.fn() } as unknown as AbsProgressService;
    const socketGateway = { emitUserItemProgressUpdated: vi.fn(), emitUserSessionClosed: vi.fn() } as unknown as AbsSocketGateway;
    const libraryService = { findAccessibleLibraryIds: vi.fn().mockResolvedValue([5]) } as unknown as LibraryService;
    const transcodeService = {
      createStream: vi.fn().mockResolvedValue('/hls/s/output.m3u8'),
      closeStream: vi.fn().mockResolvedValue(undefined),
    } as unknown as AbsTranscodeService;
    const sessionRepo = {
      insert: vi.fn(),
      updateSync: vi.fn(),
      updateFromLocal: vi.fn(),
      findById: vi.fn().mockResolvedValue(null),
    } as unknown as AbsPlaybackSessionRepository;
    return new AbsPlaybackService(readRepo, progressService, socketGateway, libraryService, transcodeService, sessionRepo);
  }

  it('honors forceTranscode by returning a transcode session (playMethod=2) with a single .m3u8 track', async () => {
    const session = await buildPlayback().startSession(makeAbsUser(), 3, { forceTranscode: true, supportedMimeTypes: [] });
    expect(session.playMethod).toBe(2);
    const tracks = session.audioTracks as Record<string, unknown>[];
    expect(tracks).toHaveLength(1);
    expect(String(tracks[0]?.contentUrl)).toContain('.m3u8');
  });

  it('exposes the HLS stream_reset socket emit used on out-of-window seeks', () => {
    const gateway = new AbsSocketGateway({} as never, {} as never);
    expectHandler(gateway, 'emitStreamReset');
  });
});

// ---------------------------------------------------------------------------------------------
// §4.2 Filtering — base64 filter encoding on browse
// ---------------------------------------------------------------------------------------------

describe('GAP §4.2 — base64 filter on GET /api/libraries/:id/items', () => {
  it('plumbs the `filter=group.base64` query param through to the catalog service', async () => {
    const listLibraryItems = vi.fn().mockResolvedValue({ results: [], total: 0 });
    const libraryService = {} as unknown as LibraryService;
    const controller = new AbsLibrariesController(libraryService, { listLibraryItems } as unknown as AbsCatalogService);

    // narrators."Stephen Fry" -> base64url
    await controller.items(makeAbsUser(), 'lib_5', { filter: 'narrators.U3RlcGhlbiBGcnk' });

    expect(listLibraryItems).toHaveBeenCalledWith(expect.anything(), 5, expect.objectContaining({ filter: expect.anything() }));
  });
});

// ---------------------------------------------------------------------------------------------
// §7 Progress & session sync — routes not yet wired
// ---------------------------------------------------------------------------------------------

describe('GAP §7.1 — stateless MediaProgress upsert (PATCH /api/me/progress/:libraryItemId)', () => {
  it('AbsMeController exposes an upsert-progress handler', () => {
    const controller = new AbsMeController({} as never, {} as never);
    expectHandler(controller, 'updateProgress');
  });
});

describe('GAP §7.4 — continue-listening shelf (GET /api/me/items-in-progress)', () => {
  it('AbsMeController exposes an items-in-progress handler', () => {
    const controller = new AbsMeController({} as never, {} as never);
    expectHandler(controller, 'itemsInProgress');
  });
});

describe('GAP §7.3 — offline reconciliation (POST /api/session/local-all)', () => {
  it('AbsPlaybackService exposes a syncLocalSessions method (newest-updatedAt-wins merge)', () => {
    const service = new AbsPlaybackService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    expectHandler(service, 'syncLocalSessions');
  });
});

// ---------------------------------------------------------------------------------------------
// §2 / §6 Items & libraries — routes documented in ENDPOINTS.md but not yet exposed
// ---------------------------------------------------------------------------------------------

describe('GAP ENDPOINTS §2 — POST /api/items/batch/get', () => {
  it('AbsItemsController exposes a batch-get handler (the catalog service method already exists)', () => {
    const controller = new AbsItemsController({} as never, {} as never, {} as never, { get: () => tmpdir() } as unknown as ConfigService);
    expectHandler(controller, 'batchGet');
  });
});

// Deferred — BookOrbit has no podcast/episode model, so podcast episode playback is out of scope.
describe.skip('GAP ENDPOINTS §2 — POST /api/items/:id/play/:episodeId (podcast episode playback)', () => {
  it('AbsItemsController exposes a play-episode handler', () => {
    const controller = new AbsItemsController({} as never, {} as never, {} as never, { get: () => tmpdir() } as unknown as ConfigService);
    expectHandler(controller, 'playEpisode');
  });
});

describe('GAP §4 (checklist) — home-screen shelves & filter data', () => {
  function librariesController() {
    return new AbsLibrariesController({} as never, {} as never);
  }

  it('exposes GET /api/libraries/:id/personalized', () => {
    expectHandler(librariesController(), 'personalized');
  });

  it('exposes GET /api/libraries/:id/filterdata', () => {
    expectHandler(librariesController(), 'filterdata');
  });

  it('exposes GET /api/libraries/:id/search', () => {
    expectHandler(librariesController(), 'search');
  });
});
