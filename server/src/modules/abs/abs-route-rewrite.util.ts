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
  // API surface (distinct from BookOrbit's `api/v1/*` and `api/kobo/*`)
  'api/me',
  'api/me/(.*)',
  'api/libraries',
  'api/libraries/(.*)',
  'api/items',
  'api/items/(.*)',
  'api/session',
  'api/session/(.*)',
  'api/sessions',
  'api/sessions/(.*)',
  'api/authorize',
  'api/playlists',
  'api/playlists/(.*)',
  // Public (open-session track streaming, shares)
  'public/(.*)',
];
