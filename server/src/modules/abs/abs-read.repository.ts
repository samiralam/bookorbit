import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';

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
    const where = and(
      eq(schema.books.libraryId, opts.libraryId),
      sql`${schema.books.status} <> 'processing'`,
      ...(opts.extraWhere ? [opts.extraWhere] : []),
    );

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
      .where(and(eq(schema.books.libraryId, libraryId), sql`${schema.books.status} <> 'processing'`, ...(extraWhere ? [extraWhere] : [])));
    return Number(total);
  }

  async findItem(bookId: number): Promise<AbsItemRow | null> {
    const [row] = await this.db
      .select(this.baseItemSelect())
      .from(schema.books)
      .leftJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, schema.books.id))
      .where(eq(schema.books.id, bookId))
      .limit(1);
    return row ?? null;
  }

  async findItemsByIds(bookIds: number[]): Promise<AbsItemRow[]> {
    if (bookIds.length === 0) return [];
    return this.db
      .select(this.baseItemSelect())
      .from(schema.books)
      .leftJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, schema.books.id))
      .where(inArray(schema.books.id, bookIds));
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
      .where(
        and(
          inArray(schema.bookFiles.bookId, bookIds),
          eq(schema.bookFiles.role, 'content'),
          inArray(sql`lower(${schema.bookFiles.format})`, AUDIO_FORMATS),
        ),
      )
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
}
