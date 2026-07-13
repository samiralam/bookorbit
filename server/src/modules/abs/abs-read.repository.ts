import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, exists, ilike, inArray, isNotNull, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import { DB } from '../../db';
import * as schema from '../../db/schema';

const AUDIO_FORMATS = ['m4b', 'm4a', 'mp3', 'opus', 'ogg', 'flac'];

function stripTotal(row: AbsItemRow & { _total: number }): AbsItemRow {
  const { _total: _ignored, ...rest } = row;
  void _ignored;
  return rest;
}

export interface AbsItemRow {
  id: number;
  libraryId: number;
  status: string;
  addedAt: Date;
  updatedAt: Date;
  title: string | null;
  subtitle: string | null;
  description: string | null;
  publishedYear: number | null;
  publisher: string | null;
  language: string | null;
  isbn13: string | null;
  isbn10: string | null;
  seriesName: string | null;
  seriesIndex: number | null;
  durationSeconds: number | null;
  chapters: unknown;
}

export interface AbsAudioFileRow {
  id: number;
  bookId: number;
  format: string | null;
  sortOrder: number | null;
  durationSeconds: number | null;
  sizeBytes: number | null;
  absolutePath: string;
}

export type AbsItemSortField = 'addedAt' | 'title' | 'publishedYear';

/**
 * Focused read queries for the ABS adapter. Kept separate from BookOrbit's FE-tuned BookCard
 * queries (`BookReadService.findCards`) so the ABS → wire mapping stays explicit.
 */
@Injectable()
export class AbsReadRepository {
  constructor(@Inject(DB) private readonly db: NodePgDatabase<typeof schema>) {}

  private baseItemSelect() {
    return {
      id: schema.books.id,
      libraryId: schema.books.libraryId,
      status: schema.books.status,
      addedAt: schema.books.addedAt,
      updatedAt: schema.books.updatedAt,
      title: schema.bookMetadata.title,
      subtitle: schema.bookMetadata.subtitle,
      description: schema.bookMetadata.description,
      publishedYear: schema.bookMetadata.publishedYear,
      publisher: schema.bookMetadata.publisher,
      language: schema.bookMetadata.language,
      isbn13: schema.bookMetadata.isbn13,
      isbn10: schema.bookMetadata.isbn10,
      seriesName: schema.bookMetadata.seriesName,
      seriesIndex: schema.bookMetadata.seriesIndex,
      durationSeconds: schema.bookMetadata.durationSeconds,
      chapters: schema.bookMetadata.chapters,
    };
  }

  /** Conditions selecting playable audio content rows in `book_files` (shared with {@link hasPlayableAudio}). */
  private audioContentFileConditions(): SQL[] {
    return [eq(schema.bookFiles.role, 'content'), inArray(sql`lower(${schema.bookFiles.format})`, AUDIO_FORMATS)];
  }

  /** Correlated predicate: the book has at least one playable audio content file. */
  private hasPlayableAudio(): SQL {
    return exists(
      this.db
        .select({ one: sql`1` })
        .from(schema.bookFiles)
        .where(and(eq(schema.bookFiles.bookId, schema.books.id), ...this.audioContentFileConditions())),
    );
  }

  /**
   * Base visibility gate for every book the ABS API exposes: fully scanned (not `processing`) and
   * with playable audio. Ebook-only books are intentionally invisible to ABS clients — they would
   * render as track-less, unplayable items — until `ebookFile` support is implemented.
   */
  private visibleBookConditions(): SQL[] {
    return [sql`${schema.books.status} <> 'processing'`, this.hasPlayableAudio()];
  }

  private orderExpr(field: AbsItemSortField, descending: boolean): SQL[] {
    const dir = descending ? desc : asc;
    switch (field) {
      case 'title':
        return [dir(schema.bookMetadata.title), asc(schema.books.id)];
      case 'publishedYear':
        return [dir(schema.bookMetadata.publishedYear), asc(schema.books.id)];
      case 'addedAt':
      default:
        return [dir(schema.books.addedAt), asc(schema.books.id)];
    }
  }

