import { Injectable } from '@nestjs/common';
import { type SQL } from 'drizzle-orm';

import { Permission } from '@bookorbit/types';

import type { RequestUser } from '../../../common/types/request-user';
import { LibraryService } from '../../library/library.service';
import { AbsHttpException } from '../abs-errors';
import { decodeAbsFilter } from '../abs-filter.util';
import { decodeAbsId, encodeAbsId } from '../abs-id.util';
import { AbsReadRepository, type AbsAudioFileRow, type AbsItemRow, type AbsItemSortField } from '../abs-read.repository';
import { toAbsAuthor } from '../mappers/abs-author.mapper';
import { toAbsLibraryItem, type AbsItemRelations } from '../mappers/abs-item.mapper';
import { AbsProgressService } from './abs-progress.service';

export interface AbsItemQuery {
  limit: number;
  page: number;
  sort: AbsItemSortField;
  /**
   * The raw `sort` query param. ABS echoes it verbatim as `sortBy` and OMITS the key when the
   * client sent no sort — envelopes must mirror that (undefined is dropped by JSON.stringify).
   */
  rawSort?: string;
  desc: boolean;
  minified: boolean;
  /** Raw `filter=group.base64url(value)` browse filter (REIMPLEMENTATION_GUIDE §4.2). */
  filter?: string;
}

function groupBy<T, K>(items: T[], keyFn: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  }
  return map;
}

/** Reorder fetched rows to match a desired book-id order (e.g. most-recently-updated first). */
function orderByIds(rows: AbsItemRow[], order: number[]): AbsItemRow[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return order.map((id) => byId.get(id)).filter((r): r is AbsItemRow => r != null);
}

/**
 * Group an author's already-assembled LibraryItems by the series they belong to, mirroring ABS's
 * `AuthorController` `include=series` shape (`{ id, name, items }`). Series come off each item's
 * mapped `media.metadata.series` so we don't re-query.
 */
function buildAuthorSeries(items: Record<string, unknown>[]): Record<string, unknown>[] {
  const byId = new Map<string, { id: string; name: string; items: Record<string, unknown>[] }>();
  for (const item of items) {
    const metadata = (item.media as Record<string, unknown> | undefined)?.metadata as Record<string, unknown> | undefined;
    const series = (metadata?.series as { id: string; name: string }[] | undefined) ?? [];
    for (const s of series) {
      let entry = byId.get(s.id);
      if (!entry) {
        entry = { id: s.id, name: s.name, items: [] };
        byId.set(s.id, entry);
      }
      entry.items.push(item);
    }
  }
  return [...byId.values()];
}

/** Maps ABS sort query strings to the columns the read repository can order by. */
export function parseAbsSort(sort: string | undefined): AbsItemSortField {
  if (!sort) return 'addedAt';
  if (sort.includes('title')) return 'title';
  if (sort.includes('publishedYear')) return 'publishedYear';
  return 'addedAt';
}

/** Assembles ABS LibraryItems from BookOrbit data, enforcing the user's library access. */
@Injectable()
export class AbsCatalogService {
  constructor(
    private readonly readRepo: AbsReadRepository,
    private readonly progressService: AbsProgressService,
    private readonly libraryService: LibraryService,
  ) {}

  private async assertLibraryAccess(user: RequestUser, libraryId: number): Promise<void> {
    if (user.isSuperuser) return;
    const accessible = await this.libraryService.findAccessibleLibraryIds(user);
    if (!accessible.includes(libraryId)) throw AbsHttpException.notFound();
  }

  /** ABS download routes are gated on `canDownload` (ENDPOINTS.md §2 — `jwt+canDownload`). */
  private assertCanDownload(user: RequestUser): void {
    if (user.isSuperuser || user.permissions.includes(Permission.LibraryDownload)) return;
    throw AbsHttpException.forbidden();
  }

  /** Decode a `group.base64` browse filter into a SQL predicate (id-based groups carry ABS ids). */
  private buildFilterWhere(raw: string | undefined): SQL | undefined {
    const decoded = decodeAbsFilter(raw);
    if (!decoded) return undefined;

    let value = decoded.value;
    if (decoded.group === 'authors') {
      const id = decodeAbsId('author', value);
      value = id != null ? String(id) : '';
    } else if (decoded.group === 'series') {
      const id = decodeAbsId('series', value);
      value = id != null ? String(id) : '';
    }
    return value ? this.readRepo.filterWhere(decoded.group, value) : undefined;
  }

