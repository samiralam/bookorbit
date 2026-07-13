import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import * as schema from '../../db/schema';
import { AbsPlaybackSessionRepository } from './abs-playback-session.repository';

/**
 * Captures the SQL each method executes by stubbing `pool.query` (never connects). Queries resolve
 * to empty result sets — enough to assert the rendered predicates and parameters.
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
    return Promise.resolve({ rows: [], fields: [] });
  };
  const repo = new AbsPlaybackSessionRepository(drizzle(pool, { schema }));
  return { repo, queries };
}

describe('AbsPlaybackSessionRepository', () => {
  it('listForUser orders the full history newest-updatedAt-first', async () => {
    const { repo, queries } = captureQueries();
    await repo.listForUser(7);
    expect(queries).toHaveLength(1);
    expect(queries[0].text).toContain('"abs_playback_sessions"');
    expect(queries[0].text).toMatch(/order by .*"updated_at" desc/);
    expect(queries[0].text).not.toContain('"book_id" =');
    expect(queries[0].values).toEqual([7]);
  });

  it('listForUser with bookId filters to the one item', async () => {
    const { repo, queries } = captureQueries();
    await repo.listForUser(7, { bookId: 42 });
    expect(queries[0].text).toContain('"user_id" =');
    expect(queries[0].text).toContain('"book_id" =');
    expect(queries[0].values).toEqual([7, 42]);
  });

  it('listForUserCreatedInYear brackets createdAt to the calendar year', async () => {
    const { repo, queries } = captureQueries();
    await repo.listForUserCreatedInYear(7, 2026);
    expect(queries[0].text).toContain('"created_at" >=');
    expect(queries[0].text).toContain('"created_at" <');
    const [, start, end] = queries[0].values as [number, unknown, unknown];
    expect(new Date(String(start)).getFullYear()).toBe(2026);
    expect(new Date(String(end)).getFullYear()).toBe(2027);
  });

  it('updateSync touches only the sync columns of the addressed row', async () => {
    const { repo, queries } = captureQueries();
    await repo.updateSync('s-1', { currentTime: 10.5, timeListening: 33, updatedAt: new Date(1000) });
    expect(queries[0].text).toContain('update "abs_playback_sessions"');
    expect(queries[0].text).toContain('"current_time_seconds"');
    expect(queries[0].text).toContain('"time_listening"');
    expect(queries[0].text).toContain('"updated_at"');
    expect(queries[0].text).not.toContain('"date"');
    expect(queries[0].text).toContain('"id" =');
  });

  it('updateFromLocal also rewrites the client-owned date buckets', async () => {
    const { repo, queries } = captureQueries();
    await repo.updateFromLocal('s-1', {
      currentTime: 10,
      timeListening: 5,
      updatedAt: new Date(1000),
      date: '2026-07-12',
      dayOfWeek: 'Sunday',
    });
    expect(queries[0].text).toContain('"date"');
    expect(queries[0].text).toContain('"day_of_week"');
    expect(queries[0].values).toContain('2026-07-12');
    expect(queries[0].values).toContain('Sunday');
  });

  it('findById selects by primary key with limit 1', async () => {
    const { repo, queries } = captureQueries();
    const found = await repo.findById('s-1');
    expect(found).toBeNull();
    expect(queries[0].text).toContain('"id" =');
    expect(queries[0].text).toContain('limit');
  });
});
