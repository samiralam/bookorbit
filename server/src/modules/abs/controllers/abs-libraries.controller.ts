import { Controller, Get, Param, Query, UseFilters, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import type { RequestUser } from '../../../common/types/request-user';
import { LibraryService } from '../../library/library.service';
import { AbsExceptionFilter } from '../abs-exception.filter';
import { AbsHttpException } from '../abs-errors';
import { decodeAbsId } from '../abs-id.util';
import { AbsAuthGuard } from '../auth/abs-auth.guard';
import { toAbsLibrary } from '../mappers/abs-library.mapper';
import { AbsCatalogService, parseAbsSort } from '../services/abs-catalog.service';

function toInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Library list/detail + the primary browse endpoint (REIMPLEMENTATION_GUIDE §4). */
@Public()
@UseGuards(AbsAuthGuard)
@UseFilters(AbsExceptionFilter)
@SkipThrottle()
@Controller('api/libraries')
export class AbsLibrariesController {
  constructor(
    private readonly libraryService: LibraryService,
    private readonly catalogService: AbsCatalogService,
  ) {}

  @Get()
  async list(@CurrentUser() user: RequestUser): Promise<Record<string, unknown>> {
    const libraries = await this.libraryService.findAll(user);
    return { libraries: libraries.map(toAbsLibrary) };
  }

  @Get(':id')
  async getOne(@CurrentUser() user: RequestUser, @Param('id') id: string): Promise<Record<string, unknown>> {
    const libraryId = decodeAbsId('library', id);
    if (libraryId === null) throw AbsHttpException.notFound();
    const accessible = await this.libraryService.findAccessibleLibraryIds(user);
    if (!user.isSuperuser && !accessible.includes(libraryId)) throw AbsHttpException.notFound();

    const library = await this.libraryService.findOne(libraryId).catch(() => null);
    if (!library) throw AbsHttpException.notFound();
    return toAbsLibrary(library);
  }

  @Get(':id/items')
  async items(@CurrentUser() user: RequestUser, @Param('id') id: string, @Query() query: Record<string, string>): Promise<Record<string, unknown>> {
    return this.catalogService.listLibraryItems(user, this.requireLibraryId(id), this.parseQuery(query));
  }

  /** Home-screen shelves. */
  @Get(':id/personalized')
  async personalized(@CurrentUser() user: RequestUser, @Param('id') id: string): Promise<Record<string, unknown>[]> {
    return this.catalogService.personalized(user, this.requireLibraryId(id));
  }

  /** Authors with a book in the library — the primary browse axis for author-centric clients. */
  @Get(':id/authors')
  async authors(@CurrentUser() user: RequestUser, @Param('id') id: string, @Query() query: Record<string, string>): Promise<Record<string, unknown>> {
    return this.catalogService.listAuthors(user, this.requireLibraryId(id), query);
  }

  /** Valid filter values/ids for the library. */
  @Get(':id/filterdata')
  async filterdata(@CurrentUser() user: RequestUser, @Param('id') id: string): Promise<Record<string, unknown>> {
    return this.catalogService.filterData(user, this.requireLibraryId(id));
  }

  /** Title/author search within the library. */
  @Get(':id/search')
  async search(@CurrentUser() user: RequestUser, @Param('id') id: string, @Query() query: Record<string, string>): Promise<Record<string, unknown>> {
    return this.catalogService.search(user, this.requireLibraryId(id), query.q ?? '', Math.max(0, toInt(query.limit, 12)));
  }

  /** Series in the library (paginated). */
  @Get(':id/series')
  async series(@CurrentUser() user: RequestUser, @Param('id') id: string, @Query() query: Record<string, string>): Promise<Record<string, unknown>> {
    return this.catalogService.listSeries(user, this.requireLibraryId(id), this.parseQuery(query));
  }

  /** User collections, restricted to this library (paginated). */
  @Get(':id/collections')
  async collections(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Query() query: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    return this.catalogService.listCollections(user, this.requireLibraryId(id), this.parseQuery(query));
  }

  /** Playlists are not modelled in BookOrbit; return an empty paginated envelope. */
  @Get(':id/playlists')
  playlists(@Param('id') id: string): Record<string, unknown> {
    this.requireLibraryId(id);
    return { results: [], total: 0, limit: 0, page: 0 };
  }

  private requireLibraryId(id: string): number {
    const libraryId = decodeAbsId('library', id);
    if (libraryId === null) throw AbsHttpException.notFound();
    return libraryId;
  }

  private parseQuery(query: Record<string, string>) {
    return {
      limit: Math.max(0, toInt(query.limit, 0)),
      page: Math.max(0, toInt(query.page, 0)),
      sort: parseAbsSort(query.sort),
      rawSort: query.sort,
      desc: query.desc === '1',
      minified: query.minified === '1',
      filter: query.filter,
    };
  }
}