  private async relationsFor(rows: AbsItemRow[]): Promise<Map<number, AbsItemRelations>> {
    const bookIds = rows.map((r) => r.id);
    const [authors, narrators, series, audioFiles] = await Promise.all([
      this.readRepo.authorsByBookIds(bookIds),
      this.readRepo.narratorsByBookIds(bookIds),
      this.readRepo.seriesByBookIds(bookIds),
      this.readRepo.audioFilesByBookIds(bookIds),
    ]);
    const authorsByBook = groupBy(authors, (a) => a.bookId);
    const narratorsByBook = groupBy(narrators, (n) => n.bookId);
    const seriesByBook = groupBy(series, (s) => s.bookId);
    const filesByBook = groupBy(audioFiles, (f) => f.bookId);

    const relations = new Map<number, AbsItemRelations>();
    for (const row of rows) {
      relations.set(row.id, {
        authors: authorsByBook.get(row.id) ?? [],
        narrators: narratorsByBook.get(row.id) ?? [],
        series: seriesByBook.get(row.id) ?? [],
        audioFiles: filesByBook.get(row.id) ?? [],
      });
    }
    return relations;
  }

  /** `GET /api/libraries/:id/items` — the primary browse endpoint envelope. */
  async listLibraryItems(user: RequestUser, libraryId: number, query: AbsItemQuery): Promise<Record<string, unknown>> {
    await this.assertLibraryAccess(user, libraryId);

    const offset = query.limit > 0 ? query.page * query.limit : 0;
    const { rows, total } = await this.readRepo.listItems({
      libraryId,
      limit: query.limit,
      offset,
      sort: query.sort,
      desc: query.desc,
      extraWhere: this.buildFilterWhere(query.filter),
    });
    const relations = await this.relationsFor(rows);

    // ABS's getLibraryItems always serializes list rows via toOldJSONMinified() regardless of the
    // `minified` query param, and never attaches userMediaProgress to list rows — clients read
    // progress from /api/me. Extra keys are as dangerous to strict Codable clients as missing ones.
    const results = rows.map((row) => toAbsLibraryItem(row, relations.get(row.id)!, { minified: true }));

    // Envelope mirrors ABS LibraryController.getLibraryItems exactly: sortBy/filterBy echo the raw
    // query params and are OMITTED (not null) when the client didn't send them.
    return {
      results,
      total,
      limit: query.limit,
      page: query.page,
      sortBy: query.rawSort,
      sortDesc: query.desc,
      filterBy: query.filter,
      mediaType: 'book',
      minified: query.minified,
      collapseseries: false,
      include: '',
      offset,
    };
  }

  /**
   * `GET /api/items/:id` — single expanded (or minified) item. With `?include=progress` ABS emits
   * the userMediaProgress key even when the user has none (explicit null); without it, no key.
   */
  async getLibraryItem(user: RequestUser, bookId: number, minified = false, includeProgress = false): Promise<Record<string, unknown>> {
    const item = await this.readRepo.findItem(bookId);
    if (!item || item.status === 'processing') throw AbsHttpException.notFound();
    await this.assertLibraryAccess(user, item.libraryId);

    const [relations, progress] = await Promise.all([
      this.relationsFor([item]),
      this.progressService.getMediaProgress(user.id, bookId, item.libraryId),
    ]);
    return toAbsLibraryItem(item, relations.get(item.id)!, {
      minified,
      mediaProgress: includeProgress ? (progress ?? null) : undefined,
    });
  }

  /** `POST /api/items/batch/get` — fetch many items by id, access-filtered (no progress, as ABS). */
  async getLibraryItemsBatch(user: RequestUser, bookIds: number[]): Promise<Record<string, unknown>[]> {
    const items = await this.readRepo.findItemsByIds(bookIds);
    const accessible = user.isSuperuser ? null : new Set(await this.libraryService.findAccessibleLibraryIds(user));
    const visible = items.filter((i) => i.status !== 'processing' && (!accessible || accessible.has(i.libraryId)));
    const relations = await this.relationsFor(visible);
    return visible.map((row) => toAbsLibraryItem(row, relations.get(row.id)!, {}));
  }

  /**
   * Assemble ABS LibraryItems for a set of already-fetched rows. Like ABS, list-shaped responses
   * (browse, series books, search, shelves) never attach userMediaProgress — only the single-item
   * detail endpoint does.
   */
  private async assembleItems(rows: AbsItemRow[], minified: boolean): Promise<Record<string, unknown>[]> {
    if (rows.length === 0) return [];
    const relations = await this.relationsFor(rows);
    return rows.map((row) => toAbsLibraryItem(row, relations.get(row.id)!, { minified }));
  }

