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
