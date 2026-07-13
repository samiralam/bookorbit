import { Controller, Get, Req, Res, UseFilters, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import type { RequestUser } from '../../../common/types/request-user';
import { OidcService } from '../../auth/oidc/oidc.service';
import { LibraryService } from '../../library/library.service';
import { UserService } from '../../user/user.service';
import { encodeAbsId } from '../abs-id.util';
import { AbsExceptionFilter } from '../abs-exception.filter';
import { AbsHttpException } from '../abs-errors';
import { toAbsLoginPayload } from '../mappers/abs-user.mapper';
import { AbsProgressService } from '../services/abs-progress.service';
import { AbsAuthGuard } from './abs-auth.guard';
import { AbsSessionService } from './abs-session.service';

type Query = Record<string, string | undefined>;

/**
 * The official ABS app link the mobile-redirect hop may bounce an authorization code to. Always
 * allowed (and the fallback when state lookup misses); operators allow additional third-party client
 * URIs via `ABS_OIDC_MOBILE_REDIRECT_URIS` (see `app.absAllowedAppRedirects`).
 */
const DEFAULT_APP_REDIRECT = 'audiobookshelf://oauth';

/**
 * ABS OpenID Connect routes (REIMPLEMENTATION_GUIDE §2.6; mirrors ABS `OidcAuthStrategy`/`Auth.js`),
 * served at the router root and excluded from the global `api/v1` prefix. A thin adapter over
 * BookOrbit's own OIDC stack (`OidcService`): same provider record, claim mapping, and auto-provisioning,
 * so an ABS OIDC login resolves to the same BookOrbit user as the web flow. Tokens are minted ABS-shaped
 * via {@link AbsSessionService}.
 *
 * Two flows, detected exactly as ABS does (`response_type=code` | `redirect_uri` | `code_challenge`):
 * - **Web**: IdP `redirect_uri` = `<server>/auth/openid/callback`; server owns PKCE; on success either
 *   redirects same-origin with the token or returns it as JSON.
 * - **Mobile**: IdP `redirect_uri` = `<server>/auth/openid/mobile-redirect` (IdPs won't redirect to a
 *   custom app scheme); native client owns PKCE. The IdP hits mobile-redirect, which bounces the *code*
 *   to the app (`audiobookshelf://oauth`); the app then calls `/auth/openid/callback` with the
 *   `code_verifier` and receives tokens in the JSON body.
 *
 * Operator note: register `<server>/auth/openid/callback` (web) and/or `<server>/auth/openid/mobile-redirect`
 * (mobile) as allowed redirect URIs on the IdP client — same client/provider as BookOrbit's web login.
 */
@Public()
@UseFilters(AbsExceptionFilter)
@Controller('auth/openid')
export class AbsOpenidController {
  private readonly appOrigin: string;
  /** Exact-match allowlist of mobile redirect URIs (RFC 8252 / OAuth Security BCP — no wildcards). */
  private readonly allowedAppRedirects: Set<string>;

  constructor(
    private readonly oidcService: OidcService,
    private readonly userService: UserService,
    private readonly sessionService: AbsSessionService,
    private readonly libraryService: LibraryService,
    private readonly progressService: AbsProgressService,
    config: ConfigService,
  ) {
    this.appOrigin = safeOrigin(config.get<string>('app.appUrl') ?? '');
    this.allowedAppRedirects = new Set([DEFAULT_APP_REDIRECT, ...(config.get<string[]>('app.absAllowedAppRedirects') ?? [])]);
  }

  /** Begin OIDC: build the provider authorize URL and 302 to it. */
  @Get()
  async begin(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const q = (req.query ?? {}) as Query;

    if (q.response_type && q.response_type !== 'code') {
      throw AbsHttpException.text(400, 'Invalid response_type, only code supported');
    }

    let mobile: { appRedirect: string; clientState?: string; clientCodeChallenge: string } | undefined;
    if (isMobileFlow(q)) {
      if (!q.redirect_uri || !this.allowedAppRedirects.has(q.redirect_uri)) {
        throw AbsHttpException.text(400, 'Invalid redirect_uri');
      }
      if (!q.code_challenge) throw AbsHttpException.text(400, 'code_challenge required for mobile flow (PKCE)');
      if (q.code_challenge_method && q.code_challenge_method !== 'S256') {
        throw AbsHttpException.text(400, 'Only S256 code_challenge_method supported');
      }
      mobile = { appRedirect: q.redirect_uri, clientState: q.state, clientCodeChallenge: q.code_challenge };
    }

    const authorizeUrl = await this.oidcService.beginAbsAuthorization({
      callbackUri: this.serverUri(req, 'callback'),
      mobileRedirectUri: this.serverUri(req, 'mobile-redirect'),
      mobile,
      // Web: the same-origin URL to hand the token back to. ABS web uses `?callback=` (not `redirect_uri`,
      // which would trip mobile detection). Same-origin is enforced when the token is actually emitted.
      finalRedirect: mobile ? undefined : q.callback,
    });
    // Pass the status explicitly: Nest's Fastify adapter pre-sets the reply status to 200, and
    // Fastify's `redirect()` reuses an already-set status instead of defaulting to 302 — a 200 with a
    // `Location` header isn't followed (iOS renders the empty body as a blank "openid" download).
    reply.redirect(authorizeUrl, 302);
  }

  /**
   * The IdP-facing hop for the mobile flow: bounce the authorization `code` (single-use, PKCE-bound) to
   * the app's link, which then completes via `/callback`. Carries no token. Non-consuming on the state.
   */
  @Get('mobile-redirect')
  async mobileRedirect(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const q = (req.query ?? {}) as Query;
    if (!q.state) throw AbsHttpException.text(400, 'State parameter mismatch');

    const appRedirect = (await this.oidcService.getAbsMobileAppRedirect(q.state)) ?? DEFAULT_APP_REDIRECT;
    const target = new URL(appRedirect);
    // Forward only the protocol params the app needs to complete the exchange.
    for (const key of ['code', 'state', 'error', 'error_description'] as const) {
      if (q[key] != null) target.searchParams.set(key, q[key]);
    }
    reply.redirect(target.toString(), 302);
  }

  /** OIDC code exchange. Tokens are returned as JSON for mobile/native; web redirects same-origin. */
  @Get('callback')
  async callback(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const q = (req.query ?? {}) as Query;
    if (!q.code || !q.state) throw AbsHttpException.text(400, 'Missing code or state');

    const {
      user: resolved,
      authMethod,
      finalRedirect,
    } = await this.oidcService.resolveAbsLoginUser({
      state: q.state,
      code: q.code,
      clientCodeVerifier: q.code_verifier,
    });

    const user = await this.userService.findByIdWithPermissions(resolved.id);
    if (!user || !user.active) throw AbsHttpException.unauthorized();

    const tokens = await this.sessionService.createSession(user.id, user.username, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // Web flow with a same-origin callback: hand the token back on the query string (ABS `auth_cb`).
    // Same-origin only — never an arbitrary `redirect_uri`, which would leak the freshly minted tokens.
    if (authMethod === 'openid' && finalRedirect && this.isSameOriginRedirect(finalRedirect)) {
      const target = new URL(finalRedirect);
      target.searchParams.set('setToken', tokens.accessToken);
      target.searchParams.set('accessToken', tokens.accessToken);
      target.searchParams.set('state', q.state);
      reply.redirect(target.toString(), 302);
      return;
    }

    // Mobile/native (and web without a usable callback): tokens in the JSON body (mirrors POST /login,
    // including the user's full mediaProgress — clients seed cross-device resume positions from it).
    const [accessibleIds, mediaProgress] = await Promise.all([
      this.libraryService.findAccessibleLibraryIds(user),
      this.progressService.listMediaProgressForUser(user.id),
    ]);
    const payload = toAbsLoginPayload(user, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      mediaProgress,
      librariesAccessible: user.isSuperuser ? [] : accessibleIds.map((id) => encodeAbsId('library', id)),
      userDefaultLibraryId: accessibleIds.length ? encodeAbsId('library', accessibleIds[0]) : null,
    });
    reply.status(200).send(payload);
  }

  /** Admin-only: read a provider's `.well-known/openid-configuration`. Non-admins get 403, matching ABS. */
  @Get('config')
  @UseGuards(AbsAuthGuard)
  config(@CurrentUser() user: RequestUser, @Req() req: FastifyRequest): ReturnType<OidcService['readDiscoveryDoc']> {
    if (!user.isSuperuser) throw AbsHttpException.forbidden();
    const issuer = ((req.query ?? {}) as Query).issuer;
    if (!issuer) throw AbsHttpException.text(400, "Invalid request. Query param 'issuer' is required");
    return this.oidcService.readDiscoveryDoc(issuer);
  }

  /** Tokens may be redirected only to BookOrbit's own configured origin (same-origin web callback). */
  private isSameOriginRedirect(redirect: string): boolean {
    return this.appOrigin !== '' && safeOrigin(redirect) === this.appOrigin;
  }

  /** A server route URL (`<origin>/auth/openid/<path>`), honoring proxy headers. */
  private serverUri(req: FastifyRequest, path: 'callback' | 'mobile-redirect'): string {
    const forwardedProto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
    const forwardedHost = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim();
    const proto = forwardedProto || req.protocol || 'https';
    const host = forwardedHost || req.headers.host;
    return `${proto}://${host}/auth/openid/${path}`;
  }
}

/** ABS mobile-flow detection: any of `response_type=code`, `redirect_uri`, or `code_challenge`. */
function isMobileFlow(q: Query): boolean {
  return q.response_type === 'code' || !!q.redirect_uri || !!q.code_challenge;
}

/** The `origin` of a URL, or `''` if it can't be parsed (so it never matches an allow-list entry). */
function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}
