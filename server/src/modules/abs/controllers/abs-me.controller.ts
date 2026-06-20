import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseFilters, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import type { RequestUser } from '../../../common/types/request-user';
import { LibraryService } from '../../library/library.service';
import { AbsExceptionFilter } from '../abs-exception.filter';
import { AbsHttpException } from '../abs-errors';
import { ABS_ID_PREFIX, decodeAbsId, encodeAbsId } from '../abs-id.util';
import { AbsAuthGuard } from '../auth/abs-auth.guard';
import { toAbsUser } from '../mappers/abs-user.mapper';
import { AbsBookmarkService } from '../services/abs-bookmark.service';
import { AbsCatalogService } from '../services/abs-catalog.service';
import { AbsProgressService, type AbsProgressBody } from '../services/abs-progress.service';

interface BookmarkBody {
  time?: number;
  title?: string;
}

/** Current-user endpoint + progress upserts (REIMPLEMENTATION_GUIDE §3, §7.1). */
@Public()
@UseGuards(AbsAuthGuard)
@UseFilters(AbsExceptionFilter)
@Controller('api/me')
export class AbsMeController {
  constructor(
    private readonly progressService: AbsProgressService,
    private readonly libraryService: LibraryService,
    private readonly catalogService: AbsCatalogService,
    private readonly bookmarkService: AbsBookmarkService,
  ) {}

  @Get()
  async me(@CurrentUser() user: RequestUser): Promise<Record<string, unknown>> {
    const [mediaProgress, bookmarks, accessibleIds] = await Promise.all([
      this.progressService.listMediaProgressForUser(user.id),
      this.bookmarkService.listForUser(user.id),
      this.libraryService.findAccessibleLibraryIds(user),
    ]);
    return toAbsUser(user, {
      mediaProgress,
      bookmarks,
      librariesAccessible: user.isSuperuser ? [] : accessibleIds.map((id) => encodeAbsId('library', id)),
    });
  }

  /** Continue-listening shelf. */
  @Get('items-in-progress')
  async itemsInProgress(@CurrentUser() user: RequestUser): Promise<Record<string, unknown>> {
    const libraryItems = await this.catalogService.itemsInProgress(user);
    return { libraryItems };
  }

  /**
   * Paginated listening history (REIMPLEMENTATION_GUIDE §8). BookOrbit does not retain ABS-shaped
   * historical sessions, so this returns an empty page in the ABS envelope — enough for clients
   * (e.g. Prologue) that probe it on connect and render a "History" tab.
   */
  @Get('listening-sessions')
  listeningSessions(@Query() query: Record<string, string>): Record<string, unknown> {
    const parsed = Number.parseInt(query.itemsPerPage ?? '', 10);
    const itemsPerPage = Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
    const parsedPage = Number.parseInt(query.page ?? '', 10);
    const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 0;
    return { total: 0, numPages: 0, page, itemsPerPage, sessions: [] };
  }

  /** Read one MediaProgress; 404 when there is none. Episode segment is ignored (no podcasts). */
  @Get('progress/:id/:episodeId?')
  async getProgress(@CurrentUser() user: RequestUser, @Param('id') id: string): Promise<Record<string, unknown>> {
    const bookId = decodeAbsId('libraryItem', id);
    if (bookId === null) throw AbsHttpException.notFound();
    const progress = await this.progressService.getMediaProgressByBook(user.id, bookId);
    if (!progress) throw AbsHttpException.notFound();
    return progress;
  }

  /** Stateless upsert of one MediaProgress. */
  @Patch('progress/:libraryItemId/:episodeId?')
  @HttpCode(200)
  async updateProgress(
    @CurrentUser() user: RequestUser,
    @Param('libraryItemId') libraryItemId: string,
    @Body() body: AbsProgressBody,
  ): Promise<Record<string, unknown>> {
    const bookId = decodeAbsId('libraryItem', libraryItemId);
    if (bookId === null) throw AbsHttpException.notFound();
    const progress = await this.progressService.upsertFromBody(user.id, bookId, body ?? {});
    if (!progress) throw AbsHttpException.notFound();
    return progress;
  }

  /** Batch upsert; each entry carries its own `libraryItemId`. Best-effort, returns 200. */
  @Patch('progress/batch/update')
  @HttpCode(200)
  async batchUpdateProgress(@CurrentUser() user: RequestUser, @Body() body: Array<AbsProgressBody & { libraryItemId?: string }>): Promise<void> {
    if (!Array.isArray(body)) return;
    for (const entry of body) {
      const bookId = entry.libraryItemId ? decodeAbsId('libraryItem', entry.libraryItemId) : null;
      if (bookId === null) continue;
      await this.progressService.upsertFromBody(user.id, bookId, entry);
    }
  }

