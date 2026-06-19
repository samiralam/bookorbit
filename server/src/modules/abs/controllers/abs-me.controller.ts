import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseFilters, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import type { RequestUser } from '../../../common/types/request-user';
import { LibraryService } from '../../library/library.service';
import { AbsExceptionFilter } from '../abs-exception.filter';
import { AbsHttpException } from '../abs-errors';
import { decodeAbsId, encodeAbsId } from '../abs-id.util';
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
}