  /** List present books in a library, paginated and sorted, with a total count. */
  async listItems(opts: {
    libraryId: number;
    limit: number;
    offset: number;
    sort: AbsItemSortField;
    desc: boolean;
    extraWhere?: SQL;
  }): Promise<{ rows: AbsItemRow[]; total: number }> {
    const where = and(eq(schema.books.libraryId, opts.libraryId), ...this.visibleBookConditions(), ...(opts.extraWhere ? [opts.extraWhere] : []));

    const rows = (await this.db
      .select({ ...this.baseItemSelect(), _total: sql<number>`count(*) over()`.as('_total') })
      .from(schema.books)
      .leftJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, schema.books.id))
      .where(where)
      .orderBy(...this.orderExpr(opts.sort, opts.desc))
      .limit(opts.limit > 0 ? opts.limit : Number.MAX_SAFE_INTEGER)
      .offset(opts.offset)) as Array<AbsItemRow & { _total: number }>;

    const total = rows.length > 0 ? Number(rows[0]._total) : await this.countItems(opts.libraryId, opts.extraWhere);
    return { rows: rows.map((row) => stripTotal(row)), total };
  }

  async countItems(libraryId: number, extraWhere?: SQL): Promise<number> {
    const [{ total }] = await this.db
      .select({ total: sql<number>`count(*)` })
      .from(schema.books)
      .where(and(eq(schema.books.libraryId, libraryId), ...this.visibleBookConditions(), ...(extraWhere ? [extraWhere] : [])));
    return Number(total);
  }

  async findItem(bookId: number): Promise<AbsItemRow | null> {
    const [row] = await this.db
      .select(this.baseItemSelect())
      .from(schema.books)
      .leftJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, schema.books.id))
      .where(and(eq(schema.books.id, bookId), ...this.visibleBookConditions()))
      .limit(1);
    return row ?? null;
  }

  async findItemsByIds(bookIds: number[]): Promise<AbsItemRow[]> {
    if (bookIds.length === 0) return [];
    return this.db
      .select(this.baseItemSelect())
      .from(schema.books)
      .leftJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, schema.books.id))
      .where(and(inArray(schema.books.id, bookIds), ...this.visibleBookConditions()));
  }

  /** Authors for a set of books, ordered for display. */
  async authorsByBookIds(bookIds: number[]): Promise<{ bookId: number; id: number; name: string }[]> {
    if (bookIds.length === 0) return [];
    return this.db
      .select({ bookId: schema.bookAuthors.bookId, id: schema.authors.id, name: schema.authors.name })
      .from(schema.bookAuthors)
      .innerJoin(schema.authors, eq(schema.authors.id, schema.bookAuthors.authorId))
      .where(inArray(schema.bookAuthors.bookId, bookIds))
      .orderBy(asc(schema.bookAuthors.bookId), asc(schema.bookAuthors.displayOrder));
  }

  async narratorsByBookIds(bookIds: number[]): Promise<{ bookId: number; name: string }[]> {
    if (bookIds.length === 0) return [];
    return this.db
      .select({ bookId: schema.bookNarrators.bookId, name: schema.narrators.name })
      .from(schema.bookNarrators)
      .innerJoin(schema.narrators, eq(schema.narrators.id, schema.bookNarrators.narratorId))
      .where(inArray(schema.bookNarrators.bookId, bookIds))
      .orderBy(asc(schema.bookNarrators.bookId), asc(schema.bookNarrators.displayOrder));
  }

  async genresByBookIds(bookIds: number[]): Promise<{ bookId: number; name: string }[]> {
    if (bookIds.length === 0) return [];
    return this.db
      .select({ bookId: schema.bookGenres.bookId, name: schema.genres.name })
      .from(schema.bookGenres)
      .innerJoin(schema.genres, eq(schema.genres.id, schema.bookGenres.genreId))
      .where(inArray(schema.bookGenres.bookId, bookIds))
      .orderBy(asc(schema.bookGenres.bookId), asc(schema.genres.name));
  }

  async seriesByBookIds(bookIds: number[]): Promise<{ bookId: number; id: number; name: string; sequence: number | null }[]> {
    if (bookIds.length === 0) return [];
    return this.db
      .select({
        bookId: schema.bookSeriesMemberships.bookId,
        id: schema.bookSeries.id,
        name: schema.bookSeries.name,
        sequence: schema.bookSeriesMemberships.seriesIndex,
      })
      .from(schema.bookSeriesMemberships)
      .innerJoin(schema.bookSeries, eq(schema.bookSeries.id, schema.bookSeriesMemberships.seriesId))
      .where(inArray(schema.bookSeriesMemberships.bookId, bookIds))
      .orderBy(asc(schema.bookSeriesMemberships.bookId), asc(schema.bookSeriesMemberships.displayOrder));
  }

  /** Audio content files for a book, ordered into track order. */
  async audioFilesByBookId(bookId: number): Promise<AbsAudioFileRow[]> {
    return this.audioFilesByBookIds([bookId]);
  }

  async audioFilesByBookIds(bookIds: number[]): Promise<AbsAudioFileRow[]> {
    if (bookIds.length === 0) return [];
    return this.db
      .select({
        id: schema.bookFiles.id,
        bookId: schema.bookFiles.bookId,
        format: schema.bookFiles.format,
        sortOrder: schema.bookFiles.sortOrder,
        durationSeconds: schema.bookFiles.durationSeconds,
        sizeBytes: schema.bookFiles.sizeBytes,
        absolutePath: schema.bookFiles.absolutePath,
      })
      .from(schema.bookFiles)
      .where(and(inArray(schema.bookFiles.bookId, bookIds), ...this.audioContentFileConditions()))
      .orderBy(asc(schema.bookFiles.bookId), asc(schema.bookFiles.sortOrder), asc(schema.bookFiles.id));
  }

  async findBookFileById(fileId: number): Promise<AbsAudioFileRow | null> {
    const [row] = await this.db
      .select({
        id: schema.bookFiles.id,
        bookId: schema.bookFiles.bookId,
        format: schema.bookFiles.format,
        sortOrder: schema.bookFiles.sortOrder,
        durationSeconds: schema.bookFiles.durationSeconds,
        sizeBytes: schema.bookFiles.sizeBytes,
        absolutePath: schema.bookFiles.absolutePath,
      })
      .from(schema.bookFiles)
      .where(eq(schema.bookFiles.id, fileId))
      .limit(1);
    return row ?? null;
  }

  async libraryIdForBook(bookId: number): Promise<number | null> {
    const [row] = await this.db.select({ libraryId: schema.books.libraryId }).from(schema.books).where(eq(schema.books.id, bookId)).limit(1);
    return row?.libraryId ?? null;
  }

  /** The library of any of the author's books (authors are global; ABS Authors carry a libraryId). */
  async libraryIdForAuthor(authorId: number): Promise<number | null> {
    const [row] = await this.db
      .select({ libraryId: schema.books.libraryId })
      .from(schema.bookAuthors)
      .innerJoin(schema.books, eq(schema.books.id, schema.bookAuthors.bookId))
      .where(eq(schema.bookAuthors.authorId, authorId))
      .limit(1);
    return row?.libraryId ?? null;
  }

  /**
   * Translate a decoded ABS browse filter into a `books.id IN (...)` predicate. Supports the common
   * id/name groups; unknown or unsupported groups (e.g. per-user `progress`) yield `undefined` so the
   * caller can fall back to no filtering.
   */
  filterWhere(group: string, value: string): SQL | undefined {
    switch (group) {
      case 'authors': {
        const authorId = Number.parseInt(value, 10);
        if (!Number.isInteger(authorId)) return undefined;
        return inArray(
          schema.books.id,
          this.db.select({ bookId: schema.bookAuthors.bookId }).from(schema.bookAuthors).where(eq(schema.bookAuthors.authorId, authorId)),
        );
      }
      case 'series': {
        const seriesId = Number.parseInt(value, 10);
        if (!Number.isInteger(seriesId)) return undefined;
        return inArray(
          schema.books.id,
          this.db
            .select({ bookId: schema.bookSeriesMemberships.bookId })
            .from(schema.bookSeriesMemberships)
            .where(eq(schema.bookSeriesMemberships.seriesId, seriesId)),
        );
      }
      case 'narrators':
        return inArray(
          schema.books.id,
          this.db
            .select({ bookId: schema.bookNarrators.bookId })
            .from(schema.bookNarrators)
            .innerJoin(schema.narrators, eq(schema.narrators.id, schema.bookNarrators.narratorId))
            .where(eq(schema.narrators.name, value)),
        );
      case 'genres':
        return inArray(
          schema.books.id,
          this.db
            .select({ bookId: schema.bookGenres.bookId })
            .from(schema.bookGenres)
            .innerJoin(schema.genres, eq(schema.genres.id, schema.bookGenres.genreId))
            .where(eq(schema.genres.name, value)),
        );
      case 'tags':
        return inArray(
          schema.books.id,
          this.db
            .select({ bookId: schema.bookTags.bookId })
            .from(schema.bookTags)
            .innerJoin(schema.tags, eq(schema.tags.id, schema.bookTags.tagId))
            .where(eq(schema.tags.name, value)),
        );
      case 'languages':
        return inArray(
          schema.books.id,
          this.db.select({ bookId: schema.bookMetadata.bookId }).from(schema.bookMetadata).where(eq(schema.bookMetadata.language, value)),
        );
      case 'missing':
        return this.missingWhere(value);
      default:
        return undefined;
    }
  }

  /**
   * ABS `missing.<field>` — books lacking the given relation or metadata field
   * (libraryItemsBookFilters: `missing.authors` is a left-join `authors.id IS NULL`; scalar fields
   * match null-or-empty). Unknown fields yield `undefined` (no filtering), same as ABS.
   */
  private missingWhere(field: string): SQL | undefined {
    switch (field) {
      case 'authors':
        return notInArray(schema.books.id, this.db.select({ bookId: schema.bookAuthors.bookId }).from(schema.bookAuthors));
      case 'series':
        return notInArray(schema.books.id, this.db.select({ bookId: schema.bookSeriesMemberships.bookId }).from(schema.bookSeriesMemberships));
      case 'narrators':
        return notInArray(schema.books.id, this.db.select({ bookId: schema.bookNarrators.bookId }).from(schema.bookNarrators));
      case 'genres':
        return notInArray(schema.books.id, this.db.select({ bookId: schema.bookGenres.bookId }).from(schema.bookGenres));
      case 'tags':
        return notInArray(schema.books.id, this.db.select({ bookId: schema.bookTags.bookId }).from(schema.bookTags));
      case 'subtitle':
        return this.missingMetadataText(schema.bookMetadata.subtitle);
      case 'description':
        return this.missingMetadataText(schema.bookMetadata.description);
      case 'publisher':
        return this.missingMetadataText(schema.bookMetadata.publisher);
      case 'language':
        return this.missingMetadataText(schema.bookMetadata.language);
      case 'publishedYear':
        return notInArray(
          schema.books.id,
          this.db.select({ bookId: schema.bookMetadata.bookId }).from(schema.bookMetadata).where(isNotNull(schema.bookMetadata.publishedYear)),
        );
      case 'isbn':
        return notInArray(
          schema.books.id,
          this.db
            .select({ bookId: schema.bookMetadata.bookId })
            .from(schema.bookMetadata)
            .where(
              or(
                and(isNotNull(schema.bookMetadata.isbn10), ne(schema.bookMetadata.isbn10, '')),
                and(isNotNull(schema.bookMetadata.isbn13), ne(schema.bookMetadata.isbn13, '')),
              ),
            ),
        );
      default:
        return undefined;
    }
  }

  /** Books whose metadata row lacks the column (null/empty) or that have no metadata row at all. */
  private missingMetadataText(column: AnyPgColumn): SQL {
    return notInArray(
      schema.books.id,
      this.db
        .select({ bookId: schema.bookMetadata.bookId })
        .from(schema.bookMetadata)
        .where(and(isNotNull(column), ne(column, ''))),
    );
  }

  /** Title/author substring search within a library, capped at `limit` rows. */
  async searchItems(libraryId: number, query: string, limit: number): Promise<AbsItemRow[]> {
    const term = `%${query}%`;
    const matchingAuthorBookIds = this.db
      .select({ bookId: schema.bookAuthors.bookId })
      .from(schema.bookAuthors)
      .innerJoin(schema.authors, eq(schema.authors.id, schema.bookAuthors.authorId))
      .where(ilike(schema.authors.name, term));

    return this.db
      .select(this.baseItemSelect())
      .from(schema.books)
      .leftJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, schema.books.id))
      .where(
        and(
          eq(schema.books.libraryId, libraryId),
          ...this.visibleBookConditions(),
          or(ilike(schema.bookMetadata.title, term), inArray(schema.books.id, matchingAuthorBookIds)),
        ),
      )
      .orderBy(asc(schema.bookMetadata.title), asc(schema.books.id))
      .limit(limit > 0 ? limit : 25);
  }

  /** Series present in a library, with their member book ids ordered by series index. */
  async seriesInLibrary(libraryId: number): Promise<{ id: number; name: string; books: { bookId: number; sequence: number | null }[] }[]> {
    const rows = await this.db
      .select({
        id: schema.bookSeries.id,
        name: schema.bookSeries.name,
        bookId: schema.bookSeriesMemberships.bookId,
        sequence: schema.bookSeriesMemberships.seriesIndex,
      })
      .from(schema.bookSeriesMemberships)
      .innerJoin(schema.bookSeries, eq(schema.bookSeries.id, schema.bookSeriesMemberships.seriesId))
      .innerJoin(schema.books, eq(schema.books.id, schema.bookSeriesMemberships.bookId))
      .where(and(eq(schema.books.libraryId, libraryId), ...this.visibleBookConditions()))
      .orderBy(asc(schema.bookSeries.name), asc(schema.bookSeriesMemberships.seriesIndex), asc(schema.bookSeriesMemberships.bookId));

    const byId = new Map<number, { id: number; name: string; books: { bookId: number; sequence: number | null }[] }>();
    for (const row of rows) {
      let series = byId.get(row.id);
      if (!series) {
        series = { id: row.id, name: row.name, books: [] };
        byId.set(row.id, series);
      }
      series.books.push({ bookId: row.bookId, sequence: row.sequence });
    }
    return [...byId.values()];
  }

  /** Authors with at least one present book in the library, with their in-library book count. */
  async authorsInLibrary(libraryId: number): Promise<{ id: number; name: string; description: string | null; numBooks: number }[]> {
    const bookIdsForLibrary = this.db
      .select({ id: schema.books.id })
      .from(schema.books)
      .where(and(eq(schema.books.libraryId, libraryId), ...this.visibleBookConditions()));

    return this.db
      .select({
        id: schema.authors.id,
        name: schema.authors.name,
        description: schema.authors.description,
        numBooks: sql<number>`count(${schema.bookAuthors.bookId})`.mapWith(Number),
      })
      .from(schema.authors)
      .innerJoin(schema.bookAuthors, eq(schema.bookAuthors.authorId, schema.authors.id))
      .where(inArray(schema.bookAuthors.bookId, bookIdsForLibrary))
      .groupBy(schema.authors.id)
      .orderBy(asc(schema.authors.name));
  }

  async findAuthor(authorId: number): Promise<{ id: number; name: string; description: string | null } | null> {
    const [row] = await this.db
      .select({ id: schema.authors.id, name: schema.authors.name, description: schema.authors.description })
      .from(schema.authors)
      .where(eq(schema.authors.id, authorId))
      .limit(1);
    return row ?? null;
  }

  /** Present book ids written by an author, ordered by title for stable author-page display. */
  async bookIdsForAuthor(authorId: number): Promise<number[]> {
    const rows = await this.db
      .select({ id: schema.books.id })
      .from(schema.bookAuthors)
      .innerJoin(schema.books, eq(schema.books.id, schema.bookAuthors.bookId))
      .leftJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, schema.books.id))
      .where(and(eq(schema.bookAuthors.authorId, authorId), ...this.visibleBookConditions()))
      .orderBy(asc(schema.bookMetadata.title), asc(schema.books.id));
    return rows.map((r) => r.id);
  }

  /** A user's collections, restricted to books in the given library, with member book ids. */
  async collectionsForUser(
    userId: number,
    libraryId: number,
  ): Promise<{ id: number; name: string; description: string | null; bookIds: number[] }[]> {
    const cols = await this.db
      .select({ id: schema.collections.id, name: schema.collections.name, description: schema.collections.description })
      .from(schema.collections)
      .where(eq(schema.collections.userId, userId))
      .orderBy(asc(schema.collections.displayOrder), asc(schema.collections.name));
    if (cols.length === 0) return [];

    const members = await this.db
      .select({ collectionId: schema.collectionBooks.collectionId, bookId: schema.collectionBooks.bookId })
      .from(schema.collectionBooks)
      .innerJoin(schema.books, eq(schema.books.id, schema.collectionBooks.bookId))
      .where(
        and(
          inArray(
            schema.collectionBooks.collectionId,
            cols.map((c) => c.id),
          ),
          eq(schema.books.libraryId, libraryId),
          ...this.visibleBookConditions(),
        ),
      )
      .orderBy(asc(schema.collectionBooks.addedAt));

    const booksByCollection = new Map<number, number[]>();
    for (const m of members) {
      const list = booksByCollection.get(m.collectionId);
      if (list) list.push(m.bookId);
      else booksByCollection.set(m.collectionId, [m.bookId]);
    }
    return cols.map((c) => ({ id: c.id, name: c.name, description: c.description, bookIds: booksByCollection.get(c.id) ?? [] }));
  }

  /** Distinct filter values for a library (authors/narrators/series/genres/tags/languages). */
  async filterData(libraryId: number): Promise<{
    authors: { id: number; name: string }[];
    narrators: string[];
    series: { id: number; name: string }[];
    genres: string[];
    tags: string[];
    languages: string[];
  }> {
    const bookIdsForLibrary = this.db
      .select({ id: schema.books.id })
      .from(schema.books)
      .where(and(eq(schema.books.libraryId, libraryId), ...this.visibleBookConditions()));

    const [authors, narrators, series, genres, tags, languages] = await Promise.all([
      this.db
        .selectDistinct({ id: schema.authors.id, name: schema.authors.name })
        .from(schema.bookAuthors)
        .innerJoin(schema.authors, eq(schema.authors.id, schema.bookAuthors.authorId))
        .where(inArray(schema.bookAuthors.bookId, bookIdsForLibrary))
        .orderBy(asc(schema.authors.name)),
      this.db
        .selectDistinct({ name: schema.narrators.name })
        .from(schema.bookNarrators)
        .innerJoin(schema.narrators, eq(schema.narrators.id, schema.bookNarrators.narratorId))
        .where(inArray(schema.bookNarrators.bookId, bookIdsForLibrary))
        .orderBy(asc(schema.narrators.name)),
      this.db
        .selectDistinct({ id: schema.bookSeries.id, name: schema.bookSeries.name })
        .from(schema.bookSeriesMemberships)
        .innerJoin(schema.bookSeries, eq(schema.bookSeries.id, schema.bookSeriesMemberships.seriesId))
        .where(inArray(schema.bookSeriesMemberships.bookId, bookIdsForLibrary))
        .orderBy(asc(schema.bookSeries.name)),
      this.db
        .selectDistinct({ name: schema.genres.name })
        .from(schema.bookGenres)
        .innerJoin(schema.genres, eq(schema.genres.id, schema.bookGenres.genreId))
        .where(inArray(schema.bookGenres.bookId, bookIdsForLibrary))
        .orderBy(asc(schema.genres.name)),
      this.db
        .selectDistinct({ name: schema.tags.name })
        .from(schema.bookTags)
        .innerJoin(schema.tags, eq(schema.tags.id, schema.bookTags.tagId))
        .where(inArray(schema.bookTags.bookId, bookIdsForLibrary))
        .orderBy(asc(schema.tags.name)),
      this.db
        .selectDistinct({ language: schema.bookMetadata.language })
        .from(schema.bookMetadata)
        .where(and(inArray(schema.bookMetadata.bookId, bookIdsForLibrary), sql`${schema.bookMetadata.language} is not null`))
        .orderBy(asc(schema.bookMetadata.language)),
    ]);

    return {
      authors,
      narrators: narrators.map((n) => n.name),
      series,
      genres: genres.map((g) => g.name),
      tags: tags.map((t) => t.name),
      languages: languages.map((l) => l.language).filter((l): l is string => l != null),
    };
  }
}
