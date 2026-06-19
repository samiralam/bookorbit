import { ABS_SERVER_VERSION } from '../abs.constants';
import { ALL_LIBRARY_PERMISSIONS, makeAbsUser } from '../__testing__/abs-test-helpers';
import { buildAbsServerSettings, toAbsLoginPayload, toAbsUser } from './abs-user.mapper';

describe('toAbsUser', () => {
  it('encodes the id and reports superusers as ABS type "root"', () => {
    const u = toAbsUser(makeAbsUser({ id: 9, username: 'root', isSuperuser: true }));
    expect(u.id).toBe('usr_9');
    expect(u.username).toBe('root');
    expect(u.type).toBe('root');
  });

  it('reports non-superusers as ABS type "user"', () => {
    expect(toAbsUser(makeAbsUser({ isSuperuser: false })).type).toBe('user');
  });

  it('emits the full ABS user contract strict clients require (email/isOldToken/itemTagsSelected/hasOpenIDLink)', () => {
    const u = toAbsUser(makeAbsUser({ email: 'a@b.c' }));
    expect(u.email).toBe('a@b.c');
    expect(u.isOldToken).toBe(false);
    expect(u.hasOpenIDLink).toBe(false);
    // ABS names this `itemTagsSelected`, not `itemTagsAccessible`
    expect(u.itemTagsSelected).toEqual([]);
    expect(u).not.toHaveProperty('itemTagsAccessible');
  });

  it('emits the access token in both `token` (legacy) and `accessToken`; refresh defaults to null', () => {
    const u = toAbsUser(makeAbsUser(), { accessToken: 'acc' });
    expect(u.token).toBe('acc');
    expect(u.accessToken).toBe('acc');
    expect(u.refreshToken).toBeNull();
  });

  it('grants superusers every permission and an empty librariesAccessible ("all")', () => {
    const u = toAbsUser(makeAbsUser({ isSuperuser: true }), { librariesAccessible: ['lib_1'] });
    expect(u.permissions).toMatchObject({ download: true, update: true, delete: true, upload: true, accessAllLibraries: true });
    expect(u.librariesAccessible).toEqual([]); // superuser => "all", supplied list ignored
  });

  it('maps a plain user with no permissions to all-false library perms', () => {
    const u = toAbsUser(makeAbsUser({ isSuperuser: false, permissions: [] }), { librariesAccessible: ['lib_3'] });
    expect(u.permissions).toMatchObject({ download: false, update: false, delete: false, upload: false, accessAllLibraries: false });
    expect(u.librariesAccessible).toEqual(['lib_3']);
  });

  it('reflects granted permissions for a scoped user', () => {
    const u = toAbsUser(makeAbsUser({ isSuperuser: false, permissions: ALL_LIBRARY_PERMISSIONS }));
    expect(u.permissions).toMatchObject({ download: true, update: true, delete: true, upload: true });
  });
});

describe('toAbsLoginPayload', () => {
  it('produces the full login body (user + serverSettings + Source + ereaderDevices)', () => {
    const payload = toAbsLoginPayload(makeAbsUser(), {
      accessToken: 'acc',
      refreshToken: 'ref',
      userDefaultLibraryId: 'lib_2',
    });
    expect(payload.Source).toBe('bookorbit');
    expect(payload.userDefaultLibraryId).toBe('lib_2');
    expect(payload.ereaderDevices).toEqual([]);
    expect(payload.serverSettings).toBeDefined();
    const user = payload.user as Record<string, unknown>;
    expect(user.accessToken).toBe('acc');
    // the mobile flow returns the refresh token in the body (REIMPLEMENTATION_GUIDE §2.2)
    expect(user.refreshToken).toBe('ref');
  });

  it('defaults userDefaultLibraryId to null when not provided', () => {
    const payload = toAbsLoginPayload(makeAbsUser(), { accessToken: 'a', refreshToken: null });
    expect(payload.userDefaultLibraryId).toBeNull();
  });
});

describe('buildAbsServerSettings', () => {
  it('advertises the ABS server version this adapter targets', () => {
    expect(buildAbsServerSettings().version).toBe(ABS_SERVER_VERSION);
  });

  it('reports only local auth via authActiveAuthMethods (required by strict clients)', () => {
    expect(buildAbsServerSettings().authActiveAuthMethods).toEqual(['local']);
  });
});