  /** `GET /api/libraries/:id/search` — title/author search; client reads the `book` array. */
  async search(user: RequestUser, libraryId: number, query: string, limit: number): Promise<Record<string, unknown>> {
    await this.assertLibraryAccess(user, libraryId);
    const term = query.trim();
    if (!term) return { book: [], tags: [], authors: [], series: [] };

    const rows = await this.readRepo.searchItems(libraryId, term, limit);
    const items = await this.assembleItems(rows, true);
    return {
      book: items.map((libraryItem, i) => ({ libraryItem, matchKey: 'title', matchText: rows[i].title ?? '' })),
      tags: [],
      authors: [],
      series: [],
    };
  }

  /** `GET /api/libraries/:id/series` — paginated series with their books. */
  async listSeries(user: RequestUser, libraryId: number, query: AbsItemQuery): Promise<Record<string, unknown>> {
    await this.assertLibraryAccess(user, libraryId);
    const all = await this.readRepo.seriesInLibrary(libraryId);
    const total = all.length;
    const offset = query.limit > 0 ? query.page * query.limit : 0;
    const pageSeries = query.limit > 0 ? all.slice(offset, offset + query.limit) : all;

    const bookIds = [...new Set(pageSeries.flatMap((s) => s.books.map((b) => b.bookId)))];
    const rows = await this.readRepo.findItemsByIds(bookIds);
    // ABS serializes series books via toOldJSONMinified() (seriesFilters.getFilteredSeries),
    // regardless of the request's `minified` flag — match it so Prologue's minified decode succeeds.
    const itemsByBook = new Map((await this.assembleItems(rows, true)).map((it, i) => [rows[i].id, it]));

    // Element shape is EXACTLY ABS Series.toOldJSON + books (seriesFilters.getFilteredSeries):
    // no libraryItemIds, and totalDuration only exists when sorting by it — extra keys break strict
    // Codable clients whose optional properties decode stricter shapes than we'd send. BookOrbit has
    // no series description/timestamps, so those are null/0 (keys present, values empty).
    const libraryAbsId = encodeAbsId('library', libraryId);
    const results = pageSeries.map((s) => ({
      id: encodeAbsId('series', s.id),
      name: s.name,
      nameIgnorePrefix: s.name,
      description: null,
      addedAt: 0,
      updatedAt: 0,
      libraryId: libraryAbsId,
      books: s.books.map((b) => itemsByBook.get(b.bookId)).filter((it): it is Record<string, unknown> => it != null),
    }));

    // Envelope mirrors ABS getAllSeriesForLibrary: no offset key; sortBy/filterBy echo the raw
    // query params (omitted when absent); include is always present.
    return {
      results,
      total,
      limit: query.limit,
      page: query.page,
      sortBy: query.rawSort,
      sortDesc: query.desc,
      filterBy: query.filter,
      minified: query.minified,
      include: '',
    };
  }

  /** `GET /api/libraries/:id/collections` — paginated user collections with their books. */
  async listCollections(user: RequestUser, libraryId: number, query: AbsItemQuery): Promise<Record<string, unknown>> {
    await this.assertLibraryAccess(user, libraryId);
    const all = await this.readRepo.collectionsForUser(user.id, libraryId);
    const total = all.length;
    const offset = query.limit > 0 ? query.page * query.limit : 0;
    const page = query.limit > 0 ? all.slice(offset, offset + query.limit) : all;

    const bookIds = [...new Set(page.flatMap((c) => c.bookIds))];
    const rows = await this.readRepo.findItemsByIds(bookIds);
    // ABS serializes collection books via toOldJSONExpanded() (Collection.toOldJSONExpanded),
    // regardless of the request's `minified` flag — match it for a consistent strict-decode shape.
    const itemsByBook = new Map((await this.assembleItems(rows, false)).map((it, i) => [rows[i].id, it]));

    const results = page.map((c) => ({
      id: encodeAbsId('collection', c.id),
      libraryId: encodeAbsId('library', libraryId),
      name: c.name,
      description: c.description,
      books: c.bookIds.map((id) => itemsByBook.get(id)).filter((it): it is Record<string, unknown> => it != null),
      lastUpdate: 0,
      createdAt: 0,
    }));

    // Envelope mirrors ABS's library collections endpoint: no offset key, sortBy echoes the raw
    // query param (omitted when the client sent no sort), include always present.
    return {
      results,
      total,
      limit: query.limit,
      page: query.page,
      sortBy: query.rawSort,
      sortDesc: query.desc,
      minified: query.minified,
      include: '',
    };
  }

