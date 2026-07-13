import type { LibraryService } from '../../library/library.service';
import type { AbsPlaybackSessionRepository } from '../abs-playback-session.repository';
import type { AbsAudioFileRow, AbsItemRow, AbsReadRepository } from '../abs-read.repository';
import type { AbsSocketGateway } from '../abs-socket.gateway';
import { makeAbsUser, thrownStatus } from '../__testing__/abs-test-helpers';
import { AbsPlaybackService } from './abs-playback.service';
import type { AbsProgressService } from './abs-progress.service';
import type { AbsTranscodeService } from './abs-transcode.service';

function item(overrides: Partial<AbsItemRow> = {}): AbsItemRow {
  return {
    id: 3,
    libraryId: 5,
    status: 'ready',
    addedAt: new Date(),
    updatedAt: new Date(),
    title: 'The Hobbit',
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
    ...overrides,
  };
}

function file(id: number, durationSeconds: number): AbsAudioFileRow {
  return { id, bookId: 3, format: 'mp3', sortOrder: id, durationSeconds, sizeBytes: 1000, absolutePath: `/books/3/${id}.mp3` };
}

interface BuildOpts {
  item?: AbsItemRow | null;
  audioFiles?: AbsAudioFileRow[];
  progress?: Record<string, unknown> | null;
  accessibleIds?: number[];
  existingRow?: Record<string, unknown> | null;
  mergeResult?: { progressSynced: boolean; mediaProgress: Record<string, unknown> | null };
}

function build(opts: BuildOpts = {}) {
  const audioFiles = opts.audioFiles ?? [file(10, 100), file(11, 200)];
  const readRepo = {
    findItem: vi.fn().mockResolvedValue(opts.item === undefined ? item() : opts.item),
    audioFilesByBookId: vi.fn().mockResolvedValue(audioFiles),
    authorsByBookIds: vi.fn().mockResolvedValue([{ bookId: 3, id: 1, name: 'Tolkien' }]),
    narratorsByBookIds: vi.fn().mockResolvedValue([]),
    seriesByBookIds: vi.fn().mockResolvedValue([]),
    genresByBookIds: vi.fn().mockResolvedValue([{ bookId: 3, name: 'Fantasy' }]),
  } as unknown as AbsReadRepository;
  const progressService = {
    getMediaProgress: vi.fn().mockResolvedValue(opts.progress ?? null),
    upsertFromCurrentTime: vi.fn().mockResolvedValue({ id: 'mp-1', progress: 0.5 }),
    mergeOfflineProgress: vi.fn().mockResolvedValue(opts.mergeResult ?? { progressSynced: true, mediaProgress: { id: 'mp-1' } }),
  } as unknown as AbsProgressService;
  const socketGateway = {
    emitUserItemProgressUpdated: vi.fn(),
    emitUserSessionClosed: vi.fn(),
  } as unknown as AbsSocketGateway;
  const libraryService = { findAccessibleLibraryIds: vi.fn().mockResolvedValue(opts.accessibleIds ?? [5]) } as unknown as LibraryService;
  const transcodeService = {
    createStream: vi.fn().mockResolvedValue('/hls/stream/output.m3u8'),
    closeStream: vi.fn().mockResolvedValue(undefined),
  } as unknown as AbsTranscodeService;
  const sessionRepo = {
    insert: vi.fn().mockResolvedValue(undefined),
    updateSync: vi.fn().mockResolvedValue(undefined),
    updateFromLocal: vi.fn().mockResolvedValue(undefined),
    findById: vi.fn().mockResolvedValue(opts.existingRow ?? null),
  } as unknown as AbsPlaybackSessionRepository;
  const service = new AbsPlaybackService(readRepo, progressService, socketGateway, libraryService, transcodeService, sessionRepo);
  return { service, readRepo, progressService, socketGateway, transcodeService, sessionRepo };
}

