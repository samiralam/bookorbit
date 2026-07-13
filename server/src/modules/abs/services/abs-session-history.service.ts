import { Injectable } from '@nestjs/common';

import type { RequestUser } from '../../../common/types/request-user';
import type { AbsPlaybackSessionRow } from '../../../db/schema';
import { AbsHttpException } from '../abs-errors';
import { decodeAbsId, encodeAbsId } from '../abs-id.util';
import { AbsPlaybackSessionRepository } from '../abs-playback-session.repository';
import { AbsReadRepository } from '../abs-read.repository';
import { absDateParts, toAbsSessionJson } from '../mappers/abs-session.mapper';
import { AbsProgressService } from './abs-progress.service';

/**
 * Read side of the persisted listening-session log: `/me/listening-sessions` (+ per-item variant),
 * `/me/listening-stats`, `/me/stats/year/:year`. Each reduction mirrors its ABS counterpart
 * (`ApiRouter.getUserListeningStatsHelpers`, `utils/queries/userStats.js getStatsForYear`)
 * bug-for-bug, since strict clients decode these payloads verbatim.
 */
@Injectable()
export class AbsSessionHistoryService {
  constructor(
    private readonly sessionRepo: AbsPlaybackSessionRepository,
    private readonly readRepo: AbsReadRepository,
    private readonly progressService: AbsProgressService,
  ) {}

  /** Paginated history envelope (ABS `MeController.getListeningSessions`). */
  async listeningSessions(user: RequestUser, query: Record<string, string>): Promise<Record<string, unknown>> {
    const rows = await this.sessionRepo.listForUser(user.id);
    return this.paginate(rows, query);
  }

  /** Per-item history; 404s when the item does not exist (ABS looks the item up first). */
  async itemListeningSessions(user: RequestUser, libraryItemId: string, query: Record<string, string>): Promise<Record<string, unknown>> {
    const bookId = decodeAbsId('libraryItem', libraryItemId);
    if (bookId === null) throw AbsHttpException.notFound();
    const item = await this.readRepo.findItem(bookId);
    if (!item) throw AbsHttpException.notFound();
    const rows = await this.sessionRepo.listForUser(user.id, { bookId });
    return this.paginate(rows, query);
  }

  /** Aggregate stats (ABS `ApiRouter.getUserListeningStatsHelpers`). */
  async listeningStats(user: RequestUser): Promise<Record<string, unknown>> {
    const rows = await this.sessionRepo.listForUser(user.id); // already updatedAt desc
    const today = absDateParts(new Date()).date;

    let totalTime = 0;
    const items: Record<string, Record<string, unknown>> = {};
    const days: Record<string, number> = {};
    const dayOfWeek: Record<string, number> = {};
    let todayTime = 0;

    for (const s of rows) {
      const time = s.timeListening;
      if (s.dayOfWeek) dayOfWeek[s.dayOfWeek] = (dayOfWeek[s.dayOfWeek] ?? 0) + time;
      if (s.date && time > 0) {
        days[s.date] = (days[s.date] ?? 0) + time;
        if (s.date === today) todayTime += time;
      }
      const itemId = encodeAbsId('libraryItem', s.bookId);
      if (!items[itemId]) {
        // NOTE: no `lastUpdate` key — ABS 2.35.1 reads it off an object where it is undefined,
        // so the serialized JSON drops the key entirely. Match that, don't invent a value.
        items[itemId] = { id: itemId, timeListening: time, mediaMetadata: s.mediaMetadata };
      } else {
        items[itemId].timeListening = (items[itemId].timeListening as number) + time;
      }
      totalTime += time;
    }

    return {
      totalTime,
      items,
      days,
      dayOfWeek,
      today: todayTime,
      recentSessions: rows.slice(0, 10).map(toAbsSessionJson),
    };
  }

