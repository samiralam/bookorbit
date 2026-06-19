import { ABS_EXCLUDED_ROUTES, ABS_INTERNAL_REFRESH_PATH, isAbsRoute, rewriteAbsUrl } from './abs-route-rewrite.util';

describe('rewriteAbsUrl', () => {
  it('remaps POST /auth/refresh to the private internal path (avoids colliding with BookOrbit auth)', () => {
    expect(rewriteAbsUrl('/auth/refresh')).toBe(`/${ABS_INTERNAL_REFRESH_PATH}`);
  });

  it('preserves the query string when remapping refresh', () => {
    expect(rewriteAbsUrl('/auth/refresh?foo=bar')).toBe(`/${ABS_INTERNAL_REFRESH_PATH}?foo=bar`);
  });

  it('leaves every other URL untouched', () => {
    expect(rewriteAbsUrl('/login')).toBe('/login');
    expect(rewriteAbsUrl('/api/me')).toBe('/api/me');
    expect(rewriteAbsUrl('/auth/refresh/extra')).toBe('/auth/refresh/extra');
    expect(rewriteAbsUrl('/public/session/abc/track/0')).toBe('/public/session/abc/track/0');
  });
});

describe('ABS_EXCLUDED_ROUTES', () => {
  it('owns the discovery, auth, api, and public route prefixes at the router root', () => {
    for (const route of ['status', 'login', 'logout', 'api/me', 'api/libraries', 'api/items', 'api/session', 'public/(.*)']) {
      expect(ABS_EXCLUDED_ROUTES).toContain(route);
    }
  });

  it('routes the internal refresh path past the global prefix', () => {
    expect(ABS_EXCLUDED_ROUTES).toContain('__abs/(.*)');
  });
});

describe('isAbsRoute', () => {
  it('matches exact and wildcard ABS surface paths', () => {
    expect(isAbsRoute('/status')).toBe(true);
    expect(isAbsRoute('/api/me')).toBe(true);
    expect(isAbsRoute('/api/me/listening-sessions')).toBe(true);
    expect(isAbsRoute('/public/session/abc/track/0')).toBe(true);
    expect(isAbsRoute('/hls/abc/output-3.ts')).toBe(true);
  });

  it('ignores the query string when matching', () => {
    expect(isAbsRoute('/api/libraries/lib_5/items?filter=narrators.x')).toBe(true);
  });

  it('does not match BookOrbit native or unrelated routes', () => {
    expect(isAbsRoute('/api/v1/books/1')).toBe(false);
    expect(isAbsRoute('/api/kobo/token/library/sync')).toBe(false);
    expect(isAbsRoute('/foo')).toBe(false);
    expect(isAbsRoute('/api/men')).toBe(false);
  });
});
