import { NodePgDatabase } from 'drizzle-orm/node-postgres';

import * as schema from '../../../db/schema';
import { OidcService } from '../../auth/oidc/oidc.service';
import { ABS_APP_NAME, ABS_SERVER_VERSION } from '../abs.constants';
import { thrownStatus } from '../__testing__/abs-test-helpers';
import { AbsDiscoveryController } from './abs-discovery.controller';

type Db = NodePgDatabase<typeof schema>;

/** OidcService stub; `provider` is what getDesignatedAbsProvider resolves to (null ⇒ OIDC disabled). */
function makeOidc(provider: { displayName: string } | null = null): OidcService {
  return { getDesignatedAbsProvider: vi.fn().mockResolvedValue(provider) } as unknown as OidcService;
}

describe('AbsDiscoveryController', () => {
  describe('ping / healthcheck', () => {
    const controller = new AbsDiscoveryController({} as Db, makeOidc());

    it('ping reports liveness', () => {
      expect(controller.ping()).toEqual({ success: true });
    });

    it('healthcheck returns an empty 200 body', () => {
      expect(controller.healthcheck()).toBeUndefined();
    });
  });

  describe('GET /status', () => {
    it('reports isInit=true when at least one user exists', async () => {
      const db = { $count: vi.fn().mockResolvedValue(3) } as unknown as Db;
      const status = await new AbsDiscoveryController(db, makeOidc()).status();
      expect(status).toMatchObject({ app: ABS_APP_NAME, serverVersion: ABS_SERVER_VERSION, isInit: true, authMethods: ['local'] });
    });

    it('reports isInit=false on a brand-new instance (no users)', async () => {
      const db = { $count: vi.fn().mockResolvedValue(0) } as unknown as Db;
      expect((await new AbsDiscoveryController(db, makeOidc()).status()).isInit).toBe(false);
    });

    it('advertises openid + button text when a provider is enabled', async () => {
      const db = { $count: vi.fn().mockResolvedValue(1) } as unknown as Db;
      const status = await new AbsDiscoveryController(db, makeOidc({ displayName: 'Corp SSO' })).status();
      expect(status.authMethods).toEqual(['local', 'openid']);
      expect(status.authFormData).toEqual({ authOpenIDButtonText: 'Corp SSO', authOpenIDAutoLaunch: false });
    });

    it('omits openid when no provider is enabled', async () => {
      const db = { $count: vi.fn().mockResolvedValue(1) } as unknown as Db;
      const status = await new AbsDiscoveryController(db, makeOidc(null)).status();
      expect(status.authMethods).toEqual(['local']);
      expect(status.authFormData).toEqual({});
    });
  });

  describe('POST /init', () => {
    function dbWithUserCount(total: number, existingUser: unknown = undefined) {
      const insertValues = vi.fn().mockResolvedValue(undefined);
      const tx = {
        select: () => ({ from: () => Promise.resolve([{ total }]) }),
        query: { users: { findFirst: vi.fn().mockResolvedValue(existingUser) } },
        insert: () => ({ values: insertValues }),
      };
      const db = { transaction: vi.fn((cb: (t: typeof tx) => unknown) => cb(tx)) } as unknown as Db;
      return { db, insertValues };
    }

    it('creates the first root user when none exist', async () => {
      const { db, insertValues } = dbWithUserCount(0);
      const result = await new AbsDiscoveryController(db, makeOidc()).init({ username: 'root', password: 'pw' });
      expect(result).toEqual({ success: true });
      expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ username: 'root', isSuperuser: true }));
    });

    it('accepts the nested { newRoot } body shape', async () => {
      const { db, insertValues } = dbWithUserCount(0);
      await new AbsDiscoveryController(db, makeOidc()).init({ newRoot: { username: 'admin', password: 'pw' } });
      expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ username: 'admin' }));
    });

    it('rejects missing credentials with 400', async () => {
      const { db } = dbWithUserCount(0);
      expect(await thrownStatus(() => new AbsDiscoveryController(db, makeOidc()).init({ username: 'x' }))).toBe(400);
    });

    it('returns 500 when a root user already exists (matches ABS)', async () => {
      const { db } = dbWithUserCount(1);
      expect(await thrownStatus(() => new AbsDiscoveryController(db, makeOidc()).init({ username: 'root', password: 'pw' }))).toBe(500);
    });

    it('returns 500 when the username is already taken', async () => {
      const { db } = dbWithUserCount(0, { id: 1, username: 'root' });
      expect(await thrownStatus(() => new AbsDiscoveryController(db, makeOidc()).init({ username: 'root', password: 'pw' }))).toBe(500);
    });
  });
});