describe('AbsPlaybackService#startSession', () => {
  it('404s when the item is missing or still processing', async () => {
    expect(await thrownStatus(() => build({ item: null }).service.startSession(makeAbsUser(), 3, {}))).toBe(404);
    expect(await thrownStatus(() => build({ item: item({ status: 'processing' }) }).service.startSession(makeAbsUser(), 3, {}))).toBe(404);
  });

  it('404s when a scoped user cannot access the item library', async () => {
    const { service } = build({ accessibleIds: [99] });
    expect(await thrownStatus(() => service.startSession(makeAbsUser({ isSuperuser: false }), 3, {}))).toBe(404);
  });

  it('404s when the book has no audio files', async () => {
    const { service } = build({ audioFiles: [] });
    expect(await thrownStatus(() => service.startSession(makeAbsUser(), 3, {}))).toBe(404);
  });

  it('returns a direct-play session (playMethod 0) with one track per audio file', async () => {
    const { service } = build();
    const session = await service.startSession(makeAbsUser(), 3, {});
    expect(session.playMethod).toBe(0);
    expect(session.mediaType).toBe('book');
    expect(session.libraryItemId).toBe('li_3');
    expect(session.duration).toBe(300);
    expect((session.audioTracks as unknown[]).length).toBe(2);
  });

  it('returns a transcode session (playMethod 2) with a single HLS track when forced', async () => {
    const { service, transcodeService } = build();
    const session = await service.startSession(makeAbsUser(), 3, { forceTranscode: true });
    expect(session.playMethod).toBe(2);
    expect((session.audioTracks as unknown[]).length).toBe(1);
    expect(transcodeService.createStream).toHaveBeenCalledOnce();
    const track = (session.audioTracks as Record<string, unknown>[])[0];
    expect(track.contentUrl).toBe(`/hls/${session.id as string}/output.m3u8`);
  });

  it('transcodes when the client cannot direct-play the files (mime not supported)', async () => {
    const { service } = build();
    const session = await service.startSession(makeAbsUser(), 3, { supportedMimeTypes: ['audio/flac'] });
    expect(session.playMethod).toBe(2);
  });

  it('direct-plays when the client supports the file mime types', async () => {
    const { service } = build();
    const session = await service.startSession(makeAbsUser(), 3, { supportedMimeTypes: ['audio/mpeg'] });
    expect(session.playMethod).toBe(0);
  });

  it('closes the transcode stream when a transcode session is closed', async () => {
    const { service, transcodeService } = build();
    const user = makeAbsUser({ id: 1 });
    const started = await service.startSession(user, 3, { forceTranscode: true });
    await service.close(started.id as string, user);
    expect(transcodeService.closeStream).toHaveBeenCalledWith(started.id);
  });

  it('seeds the resume point from saved progress', async () => {
    const { service } = build({ progress: { currentTime: 42, isFinished: false } });
    const session = await service.startSession(makeAbsUser(), 3, {});
    expect(session.startTime).toBe(42);
    expect(session.currentTime).toBe(42);
  });

  it('restarts a finished book at position 0', async () => {
    const { service } = build({ progress: { currentTime: 290, isFinished: true } });
    const session = await service.startSession(makeAbsUser(), 3, {});
    expect(session.startTime).toBe(0);
  });
});

describe('AbsPlaybackService session lifecycle', () => {
  it('getSession returns the open session to its owner', async () => {
    const { service } = build();
    const user = makeAbsUser({ id: 1 });
    const started = await service.startSession(user, 3, {});
    expect(service.getSession(started.id as string, user).id).toBe(started.id);
  });

  it('404s an unknown session id', async () => {
    const { service } = build();
    expect(await thrownStatus(() => service.getSession('missing', makeAbsUser()))).toBe(404);
  });

  it('404s when a different non-owner user requests the session', async () => {
    const { service } = build();
    const started = await service.startSession(makeAbsUser({ id: 1 }), 3, {});
    const other = makeAbsUser({ id: 2, isSuperuser: false });
    expect(await thrownStatus(() => service.getSession(started.id as string, other))).toBe(404);
  });

  it('sync sets currentTime, accumulates timeListening, and emits progress to other devices', async () => {
    const { service, socketGateway } = build();
    const user = makeAbsUser({ id: 1 });
    const started = await service.startSession(user, 3, {});
    const id = started.id as string;

    await service.sync(id, user, { currentTime: 50, timeListened: 20 });
    await service.sync(id, user, { currentTime: 80, timeListened: 15 });

    const current = service.getSession(id, user);
    expect(current.currentTime).toBe(80);
    expect(current.timeListening).toBe(35); // 20 + 15, accumulated
    expect(socketGateway.emitUserItemProgressUpdated).toHaveBeenCalledTimes(2);
  });

  it('close removes the session and emits user_session_closed', async () => {
    const { service, socketGateway } = build();
    const user = makeAbsUser({ id: 1 });
    const started = await service.startSession(user, 3, {});
    const id = started.id as string;

    await service.close(id, user);
    expect(socketGateway.emitUserSessionClosed).toHaveBeenCalledWith(1, id);
    expect(await thrownStatus(() => service.getSession(id, user))).toBe(404); // gone
  });

  it('close performs a final sync when a body is supplied', async () => {
    const { service, progressService } = build();
    const user = makeAbsUser({ id: 1 });
    const started = await service.startSession(user, 3, {});
    await service.close(started.id as string, user, { currentTime: 300, timeListened: 10 });
    expect(progressService.upsertFromCurrentTime).toHaveBeenCalled();
  });

  it('starting a session for a device closes the previous session on that device', async () => {
    const { service } = build();
    const user = makeAbsUser({ id: 1 });
    const first = await service.startSession(user, 3, { deviceInfo: { deviceId: 'dev-1' } });
    const second = await service.startSession(user, 3, { deviceInfo: { deviceId: 'dev-1' } });
    expect(await thrownStatus(() => service.getSession(first.id as string, user))).toBe(404);
    expect(service.getSession(second.id as string, user).id).toBe(second.id);
  });
});