  /** `GET /api/libraries/:id/filterdata` — valid filter values/ids for the library. */
  async filterData(user: RequestUser, libraryId: number): Promise<Record<string, unknown>> {
    await this.assertLibraryAccess(user, libraryId);
    const data = await this.readRepo.filterData(libraryId);
    return {
      authors: data.authors.map((a) => ({ id: encodeAbsId('author', a.id), name: a.name })),
      genres: data.genres,
      tags: data.tags,
      series: data.series.map((s) => ({ id: encodeAbsId('series', s.id), name: s.name })),
      narrators: data.narrators,
      languages: data.languages,
      publishers: [],
    };
  }

  /**
   * `GET /api/libraries/:id/authors` — authors with a book in the library. Mirrors
   * `LibraryController.getAuthors`: a `limit`+`page` request (author-centric clients like Prologue
   * send `limit=50&page=0`) returns the paginated `{ results, … }` envelope and reads `.results`;
   * otherwise a bare `{ authors }`.
   */
  async listAuthors(user: RequestUser, libraryId: number, query: Record<string, string> = {}): Promise<Record<string, unknown>> {
    await this.assertLibraryAccess(user, libraryId);
    const libraryAbsId = encodeAbsId('library', libraryId);
    const authors = (await this.readRepo.authorsInLibrary(libraryId)).map((a) => toAbsAuthor(a, libraryAbsId));

    const isPaginated = query.limit != null && query.limit !== '' && !Number.isNaN(Number(query.limit)) && !Number.isNaN(Number(query.page));
    if (!isPaginated) return { authors };

    const limit = Number(query.limit);
    const page = Number(query.page);
    const start = limit > 0 ? page * limit : 0;
    return {
      results: limit > 0 ? authors.slice(start, start + limit) : authors,
      total: authors.length,
      limit,
      page,
      sortBy: query.sort,
      sortDesc: query.desc === '1',
      filterBy: query.filter,
      minified: query.minified === '1',
      // ABS echoes req.query.include verbatim — the key is OMITTED when the client sent none.
      include: query.include,
    };
  }

  /** `GET /api/authors/:id` — one author; `?include=items,series` eager-loads the author's books. */
  async getAuthor(user: RequestUser, authorId: number, include: string[]): Promise<Record<string, unknown>> {
    const author = await this.readRepo.findAuthor(authorId);
    if (!author) throw AbsHttpException.notFound();

    // BookOrbit authors are global; surface the library of any of the author's books so the ABS
    // Author object carries the non-optional libraryId strict clients require.
    const authorLibraryId = await this.readRepo.libraryIdForAuthor(authorId);
    const result = toAbsAuthor(author, authorLibraryId != null ? encodeAbsId('library', authorLibraryId) : '');
    if (include.includes('items')) {
      const bookIds = await this.readRepo.bookIdsForAuthor(authorId);
      const libraryItems = await this.itemsForBookIds(user, bookIds, true);
      result.numBooks = libraryItems.length;
      if (include.includes('series')) result.series = buildAuthorSeries(libraryItems);
      result.libraryItems = libraryItems;
    }
    return result;
  }

  /** `GET /api/libraries/:id/personalized` — home-screen shelves. */
  async personalized(user: RequestUser, libraryId: number): Promise<Record<string, unknown>[]> {
    await this.assertLibraryAccess(user, libraryId);

    const inProgress = await this.itemsInProgressForLibrary(user, libraryId);
    const { rows: recentRows } = await this.readRepo.listItems({ libraryId, limit: 10, offset: 0, sort: 'addedAt', desc: true });
    const recent = await this.assembleItems(recentRows, true);

    const shelves: Record<string, unknown>[] = [];
    if (inProgress.length > 0) {
      shelves.push({
        id: 'continue-listening',
        label: 'Continue Listening',
        labelStringKey: 'LabelContinueListening',
        type: 'book',
        entities: inProgress,
      });
    }
    shelves.push({ id: 'recently-added', label: 'Recently Added', labelStringKey: 'LabelRecentlyAdded', type: 'book', entities: recent });
    return shelves;
  }