  /** Year-in-review (ABS `userStats.js getStatsForYear`), books-only. */
  async statsForYear(user: RequestUser, year: number): Promise<Record<string, unknown>> {
    const sessions = await this.sessionRepo.listForUserCreatedInYear(user.id, year);

    // Finished side: BookOrbit has no persisted finishedAt, so the MediaProgress mapping's
    // approximation (finishedAt := progress row updatedAt once past the library finish threshold)
    // stands in for ABS's real finished timestamps.
    const yearStart = new Date(year, 0, 1).getTime();
    const yearEnd = new Date(year + 1, 0, 1).getTime();
    const allProgress = await this.progressService.listMediaProgressForUser(user.id);
    const finishedAll = allProgress.filter(
      (p) => p.isFinished === true && typeof p.finishedAt === 'number' && p.finishedAt >= yearStart && p.finishedAt < yearEnd,
    );

    const finishedBookIds = finishedAll.map((p) => decodeAbsId('libraryItem', String(p.libraryItemId))).filter((id): id is number => id !== null);
    const finishedItems = new Map((await this.readRepo.findItemsByIds(finishedBookIds)).map((i) => [i.id, i]));
    // ABS inner-joins the book row, so progress for since-deleted books drops out entirely.
    const finished = finishedAll.filter((p) => {
      const bookId = decodeAbsId('libraryItem', String(p.libraryItemId));
      return bookId !== null && finishedItems.has(bookId);
    });

    const finishedBooksWithCovers: string[] = [];
    let longestAudiobookFinished: Record<string, unknown> | null = null;
    for (const p of finished) {
      const bookId = decodeAbsId('libraryItem', String(p.libraryItemId));
      const item = finishedItems.get(bookId as number)!;
      const itemId = String(p.libraryItemId);
      // Cover-file existence isn't checked (ABS does); an existing book row is the approximation.
      if (finishedBooksWithCovers.length < 5 && !finishedBooksWithCovers.includes(itemId)) {
        finishedBooksWithCovers.push(itemId);
      }
      const duration = typeof p.duration === 'number' ? p.duration : 0;
      if (duration > 0 && (!longestAudiobookFinished || duration > (longestAudiobookFinished.duration as number))) {
        longestAudiobookFinished = {
          id: encodeAbsId('book', item.id),
          title: item.title ?? '',
          duration: Math.round(duration),
          // ABS serializes the Sequelize DATE straight into the payload → ISO string.
          finishedAt: new Date(p.finishedAt as number).toISOString(),
        };
      }
    }

    let totalListeningTime = 0;
    const authorMap: Record<string, number> = {};
    const genreMap: Record<string, number> = {};
    const narratorMap: Record<string, number> = {};
    const monthMap: Record<number, number> = {};
    const bookMap: Record<string, number> = {};
    const booksWithCovers: string[] = [];
    const sessionBookIds = [...new Set(sessions.map((s) => s.bookId))];
    const sessionItems = new Map((await this.readRepo.findItemsByIds(sessionBookIds)).map((i) => [i.id, i]));

    for (const s of sessions) {
      const itemId = encodeAbsId('libraryItem', s.bookId);
      if (
        sessionItems.has(s.bookId) &&
        !booksWithCovers.includes(itemId) &&
        !finishedBooksWithCovers.includes(itemId) &&
        booksWithCovers.length < 25
      ) {
        booksWithCovers.push(itemId);
      }

      const time = s.timeListening || 0;
      const month = s.createdAt.getMonth();
      monthMap[month] = (monthMap[month] ?? 0) + time;
      totalListeningTime += time;

      if (s.displayTitle) bookMap[s.displayTitle] = (bookMap[s.displayTitle] ?? 0) + time;

      const meta = s.mediaMetadata as { authors?: { name: string }[]; narrators?: string[]; genres?: string[] };
      for (const au of meta.authors ?? []) authorMap[au.name] = (authorMap[au.name] ?? 0) + time;
      for (const narrator of meta.narrators ?? []) narratorMap[narrator] = (narratorMap[narrator] ?? 0) + time;
      // ABS filters out junk genres by SUBSTRING match, not equality.
      const genres = (meta.genres ?? []).filter((g) => g && !g.toLowerCase().includes('audiobook') && !g.toLowerCase().includes('audio book'));
      for (const genre of genres) genreMap[genre] = (genreMap[genre] ?? 0) + time;
    }

    const topAuthors = Object.keys(authorMap)
      .map((name) => ({ name, time: Math.round(authorMap[name]) }))
      .sort((a, b) => b.time - a.time)
      .slice(0, 3);
    const topGenres = Object.keys(genreMap)
      .map((genre) => ({ genre, time: Math.round(genreMap[genre]) }))
      .sort((a, b) => b.time - a.time)
      .slice(0, 3);

    let mostListenedNarrator: Record<string, unknown> | null = null;
    for (const name of Object.keys(narratorMap)) {
      if (!mostListenedNarrator || narratorMap[name] > (mostListenedNarrator.time as number)) {
        mostListenedNarrator = { time: Math.round(narratorMap[name]), name };
      }
    }
    let mostListenedMonth: Record<string, unknown> | null = null;
    for (const month of Object.keys(monthMap)) {
      if (!mostListenedMonth || monthMap[Number(month)] > (mostListenedMonth.time as number)) {
        mostListenedMonth = { month: Number(month), time: Math.round(monthMap[Number(month)]) };
      }
    }

    return {
      totalListeningSessions: sessions.length,
      totalListeningTime: Math.round(totalListeningTime),
      totalBookListeningTime: Math.round(totalListeningTime), // books-only server
      totalPodcastListeningTime: 0,
      topAuthors,
      topGenres,
      mostListenedNarrator,
      mostListenedMonth,
      numBooksFinished: finished.length,
      numBooksListened: Object.keys(bookMap).length,
      longestAudiobookFinished,
      booksWithCovers,
      finishedBooksWithCovers,
    };
  }

  /** ABS pagination: `itemsPerPage` default 10, `page` default 0, envelope with `numPages`. */
  private paginate(rows: AbsPlaybackSessionRow[], query: Record<string, string>): Record<string, unknown> {
    const parsed = Number.parseInt(query.itemsPerPage ?? '', 10);
    const itemsPerPage = Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
    const parsedPage = Number.parseInt(query.page ?? '', 10);
    const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 0;
    const start = page * itemsPerPage;
    return {
      total: rows.length,
      numPages: Math.ceil(rows.length / itemsPerPage),
      page,
      itemsPerPage,
      sessions: rows.slice(start, start + itemsPerPage).map(toAbsSessionJson),
    };
  }
}
