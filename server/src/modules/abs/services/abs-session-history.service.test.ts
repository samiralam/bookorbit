import type { AbsPlaybackSessionRow } from '../../../db/schema';
import type { AbsPlaybackSessionRepository } from '../abs-playback-session.repository';
import type { AbsItemRow, AbsReadRepository } from '../abs-read.repository';
import { makeAbsUser, thrownStatus } from '../__testing__/abs-test-helpers';
import { AbsSessionHistoryService } from './abs-session-history.service';
import type { AbsProgressService } from './abs-progress.service';

function row(overrides: Partial<AbsPlaybackSessionRow> = {}): AbsPlaybackSessionRow {
  return {
    id: `s-${Math.random().toString(36).slice(2)}`,
    userId: 1,
    libraryId: 4,
    bookId: 42,
    displayTitle: 'The Hobbit',
    displayAuthor: 'Tolkien',
    coverPath: '/metadata/items/42/cover',
    mediaMetadata: { title: 'The Hobbit', authors: [{ id: 'aut_1', name: 'Tolkien' }], narrators: ['Serkis'], genres: ['Fantasy', 'Audiobook'] },
    chapters: [],
    duration: 300,
    playMethod: 0,
    mediaPlayer: 'AVPlayer',
    deviceInfo: {},
    serverVersion: '2.35.1',
    date: '2026-07-10',
    dayOfWeek: 'Friday',
    timeListening: 60,
    startTimeSeconds: 0,
    currentTimeSeconds: 60,
    startedAt: new Date(2026, 6, 10, 9, 0),
    createdAt: new Date(2026, 6, 10, 9, 0),
    updatedAt: new Date(2026, 6, 10, 9, 5),
    ...overrides,
  };
}

function item(id: number, overrides: Partial<AbsItemRow> = {}): AbsItemRow {
  return {
    id,
    libraryId: 4,
    status: 'ready',
    addedAt: new Date(),
    updatedAt: new Date(),
    title: `Book ${id}`,
    subtitle: null,
    description: null,
    publishedYear: null,
    publisher: null,
    language: null,
    isbn13: null,
    isbn10: null,
    seriesName: null,
    seriesIndex: null,
    durationSeconds: null,
    chapters: [],
    ...overrides,
  };
}

interface BuildOpts {
  rows?: AbsPlaybackSessionRow[];
  yearRows?: AbsPlaybackSessionRow[];
  items?: AbsItemRow[];
  progress?: Record<string, unknown>[];
  findItem?: AbsItemRow | null;
}

function build(opts: BuildOpts = {}) {
  const sessionRepo = {
    listForUser: vi.fn().mockResolvedValue(opts.rows ?? []),
    listForUserCreatedInYear: vi.fn().mockResolvedValue(opts.yearRows ?? []),
  } as unknown as AbsPlaybackSessionRepository;
  const readRepo = {
    findItem: vi.fn().mockResolvedValue(opts.findItem === undefined ? item(42) : opts.findItem),
    findItemsByIds: vi.fn().mockResolvedValue(opts.items ?? [item(42)]),
  } as unknown as AbsReadRepository;
  const progressService = {
    listMediaProgressForUser: vi.fn().mockResolvedValue(opts.progress ?? []),
  } as unknown as AbsProgressService;
  return { service: new AbsSessionHistoryService(sessionRepo, readRepo, progressService), sessionRepo, readRepo };
}

describe('AbsSessionHistoryService#listeningSessions', () => {
  it('returns the ABS empty envelope when there is no history', async () => {
    const { service } = build();
    expect(await service.listeningSessions(makeAbsUser(), {})).toEqual({
      total: 0,
      numPages: 0,
      page: 0,
      itemsPerPage: 10,
      sessions: [],
    });
  });

  it('paginates with the ABS envelope math and maps sessions to the wire shape', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => row({ id: `s-${i}` }));
    const { service } = build({ rows });
    const first = await service.listeningSessions(makeAbsUser(), {});
    expect(first).toMatchObject({ total: 12, numPages: 2, page: 0, itemsPerPage: 10 });
    expect((first.sessions as unknown[]).length).toBe(10);
    const sessionJson = (first.sessions as Record<string, unknown>[])[0];
    expect(sessionJson.libraryItemId).toBe('li_42');
    expect(sessionJson.episodeId).toBeNull();
    expect(typeof sessionJson.startedAt).toBe('number');

    const second = await service.listeningSessions(makeAbsUser(), { page: '1', itemsPerPage: '10' });
    expect((second.sessions as unknown[]).length).toBe(2);
  });
});

describe('AbsSessionHistoryService#itemListeningSessions', () => {
  it('404s on a malformed id and on an unknown item', async () => {
    expect(await thrownStatus(() => build().service.itemListeningSessions(makeAbsUser(), 'nope', {}))).toBe(404);
    expect(await thrownStatus(() => build({ findItem: null }).service.itemListeningSessions(makeAbsUser(), 'li_42', {}))).toBe(404);
  });

  it('filters the history by book id', async () => {
    const { service, sessionRepo } = build({ rows: [row()] });
    const result = await service.itemListeningSessions(makeAbsUser({ id: 1 }), 'li_42', {});
    expect(sessionRepo.listForUser).toHaveBeenCalledWith(1, { bookId: 42 });
    expect(result.total).toBe(1);
  });
});

