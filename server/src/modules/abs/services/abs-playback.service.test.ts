import type { LibraryService } from '../../library/library.service';
import type { AbsAudioFileRow, AbsItemRow, AbsReadRepository } from '../abs-read.repository';
import type { AbsSocketGateway } from '../abs-socket.gateway';
import { makeAbsUser, thrownStatus } from '../__testing__/abs-test-helpers';
import { AbsPlaybackService } from './abs-playback.service';
import type { AbsProgressService } from './abs-progress.service';

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
}

function build(opts: BuildOpts = {}) {
  const audioFiles = opts.audioFiles ?? [file(10, 100), file(11, 200)];
  const readRepo = {
    findItem: vi.fn().mockResolvedValue(opts.item === undefined ? item() : opts.item),
    audioFilesByBookId: vi.fn().mockResolvedValue(audioFiles),
    authorsByBookIds: vi.fn().mockResolvedValue([{ bookId: 3, id: 1, name: 'Tolkien' }]),
    narratorsByBookIds: vi.fn().mockResolvedValue([]),
    seriesByBookIds: vi.fn().mockResolvedValue([]),
  } as unknown as AbsReadRepository;
  const progressService = {
    getMediaProgress: vi.fn().mockResolvedValue(opts.progress ?? null),
    upsertFromCurrentTime: vi.fn().mockResolvedValue({ id: 'mp-1', progress: 0.5 }),
  } as unknown as AbsProgressService;
  const socketGateway = {
    emitUserItemProgressUpdated: vi.fn(),
    emitUserSessionClosed: vi.fn(),
  } as unknown as AbsSocketGateway;
  const libraryService = { findAccessibleLibraryIds: vi.fn().mockResolvedValue(opts.accessibleIds ?? [5]) } as unknown as LibraryService;
  const service = new AbsPlaybackService(readRepo, progressService, socketGateway, libraryService);
  return { service, readRepo, progressService, socketGateway };
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
