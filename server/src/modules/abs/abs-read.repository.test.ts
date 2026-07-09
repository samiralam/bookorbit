import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import * as schema from '../../db/schema';
import { AbsReadRepository } from './abs-read.repository';

// The Pool is never connected — drizzle only builds SQL here, so no DB is needed.
function buildRepo() {
  const db = drizzle(new Pool(), { schema });
  return { repo: new AbsReadRepository(db), db };
}

function renderedSql(repo: AbsReadRepository, db: ReturnType<typeof drizzle>, group: string, value: string): string | undefined {
  const where = repo.filterWhere(group, value);
  if (!where) return undefined;
  return db.select({ id: schema.books.id }).from(schema.books).where(where).toSQL().sql;
}

describe('AbsReadRepository.filterWhere — missing.* group (ABS libraryItemsBookFilters)', () => {
  it('missing.authors excludes books that have any author row', () => {
    const { repo, db } = buildRepo();
    const sql = renderedSql(repo, db, 'missing', 'authors');
    expect(sql).toBeDefined();
    expect(sql).toContain('not in');
    expect(sql).toContain('book_authors');
  });

  it('missing.series excludes books with a series membership', () => {
    const { repo, db } = buildRepo();
    const sql = renderedSql(repo, db, 'missing', 'series');
    expect(sql).toBeDefined();
    expect(sql).toContain('not in');
    expect(sql).toContain('book_series_memberships');
  });

  it('missing scalar metadata fields match null-or-empty (or no metadata row)', () => {
    const { repo, db } = buildRepo();
    for (const field of ['subtitle', 'description', 'publisher', 'language', 'publishedYear', 'isbn']) {
      const sql = renderedSql(repo, db, 'missing', field);
      expect(sql, field).toBeDefined();
      expect(sql, field).toContain('not in');
      expect(sql, field).toContain('book_metadata');
    }
  });

  it('unknown missing field yields no predicate, matching ABS (no filtering)', () => {
    const { repo } = buildRepo();
    expect(repo.filterWhere('missing', 'asin')).toBeUndefined();
  });

  it('authors filter (positive) still selects books IN the author junction', () => {
    const { repo, db } = buildRepo();
    const sql = renderedSql(repo, db, 'authors', '7');
    expect(sql).toBeDefined();
    expect(sql).toContain('in');
    expect(sql).not.toContain('not in');
    expect(sql).toContain('book_authors');
  });
});

/**
 * Captures the SQL each repository method executes by stubbing `pool.query` (still no DB). Queries
 * resolve to empty result sets; methods that then throw on empty rows are caught — the SQL has
 * already been recorded by that point.
 */
function captureQueries() {
  const pool = new Pool();
  const queries: { text: string; values: unknown[] }[] = [];
  (pool as unknown as { query: (cfg: { text: string; values?: unknown[] } | string, values?: unknown[]) => Promise<unknown> }).query = (
    cfg,
    values,
  ) => {
    const text = typeof cfg === 'string' ? cfg : cfg.text;
    queries.push({ text, values: (typeof cfg === 'string' ? values : (cfg.values ?? values)) ?? [] });
    // collectionsForUser only runs its (gated) members query if the user has a collection row.
    if (text.includes('from "collections"')) return Promise.resolve({ rows: [[1, 'c', null]], fields: [] });
    return Promise.resolve({ rows: [], fields: [] });
  };
  const repo = new AbsReadRepository(drizzle(pool, { schema }));
  return { repo, queries };
}

describe('ABS visibility gate — books without a playable audio content file are excluded', () => {
  const hasAudioGate = (q: { text: string; values: unknown[] }) =>
    q.text.includes('exists') && q.text.includes('"book_files"') && q.text.includes('lower(');

  it('gates listItems and its count query, binding the content role and audio formats', async () => {
    const { repo, queries } = captureQueries();
    await repo.listItems({ libraryId: 1, limit: 10, offset: 0, sort: 'addedAt', desc: true }).catch(() => undefined);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every(hasAudioGate)).toBe(true);
    for (const value of ['content', 'm4b', 'm4a', 'mp3', 'opus', 'ogg', 'flac']) {
      expect(queries[0].values).toContain(value);
    }
  });

  it('gates single and batch item lookups (direct GET of an ebook-only item finds nothing)', async () => {
    const { repo, queries } = captureQueries();
    await repo.findItem(1);
    await repo.findItemsByIds([1, 2]);
    expect(queries).toHaveLength(2);
    expect(queries.every(hasAudioGate)).toBe(true);
  });

  it('gates search, series, author, collection, and filter-data queries', async () => {
    const { repo, queries } = captureQueries();
    await repo.searchItems(1, 'dune', 5);
    await repo.seriesInLibrary(1);
    await repo.authorsInLibrary(1);
    await repo.bookIdsForAuthor(7);
    await repo.collectionsForUser(1, 1);
    await repo.filterData(1);
    // Every query except the ungated user-collections list must carry the audio-file predicate.
    const gated = queries.filter((q) => !q.text.includes('from "collections"'));
    expect(gated.length).toBeGreaterThanOrEqual(10);
    expect(gated.every(hasAudioGate)).toBe(true);
    expect(queries.some((q) => q.text.includes('from "collections"'))).toBe(true);
  });

  it('still keeps the processing-status gate alongside the audio gate', async () => {
    const { repo, queries } = captureQueries();
    await repo.listItems({ libraryId: 1, limit: 10, offset: 0, sort: 'addedAt', desc: true }).catch(() => undefined);
    expect(queries[0].text).toContain("<> 'processing'");
  });
});