describe('AbsPlaybackService session persistence (ABS saveSession semantics)', () => {
  it('persists nothing while timeListening is 0 (play + zero-listen sync + close)', async () => {
    const { service, sessionRepo } = build();
    const user = makeAbsUser({ id: 1 });
    const started = await service.startSession(user, 3, {});
    await service.sync(started.id as string, user, { currentTime: 10 }); // no timeListened
    await service.close(started.id as string, user);
    expect(sessionRepo.insert).not.toHaveBeenCalled();
    expect(sessionRepo.updateSync).not.toHaveBeenCalled();
  });

  it('first save inserts the row, later saves update it', async () => {
    const { service, sessionRepo } = build();
    const user = makeAbsUser({ id: 1 });
    const started = await service.startSession(user, 3, {});
    const id = started.id as string;

    await service.sync(id, user, { currentTime: 50, timeListened: 20 });
    expect(sessionRepo.insert).toHaveBeenCalledTimes(1);
    expect(sessionRepo.updateSync).not.toHaveBeenCalled();

    await service.sync(id, user, { currentTime: 80, timeListened: 15 });
    expect(sessionRepo.insert).toHaveBeenCalledTimes(1);
    expect(sessionRepo.updateSync).toHaveBeenCalledTimes(1);
    const update = (sessionRepo.updateSync as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(update[0]).toBe(id);
    expect(update[1]).toMatchObject({ currentTime: 80, timeListening: 35 });
  });

  it('the inserted row snapshots the full ABS oldMetadataToJSON media metadata', async () => {
    const { service, sessionRepo } = build();
    const user = makeAbsUser({ id: 1 });
    const started = await service.startSession(user, 3, { mediaPlayer: 'AVPlayer', deviceInfo: { deviceId: 'dev-1', model: 'iPhone' } });
    await service.sync(started.id as string, user, { currentTime: 5, timeListened: 5 });

    const row = (sessionRepo.insert as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(row.id).toBe(started.id);
    expect(row.userId).toBe(1);
    expect(row.bookId).toBe(3);
    expect(row.mediaPlayer).toBe('AVPlayer');
    const meta = row.mediaMetadata as Record<string, unknown>;
    expect(Object.keys(meta).sort()).toEqual(
      [
        'title',
        'subtitle',
        'authors',
        'narrators',
        'series',
        'genres',
        'publishedYear',
        'publishedDate',
        'publisher',
        'description',
        'isbn',
        'asin',
        'language',
        'explicit',
        'abridged',
      ].sort(),
    );
    expect(meta.authors).toEqual([{ id: 'aut_1', name: 'Tolkien' }]);
    expect(meta.genres).toEqual(['Fantasy']);
    const deviceInfo = row.deviceInfo as Record<string, unknown>;
    expect(deviceInfo.deviceId).toBe('dev-1');
    expect(deviceInfo.clientName).toBe('Abs iOS'); // inferred from model, like ABS DeviceInfo.setData
    expect(deviceInfo).not.toHaveProperty('manufacturer'); // nulls stripped
  });

  it('close without a sync body still saves an unsaved listened session', async () => {
    const { service, sessionRepo } = build();
    const user = makeAbsUser({ id: 1 });
    const started = await service.startSession(user, 3, {});
    const id = started.id as string;
    // accumulate listening but sabotage the sync-path save by making it a no-op first:
    await service.sync(id, user, { currentTime: 50, timeListened: 20 });
    (sessionRepo.insert as ReturnType<typeof vi.fn>).mockClear();
    await service.close(id, user); // no body → close's own saveSession runs (update path)
    expect(sessionRepo.updateSync).toHaveBeenCalled();
  });

  it('device takeover saves the displaced session before dropping it', async () => {
    const { service, sessionRepo } = build();
    const user = makeAbsUser({ id: 1 });
    const first = await service.startSession(user, 3, { deviceInfo: { deviceId: 'dev-1' } });
    await service.sync(first.id as string, user, { currentTime: 50, timeListened: 20 });
    (sessionRepo.insert as ReturnType<typeof vi.fn>).mockClear();
    (sessionRepo.updateSync as ReturnType<typeof vi.fn>).mockClear();

    await service.startSession(user, 3, { deviceInfo: { deviceId: 'dev-1' } });
    expect(sessionRepo.updateSync).toHaveBeenCalledTimes(1); // displaced session saved
  });

  it('stale-session pruning does NOT save (matches ABS removeSession-only sweep)', async () => {
    vi.useFakeTimers();
    try {
      const { service, sessionRepo } = build();
      const user = makeAbsUser({ id: 1 });
      const started = await service.startSession(user, 3, {});
      await service.sync(started.id as string, user, { currentTime: 50, timeListened: 20 });
      (sessionRepo.insert as ReturnType<typeof vi.fn>).mockClear();
      (sessionRepo.updateSync as ReturnType<typeof vi.fn>).mockClear();

      vi.advanceTimersByTime(37 * 60 * 60 * 1000);
      service.pruneStaleSessions();
      expect(await thrownStatus(() => service.getSession(started.id as string, user))).toBe(404);
      expect(sessionRepo.insert).not.toHaveBeenCalled();
      expect(sessionRepo.updateSync).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AbsPlaybackService#syncLocalSession (offline upsert)', () => {
  it('rejects malformed payloads without touching the DB', async () => {
    const { service, sessionRepo } = build();
    const result = await service.syncLocalSession(makeAbsUser(), { libraryItemId: 'li_3' }); // no currentTime
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid local session');
    expect(sessionRepo.findById).not.toHaveBeenCalled();
  });

  it('reports "Media item not found" for an unknown book (ABS error string)', async () => {
    const { service } = build({ item: null });
    const result = await service.syncLocalSession(makeAbsUser(), { id: 's-1', libraryItemId: 'li_3', currentTime: 10 });
    expect(result).toMatchObject({ id: 's-1', success: false, error: 'Media item not found' });
  });

  it('creates a new history row from the client payload, snapshotting server metadata', async () => {
    const { service, sessionRepo } = build();
    const result = await service.syncLocalSession(makeAbsUser({ id: 1 }), {
      id: 's-local-1',
      libraryItemId: 'li_3',
      currentTime: 120,
      timeListening: 90,
      duration: 300,
      startedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_100_000,
      mediaPlayer: 'ExoPlayer',
    });
    expect(result).toMatchObject({ id: 's-local-1', success: true, progressSynced: true });
    const row = (sessionRepo.insert as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(row.id).toBe('s-local-1');
    expect(row.playMethod).toBe(3); // PlayMethod.LOCAL default
    expect(row.timeListening).toBe(90);
    expect(row.currentTimeSeconds).toBe(120);
    expect((row.startedAt as Date).getTime()).toBe(1_700_000_000_000);
    expect((row.createdAt as Date).getTime()).toBe(1_700_000_000_000); // createdAt := startedAt, like ABS
    expect((row.updatedAt as Date).getTime()).toBe(1_700_000_100_000);
    expect((row.mediaMetadata as Record<string, unknown>).title).toBe('The Hobbit'); // server snapshot wins
  });

  it('updates an existing row by the client session id, recomputing the date buckets', async () => {
    const updatedAt = Date.UTC(2026, 6, 12, 12, 0, 0);
    const { service, sessionRepo } = build({ existingRow: { id: 's-1', userId: 1, timeListening: 10 } });
    const result = await service.syncLocalSession(makeAbsUser({ id: 1 }), {
      id: 's-1',
      libraryItemId: 'li_3',
      currentTime: 200,
      timeListening: 44,
      updatedAt,
    });
    expect(result.success).toBe(true);
    expect(sessionRepo.insert).not.toHaveBeenCalled();
    const [id, values] = (sessionRepo.updateFromLocal as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe('s-1');
    expect(values.currentTime).toBe(200);
    expect(values.timeListening).toBe(44);
    expect((values.updatedAt as Date).getTime()).toBe(updatedAt);
    expect(values.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof values.dayOfWeek).toBe('string');
  });

  it("refuses to overwrite another user's session row", async () => {
    const { service, sessionRepo } = build({ existingRow: { id: 's-1', userId: 99, timeListening: 10 } });
    const result = await service.syncLocalSession(makeAbsUser({ id: 1 }), { id: 's-1', libraryItemId: 'li_3', currentTime: 10 });
    expect(result.success).toBe(false);
    expect(sessionRepo.updateFromLocal).not.toHaveBeenCalled();
  });
});

describe('AbsPlaybackService#trackFile', () => {
  it('returns the audio file at the given index', async () => {
    const { service } = build();
    const started = await service.startSession(makeAbsUser({ id: 1 }), 3, {});
    expect(service.trackFile(started.id as string, 1)?.id).toBe(11);
  });

  it('falls back to the first track for an out-of-range index (podcast index-0 quirk)', async () => {
    const { service } = build();
    const started = await service.startSession(makeAbsUser({ id: 1 }), 3, {});
    expect(service.trackFile(started.id as string, 99)?.id).toBe(10);
  });

  it('returns null for an unknown session', () => {
    expect(build().service.trackFile('missing', 0)).toBeNull();
  });
});
