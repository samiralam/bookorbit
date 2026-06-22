import { OidcStateService } from './oidc-state.service';

const mockConfig = { get: vi.fn().mockReturnValue(undefined) };

/** `values()` returns an `onConflictDoUpdate`-chainable to mirror the idempotent upsert in `generate`. */
function makeValuesMock() {
  return vi.fn().mockReturnValue({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) });
}

function makeDb(overrides: Partial<ReturnType<typeof makeDb>> = {}) {
  const deleteMock = vi.fn().mockReturnThis();
  const db = {
    delete: vi.fn().mockReturnValue({ where: deleteMock }),
    insert: vi.fn().mockReturnValue({ values: makeValuesMock() }),
    ...overrides,
  };
  return { db, deleteMock };
}

describe('OidcStateService', () => {
  describe('generate', () => {
    it('returns a non-empty base64url string', async () => {
      const { db } = makeDb();
      db.delete.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
      const service = new OidcStateService(db as never, mockConfig as never);

      const state = await service.generate(1);
      expect(typeof state).toBe('string');
      expect(state.length).toBeGreaterThan(0);
      expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('returns unique values on each call', async () => {
      const { db } = makeDb();
      db.delete.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
      const service = new OidcStateService(db as never, mockConfig as never);

      const a = await service.generate(1);
      const b = await service.generate(1);
      expect(a).not.toBe(b);
    });

    it('inserts state with meta=null when no meta passed', async () => {
      const valuesMock = makeValuesMock();
      const insertMock = vi.fn().mockReturnValue({ values: valuesMock });
      const db = {
        delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
        insert: insertMock,
      };
      const service = new OidcStateService(db as never, mockConfig as never);

      const state = await service.generate(1);

      expect(insertMock).toHaveBeenCalledOnce();
      const [[{ state: insertedState, providerId, meta }]] = valuesMock.mock.calls;
      expect(insertedState).toBe(state);
      expect(providerId).toBe(1);
      expect(meta).toBeNull();
    });

    it('inserts state with serialized meta when meta passed', async () => {
      const valuesMock = makeValuesMock();
      const insertMock = vi.fn().mockReturnValue({ values: valuesMock });
      const db = {
        delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
        insert: insertMock,
      };
      const service = new OidcStateService(db as never, mockConfig as never);
      const metaPayload = { mode: 'link', userId: 42 };

      await service.generate(1, metaPayload);

      const [[{ meta }]] = valuesMock.mock.calls;
      expect(JSON.parse(meta as string)).toEqual(metaPayload);
    });

    it('inserts state into the database with an expiry', async () => {
      const valuesMock = makeValuesMock();
      const insertMock = vi.fn().mockReturnValue({ values: valuesMock });
      const db = {
        delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
        insert: insertMock,
      };
      const service = new OidcStateService(db as never, mockConfig as never);

      const before = Date.now();
      const state = await service.generate(1);
      const after = Date.now();

      const [[{ state: insertedState, expiresAt }]] = valuesMock.mock.calls;
      expect(insertedState).toBe(state);
      expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 5 * 60 * 1000);
      expect(expiresAt.getTime()).toBeLessThanOrEqual(after + 20 * 60 * 1000);
    });

    it('prunes expired states on each generate call', async () => {
      const whereMock = vi.fn().mockResolvedValue(undefined);
      const db = {
        delete: vi.fn().mockReturnValue({ where: whereMock }),
        insert: vi.fn().mockReturnValue({ values: makeValuesMock() }),
      };
      const service = new OidcStateService(db as never, mockConfig as never);

      await service.generate(1);

      expect(db.delete).toHaveBeenCalled();
      expect(whereMock).toHaveBeenCalled();
    });

    it('uses an explicit state value when provided (ABS mobile preserves the client state)', async () => {
      const valuesMock = makeValuesMock();
      const db = {
        delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
        insert: vi.fn().mockReturnValue({ values: valuesMock }),
      };
      const service = new OidcStateService(db as never, mockConfig as never);

      const state = await service.generate(1, undefined, 'client-supplied-state');

      expect(state).toBe('client-supplied-state');
      expect(valuesMock.mock.calls[0][0].state).toBe('client-supplied-state');
    });

    it('upserts on the state primary key so a replayed pinned state does not collide', async () => {
      // iOS ABS clients re-issue the /auth/openid navigation with the same client `state`; a plain
      // insert would throw a PK violation that surfaces as a blank "openid" page. The row must be
      // refreshed (onConflictDoUpdate) instead.
      const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
      const valuesMock = vi.fn().mockReturnValue({ onConflictDoUpdate });
      const db = {
        delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
        insert: vi.fn().mockReturnValue({ values: valuesMock }),
      };
      const service = new OidcStateService(db as never, mockConfig as never);

      await service.generate(7, { mode: 'abs' }, 'replayed-state');

      expect(onConflictDoUpdate).toHaveBeenCalledOnce();
      const [{ target, set }] = onConflictDoUpdate.mock.calls[0];
      expect(target).toBeDefined();
      expect(set.providerId).toBe(7);
      expect(JSON.parse(set.meta as string)).toEqual({ mode: 'abs' });
    });
  });

  describe('peek', () => {
    function dbWithRow(row: unknown) {
      return { query: { oidcStates: { findFirst: vi.fn().mockResolvedValue(row) } } };
    }

    it('returns the row meta without consuming it (no delete)', async () => {
      const db = dbWithRow({ state: 's', providerId: 1, meta: JSON.stringify({ mode: 'abs', appRedirect: 'audiobookshelf://oauth' }) });
      const service = new OidcStateService(db as never, mockConfig as never);

      const result = await service.peek('s');
      expect(result).toEqual({ valid: true, providerId: 1, meta: { mode: 'abs', appRedirect: 'audiobookshelf://oauth' } });
    });

    it('returns { valid: false } for an unknown/expired state', async () => {
      const db = dbWithRow(undefined);
      const service = new OidcStateService(db as never, mockConfig as never);
      expect(await service.peek('nope')).toEqual({ valid: false });
    });
  });

  describe('validateAndConsume', () => {
    it('returns { valid: true } when delete removes a row (valid state, no meta)', async () => {
      const db = {
        delete: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ state: 'valid-state', providerId: 1, meta: null }]),
          }),
        }),
        insert: vi.fn(),
      };
      const service = new OidcStateService(db as never, mockConfig as never);

      const result = await service.validateAndConsume('valid-state');
      expect(result.valid).toBe(true);
      expect(result.providerId).toBe(1);
      expect(result.meta).toBeUndefined();
    });

    it('returns { valid: true, meta } when row has serialized meta', async () => {
      const metaPayload = { mode: 'link', userId: 99 };
      const db = {
        delete: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ state: 'valid-state', providerId: 1, meta: JSON.stringify(metaPayload) }]),
          }),
        }),
        insert: vi.fn(),
      };
      const service = new OidcStateService(db as never, mockConfig as never);

      const result = await service.validateAndConsume('valid-state');
      expect(result.valid).toBe(true);
      expect(result.meta).toEqual(metaPayload);
    });

    it('returns { valid: false } when delete removes nothing (expired or unknown state)', async () => {
      const db = {
        delete: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
        insert: vi.fn(),
      };
      const service = new OidcStateService(db as never, mockConfig as never);

      const result = await service.validateAndConsume('unknown-state');
      expect(result.valid).toBe(false);
    });

    it('uses DELETE...RETURNING for atomic one-time consumption', async () => {
      const returningMock = vi.fn().mockResolvedValue([]);
      const whereMock = vi.fn().mockReturnValue({ returning: returningMock });
      const deleteMock = vi.fn().mockReturnValue({ where: whereMock });
      const db = { delete: deleteMock, insert: vi.fn() };
      const service = new OidcStateService(db as never, mockConfig as never);

      await service.validateAndConsume('some-state');

      expect(deleteMock).toHaveBeenCalledOnce();
      expect(whereMock).toHaveBeenCalledOnce();
      expect(returningMock).toHaveBeenCalledOnce();
    });
  });
});