  /** `GET /api/me/items-in-progress` — Continue-listening shelf across all accessible libraries. */
  async itemsInProgress(user: RequestUser): Promise<Record<string, unknown>[]> {
    const bookIds = await this.progressService.listInProgressBookIds(user.id);
    return this.itemsForBookIds(user, bookIds, true);
  }

  private async itemsInProgressForLibrary(user: RequestUser, libraryId: number): Promise<Record<string, unknown>[]> {
    // ABS respects hideFromContinueListening only on the home-page shelves, not items-in-progress.
    const bookIds = await this.progressService.listInProgressBookIds(user.id, { excludeHidden: true });
    const rows = (await this.readRepo.findItemsByIds(bookIds)).filter((r) => r.libraryId === libraryId);
    const ordered = orderByIds(rows, bookIds);
    return this.assembleItems(ordered, true);
  }

  private async itemsForBookIds(user: RequestUser, bookIds: number[], minified: boolean): Promise<Record<string, unknown>[]> {
    const items = await this.readRepo.findItemsByIds(bookIds);
    const accessible = user.isSuperuser ? null : new Set(await this.libraryService.findAccessibleLibraryIds(user));
    const visible = orderByIds(
      items.filter((i) => i.status !== 'processing' && (!accessible || accessible.has(i.libraryId))),
      bookIds,
    );
    return this.assembleItems(visible, minified);
  }

  private async progressMap(userId: number, rows: AbsItemRow[]): Promise<Map<number, Record<string, unknown>>> {
    const all = await this.progressService.listMediaProgressForUser(userId);
    const wanted = new Set(rows.map((r) => encodeAbsId('libraryItem', r.id)));
    const byBook = new Map<number, Record<string, unknown>>();
    for (const mp of all) {
      if (wanted.has(mp.libraryItemId as string)) {
        const idStr = mp.libraryItemId as string;
        const bookId = Number.parseInt(idStr.slice(idStr.indexOf('_') + 1), 10);
        byBook.set(bookId, mp);
      }
    }
    return byBook;
  }

  /** Audio files for playback (used by the playback service). */
  audioFiles(bookId: number): Promise<AbsAudioFileRow[]> {
    return this.readRepo.audioFilesByBookId(bookId);
  }

  /**
   * Resolve a single file for `GET /api/items/:id/file/:fileid/download`. The `fileid` is the audio
   * file's `ino` (its book-file row id). Enforces library access and the `canDownload` permission.
   */
  async getDownloadFile(user: RequestUser, bookId: number, fileId: number): Promise<AbsAudioFileRow> {
    const file = await this.readRepo.findBookFileById(fileId);
    if (!file || file.bookId !== bookId) throw AbsHttpException.notFound();
    const libraryId = await this.readRepo.libraryIdForBook(bookId);
    if (libraryId === null) throw AbsHttpException.notFound();
    await this.assertLibraryAccess(user, libraryId);
    this.assertCanDownload(user);
    return file;
  }

  /**
   * Resolve a single file for the inline stream `GET /api/items/:id/file/:fileid` (ENDPOINTS.md §2 —
   * `jwt`). Mirrors {@link getDownloadFile} but is gated only on library access: the inline route is
   * for in-app playback/preview and is not subject to the `canDownload` permission.
   */
  async getItemFile(user: RequestUser, bookId: number, fileId: number): Promise<AbsAudioFileRow> {
    const file = await this.readRepo.findBookFileById(fileId);
    if (!file || file.bookId !== bookId) throw AbsHttpException.notFound();
    const libraryId = await this.readRepo.libraryIdForBook(bookId);
    if (libraryId === null) throw AbsHttpException.notFound();
    await this.assertLibraryAccess(user, libraryId);
    return file;
  }

  /**
   * Resolve the content files + title for `GET /api/items/:id/download` (zip of the whole item).
   * Enforces library access and the `canDownload` permission.
   */
  async getDownloadBundle(user: RequestUser, bookId: number): Promise<{ title: string; files: AbsAudioFileRow[] }> {
    const item = await this.readRepo.findItem(bookId);
    if (!item || item.status === 'processing') throw AbsHttpException.notFound();
    await this.assertLibraryAccess(user, item.libraryId);
    this.assertCanDownload(user);
    const files = await this.readRepo.audioFilesByBookId(bookId);
    if (files.length === 0) throw AbsHttpException.notFound();
    return { title: item.title ?? `item-${bookId}`, files };
  }
}