describe('AbsSessionHistoryService#listeningStats', () => {
  it('returns the zeroed ABS shape when there is no history', async () => {
    const { service } = build();
    expect(await service.listeningStats(makeAbsUser())).toEqual({
      totalTime: 0,
      items: {},
      days: {},
      dayOfWeek: {},
      today: 0,
      recentSessions: [],
    });
  });

  it('accumulates totals, day buckets, and per-item entries WITHOUT a lastUpdate key', async () => {
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const rows = [
      row({ id: 's-1', timeListening: 60, date: todayStr, dayOfWeek: 'Sunday' }),
      row({ id: 's-2', timeListening: 40, date: '2026-07-10', dayOfWeek: 'Friday' }),
      row({ id: 's-3', bookId: 7, timeListening: 5, date: '2026-07-10', dayOfWeek: 'Friday' }),
    ];
    const { service } = build({ rows });
    const stats = await service.listeningStats(makeAbsUser());
    expect(stats.totalTime).toBe(105);
    expect(stats.today).toBe(60);
    expect(stats.days).toEqual({ [todayStr]: 60, '2026-07-10': 45 });
    expect(stats.dayOfWeek).toEqual({ Sunday: 60, Friday: 45 });
    const items = stats.items as Record<string, Record<string, unknown>>;
    expect(items.li_42.timeListening).toBe(100);
    expect(items.li_7.timeListening).toBe(5);
    expect(items.li_42).not.toHaveProperty('lastUpdate'); // ABS 2.35.1 drops the key (undefined)
    expect((stats.recentSessions as unknown[]).length).toBe(3);
  });
});

describe('AbsSessionHistoryService#statsForYear', () => {
  it('returns the zeroed ABS shape for an empty year', async () => {
    const { service } = build();
    const stats = await service.statsForYear(makeAbsUser(), 2026);
    expect(stats).toEqual({
      totalListeningSessions: 0,
      totalListeningTime: 0,
      totalBookListeningTime: 0,
      totalPodcastListeningTime: 0,
      topAuthors: [],
      topGenres: [],
      mostListenedNarrator: null,
      mostListenedMonth: null,
      numBooksFinished: 0,
      numBooksListened: 0,
      longestAudiobookFinished: null,
      booksWithCovers: [],
      finishedBooksWithCovers: [],
    });
  });

  it('aggregates authors/genres/narrators/months from session metadata, filtering junk genres by substring', async () => {
    const yearRows = [
      row({ id: 's-1', timeListening: 100, createdAt: new Date(2026, 2, 1) }),
      row({
        id: 's-2',
        bookId: 7,
        displayTitle: 'Dune',
        timeListening: 50,
        createdAt: new Date(2026, 5, 1),
        mediaMetadata: { title: 'Dune', authors: [{ id: 'aut_2', name: 'Herbert' }], narrators: [], genres: ['Sci-Fi Audiobooks'] },
      }),
    ];
    const { service } = build({ yearRows, items: [item(42), item(7)] });
    const stats = await service.statsForYear(makeAbsUser(), 2026);
    expect(stats.totalListeningSessions).toBe(2);
    expect(stats.totalListeningTime).toBe(150);
    expect(stats.topAuthors).toEqual([
      { name: 'Tolkien', time: 100 },
      { name: 'Herbert', time: 50 },
    ]);
    // 'Audiobook' and 'Sci-Fi Audiobooks' are both filtered by the SUBSTRING rule:
    expect(stats.topGenres).toEqual([{ genre: 'Fantasy', time: 100 }]);
    expect(stats.mostListenedNarrator).toEqual({ name: 'Serkis', time: 100 });
    expect(stats.mostListenedMonth).toEqual({ month: 2, time: 100 });
    expect(stats.numBooksListened).toBe(2); // distinct display titles
    expect(stats.booksWithCovers).toEqual(['li_42', 'li_7']);
  });

  it('computes the finished side from MediaProgress finishedAt within the year', async () => {
    const inYear = Date.UTC(2026, 3, 1);
    const outOfYear = Date.UTC(2025, 3, 1);
    const progress = [
      { libraryItemId: 'li_42', isFinished: true, finishedAt: inYear, duration: 300 },
      { libraryItemId: 'li_7', isFinished: true, finishedAt: outOfYear, duration: 900 },
      { libraryItemId: 'li_9', isFinished: false, finishedAt: null, duration: 100 },
    ];
    const { service } = build({ progress, items: [item(42, { title: 'The Hobbit' })] });
    const stats = await service.statsForYear(makeAbsUser(), 2026);
    expect(stats.numBooksFinished).toBe(1);
    expect(stats.finishedBooksWithCovers).toEqual(['li_42']);
    expect(stats.longestAudiobookFinished).toMatchObject({ id: 'bk_42', title: 'The Hobbit', duration: 300 });
    expect(typeof (stats.longestAudiobookFinished as Record<string, unknown>).finishedAt).toBe('string'); // ISO, like ABS
  });
});
