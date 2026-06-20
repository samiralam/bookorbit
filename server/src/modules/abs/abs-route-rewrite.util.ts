/**
 * ABS exposes refresh at `POST /auth/refresh`, which is the exact path BookOrbit's own auth
 * controller already declares (served under the `api/v1` prefix). Two controllers cannot share the
 * `auth/refresh` route path, so the ABS handler is declared at a private internal path and incoming
 * `/auth/refresh` requests are remapped to it before routing via Fastify's `rewriteUrl` hook.
 *
 * Every other ABS path (`/login`, `/logout`, `/status`, `/api/me`, `/public/...`, …) is distinct
 * from BookOrbit's declared controller paths and is simply excluded from the global prefix instead.
 */
export const ABS_INTERNAL_REFRESH_PATH = '__abs/auth/refresh';

export function rewriteAbsUrl(url: string): string {
  const queryIndex = url.indexOf('?');
  const path = queryIndex === -1 ? url : url.slice(0, queryIndex);
  if (path === '/auth/refresh') {
    const query = queryIndex === -1 ? '' : url.slice(queryIndex);
    return `/${ABS_INTERNAL_REFRESH_PATH}${query}`;
  }
  return url;
}

/** Route paths (controller-declared, pre-prefix) the ABS adapter owns at the router root. */
export const ABS_EXCLUDED_ROUTES: string[] = [
  // Discovery
  'ping',
  'healthcheck',
  'status',
  'init',
  // Auth (refresh is reached via rewriteAbsUrl -> ABS_INTERNAL_REFRESH_PATH)
  'login',
  'logout',
  '__abs/(.*)',
  // OIDC (distinct from BookOrbit's own `api/v1/auth/oidc/*` web flow)
  'auth/openid',
  'auth/openid/(.*)',
  // API surface (distinct from BookOrbit's `api/v1/*` and `api/kobo/*`)
  'api/me',
  'api/me/(.*)',
  'api/libraries',
  'api/libraries/(.*)',
  'api/items',
  'api/items/(.*)',
  'api/authors',
  'api/authors/(.*)',
  'api/session',
  'api/session/(.*)',
  'api/sessions',
  'api/sessions/(.*)',
  'api/authorize',
  'api/playlists',
  'api/playlists/(.*)',
  // Public (open-session track streaming, shares)
  'public/(.*)',
  // HLS transcode playlist/segment streaming
  'hls/(.*)',
];

/**
 * The excluded routes use Fastify route syntax (`(.*)` wildcards); anchored they double as regexes.
 * Compiled once so {@link isAbsRoute} can test a request path against the whole ABS surface.
 */
const ABS_ROUTE_MATCHERS: readonly RegExp[] = ABS_EXCLUDED_ROUTES.map((route) => new RegExp(`^/${route}$`));

/**
 * True when `url` falls under the ABS adapter surface. Used by the global exception filter to suppress
 * BookOrbit's `{ statusCode, message, ... }` envelope for ABS paths that never reach a controller (e.g.
 * unimplemented endpoints 404ing), since the controller-scoped `AbsExceptionFilter` only runs on matched
 * routes and a foreign envelope breaks strict ABS clients (see abs-exception.filter.ts).
 */
export function isAbsRoute(url: string): boolean {
  const queryIndex = url.indexOf('?');
  const path = queryIndex === -1 ? url : url.slice(0, queryIndex);
  return ABS_ROUTE_MATCHERS.some((matcher) => matcher.test(path));
}