  /**
   * Delete a MediaProgress. ABS addresses it by the composite progress id (`usr_<u>-li_<b>`, as built
   * in `AbsProgressService#toMediaProgress`); we also accept a bare `li_<b>`. The user segment, when
   * present, must match the caller so one user can't clear another's progress. 404 when nothing exists.
   */
  @Delete('progress/:id')
  @HttpCode(200)
  async deleteProgress(@CurrentUser() user: RequestUser, @Param('id') id: string): Promise<void> {
    const bookId = this.resolveProgressBookId(user, id);
    if (bookId === null) throw AbsHttpException.notFound();
    const removed = await this.progressService.deleteProgress(user.id, bookId);
    if (!removed) throw AbsHttpException.notFound();
  }

  /**
   * Per-item listening history (REIMPLEMENTATION_GUIDE §8). Like `listening-sessions`, BookOrbit keeps
   * no ABS-shaped sessions, so this is an empty page; the id is still decoded to 404 on garbage input.
   */
  @Get('item/listening-sessions/:libraryItemId/:episodeId?')
  itemListeningSessions(@Param('libraryItemId') libraryItemId: string, @Query() query: Record<string, string>): Record<string, unknown> {
    if (decodeAbsId('libraryItem', libraryItemId) === null) throw AbsHttpException.notFound();
    const parsed = Number.parseInt(query.itemsPerPage ?? '', 10);
    const itemsPerPage = Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
    const parsedPage = Number.parseInt(query.page ?? '', 10);
    const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 0;
    return { total: 0, numPages: 0, page, itemsPerPage, sessions: [] };
  }

  /**
   * Aggregate listening stats. BookOrbit retains no per-session history, so every bucket is empty —
   * enough for clients that render a stats screen without erroring on a missing payload.
   */
  @Get('listening-stats')
  listeningStats(): Record<string, unknown> {
    return { totalTime: 0, items: {}, days: {}, dayOfWeek: {}, today: 0, recentSessions: [] };
  }

  /** Year-in-review stats — zeroed for the same reason as `listening-stats` (no session history). */
  @Get('stats/year/:year')
  statsForYear(): Record<string, unknown> {
    return {
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
    };
  }

  /** Create (or rename in place) an audio bookmark at `{ time, title }`. */
  @Post('item/:id/bookmark')
  async createBookmark(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() body: BookmarkBody): Promise<Record<string, unknown>> {
    const bookId = decodeAbsId('libraryItem', id);
    if (bookId === null || typeof body?.time !== 'number') throw AbsHttpException.notFound();
    return this.bookmarkService.create(user.id, bookId, body.time, body.title ?? '');
  }

  /** Rename the bookmark at `{ time }`. */
  @Patch('item/:id/bookmark')
  async updateBookmark(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() body: BookmarkBody): Promise<Record<string, unknown>> {
    const bookId = decodeAbsId('libraryItem', id);
    if (bookId === null || typeof body?.time !== 'number') throw AbsHttpException.notFound();
    const updated = await this.bookmarkService.update(user.id, bookId, body.time, body.title ?? '');
    if (!updated) throw AbsHttpException.notFound();
    return updated;
  }

  /** Remove the bookmark at `:time`. */
  @Delete('item/:id/bookmark/:time')
  @HttpCode(200)
  async deleteBookmark(@CurrentUser() user: RequestUser, @Param('id') id: string, @Param('time') time: string): Promise<void> {
    const bookId = decodeAbsId('libraryItem', id);
    const seconds = Number.parseFloat(time);
    if (bookId === null || !Number.isFinite(seconds)) throw AbsHttpException.notFound();
    const removed = await this.bookmarkService.remove(user.id, bookId, seconds);
    if (!removed) throw AbsHttpException.notFound();
  }

  /**
   * Resolve the book id targeted by a delete-progress request. Accepts the composite progress id
   * `usr_<u>-li_<b>` or a bare `li_<b>`. Returns null (→ 404) on malformed input or when the user
   * segment names someone other than the caller.
   */
  private resolveProgressBookId(user: RequestUser, rawId: string): number | null {
    const segments = rawId.split('-');
    const userSegment = segments.find((seg) => seg.startsWith(`${ABS_ID_PREFIX.user}_`));
    if (userSegment !== undefined && decodeAbsId('user', userSegment) !== user.id) return null;
    const itemSegment = segments.find((seg) => seg.startsWith(`${ABS_ID_PREFIX.libraryItem}_`)) ?? rawId;
    return decodeAbsId('libraryItem', itemSegment);
  }
}
