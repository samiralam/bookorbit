import type { ConfigService } from '@nestjs/config';

import type { OidcService } from '../../auth/oidc/oidc.service';
import type { LibraryService } from '../../library/library.service';
import type { UserService } from '../../user/user.service';
import { makeAbsUser, makeRequest, thrownStatus } from '../__testing__/abs-test-helpers';
import type { AbsProgressService } from '../services/abs-progress.service';
import { AbsOpenidController } from './abs-openid.controller';
import type { AbsSessionService } from './abs-session.service';

const APP_URL = 'https://app.example';

/** Fastify reply mock recording redirect/status/body. */
function makeReply() {
  const calls: { redirect?: string; redirectStatus?: number; status: number; body: unknown } = { status: 200, body: undefined };
  const reply: any = {
    redirect(url: string, code?: number) {
      calls.redirect = url;
      calls.redirectStatus = code;
      return reply;
    },
    status(code: number) {
      calls.status = code;
      return reply;
    },
    send(body: unknown) {
      calls.body = body;
      return reply;
    },
  };
  return { reply, calls };
}

interface BuildOpts {
  authorizeUrl?: string;
  resolve?: { user: { id: number }; authMethod?: string; finalRedirect?: string };
  mobileAppRedirect?: string | null;
  user?: ReturnType<typeof makeAbsUser> | null;
  accessibleIds?: number[];
  mediaProgress?: Record<string, unknown>[];
  discoveryDoc?: Record<string, unknown>;
  allowedAppRedirects?: string[];
}

function build(opts: BuildOpts = {}) {
  const oidcService = {
    beginAbsAuthorization: vi.fn().mockResolvedValue(opts.authorizeUrl ?? 'https://idp.example/authorize?x=1'),
    resolveAbsLoginUser: vi.fn().mockResolvedValue(opts.resolve ?? { user: { id: 1 }, authMethod: 'openid-mobile' }),
    getAbsMobileAppRedirect: vi.fn().mockResolvedValue(opts.mobileAppRedirect ?? 'audiobookshelf://oauth'),
    readDiscoveryDoc: vi.fn().mockResolvedValue(opts.discoveryDoc ?? { issuer: 'https://idp.example' }),
  } as unknown as OidcService;
  const userService = {
    findByIdWithPermissions: vi.fn().mockResolvedValue(opts.user === undefined ? makeAbsUser({ id: 1, isSuperuser: false }) : opts.user),
  } as unknown as UserService;
  const sessionService = {
    createSession: vi.fn().mockResolvedValue({ accessToken: 'acc', refreshToken: 'ref' }),
  } as unknown as AbsSessionService;
  const libraryService = {
    findAccessibleLibraryIds: vi.fn().mockResolvedValue(opts.accessibleIds ?? []),
  } as unknown as LibraryService;
  const config = {
    get: vi.fn((key: string) => (key === 'app.absAllowedAppRedirects' ? (opts.allowedAppRedirects ?? []) : APP_URL)),
  } as unknown as ConfigService;
  const progressService = {
    listMediaProgressForUser: vi.fn().mockResolvedValue(opts.mediaProgress ?? []),
  } as unknown as AbsProgressService;
  return {
    controller: new AbsOpenidController(oidcService, userService, sessionService, libraryService, progressService, config),
    oidcService,
    sessionService,
    progressService,
  };
}

describe('AbsOpenidController#begin', () => {
  it('redirects to the provider authorize URL', async () => {
    const { controller } = build({ authorizeUrl: 'https://idp.example/authorize?state=s' });
    const { reply, calls } = makeReply();
    await controller.begin(makeRequest({ headers: { host: 'abs.example' } }), reply);
    expect(calls.redirect).toBe('https://idp.example/authorize?state=s');
    // Must be an explicit 302: Fastify's redirect() reuses the 200 Nest pre-sets otherwise, and a 200
    // with a Location header isn't followed (iOS shows a blank "openid" download).
    expect(calls.redirectStatus).toBe(302);
  });

  it('passes the server callback + mobile-redirect URIs (proxy-aware) for a web flow', async () => {
    const { controller, oidcService } = build();
    const { reply } = makeReply();
    await controller.begin(
      makeRequest({ headers: { host: 'internal:3000', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'abs.public' } }),
      reply,
    );
    expect(oidcService.beginAbsAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackUri: 'https://abs.public/auth/openid/callback',
        mobileRedirectUri: 'https://abs.public/auth/openid/mobile-redirect',
        mobile: undefined,
      }),
    );
  });

  it('builds a mobile flow from redirect_uri + code_challenge, preserving client state', async () => {
    const { controller, oidcService } = build();
    const { reply } = makeReply();
    await controller.begin(
      makeRequest({
        headers: { host: 'abs.example' },
        query: { response_type: 'code', redirect_uri: 'audiobookshelf://oauth', code_challenge: 'chal', state: 'client-state' },
      }),
      reply,
    );
    expect(oidcService.beginAbsAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        mobile: { appRedirect: 'audiobookshelf://oauth', clientState: 'client-state', clientCodeChallenge: 'chal' },
      }),
    );
  });

  it('passes the web callback via the ?callback param (not redirect_uri)', async () => {
    const { controller, oidcService } = build();
    const { reply } = makeReply();
    await controller.begin(makeRequest({ headers: { host: 'abs.example' }, query: { callback: `${APP_URL}/cb` } }), reply);
    expect(oidcService.beginAbsAuthorization).toHaveBeenCalledWith(expect.objectContaining({ mobile: undefined, finalRedirect: `${APP_URL}/cb` }));
  });

  it('rejects a mobile flow without a code_challenge', async () => {
    const { controller } = build();
    const { reply } = makeReply();
    expect(
      await thrownStatus(() =>
        controller.begin(makeRequest({ headers: { host: 'abs.example' }, query: { redirect_uri: 'audiobookshelf://oauth' } }), reply),
      ),
    ).toBe(400);
  });

  it('rejects a mobile redirect_uri that is not the app scheme', async () => {
    const { controller } = build();
    const { reply } = makeReply();
    expect(
      await thrownStatus(() =>
        controller.begin(
          makeRequest({ headers: { host: 'abs.example' }, query: { redirect_uri: 'https://evil.example', code_challenge: 'c' } }),
          reply,
        ),
      ),
    ).toBe(400);
  });

  it('rejects a third-party app redirect_uri that is not in the configured allowlist', async () => {
    const { controller } = build();
    const { reply } = makeReply();
    expect(
      await thrownStatus(() =>
        controller.begin(makeRequest({ headers: { host: 'abs.example' }, query: { redirect_uri: 'stillapp://oauth', code_challenge: 'c' } }), reply),
      ),
    ).toBe(400);
  });

  it('accepts an operator-allowlisted third-party app redirect_uri', async () => {
    const { controller, oidcService } = build({ allowedAppRedirects: ['stillapp://oauth'] });
    const { reply } = makeReply();
    await controller.begin(
      makeRequest({ headers: { host: 'abs.example' }, query: { redirect_uri: 'stillapp://oauth', code_challenge: 'chal', state: 's' } }),
      reply,
    );
    expect(oidcService.beginAbsAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ mobile: { appRedirect: 'stillapp://oauth', clientState: 's', clientCodeChallenge: 'chal' } }),
    );
  });

  it('always accepts the built-in audiobookshelf:// app redirect without configuration', async () => {
    const { controller, oidcService } = build({ allowedAppRedirects: [] });
    const { reply } = makeReply();
    await controller.begin(
      makeRequest({ headers: { host: 'abs.example' }, query: { redirect_uri: 'audiobookshelf://oauth', code_challenge: 'chal' } }),
      reply,
    );
    expect(oidcService.beginAbsAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ mobile: expect.objectContaining({ appRedirect: 'audiobookshelf://oauth' }) }),
    );
  });

  it('rejects a non-code response_type', async () => {
    const { controller } = build();
    const { reply } = makeReply();
    expect(
      await thrownStatus(() => controller.begin(makeRequest({ headers: { host: 'abs.example' }, query: { response_type: 'token' } }), reply)),
    ).toBe(400);
  });
});

describe('AbsOpenidController#mobileRedirect', () => {
  it('bounces the code + state to the stashed app link', async () => {
    const { controller } = build({ mobileAppRedirect: 'audiobookshelf://oauth' });
    const { reply, calls } = makeReply();
    await controller.mobileRedirect(makeRequest({ query: { code: 'abc', state: 's' } }), reply);
    const url = new URL(calls.redirect!);
    expect(url.protocol).toBe('audiobookshelf:');
    expect(url.searchParams.get('code')).toBe('abc');
    expect(url.searchParams.get('state')).toBe('s');
    expect(url.searchParams.get('accessToken')).toBeNull(); // no token on this hop
  });

  it('falls back to the default app link when the state is unknown', async () => {
    const { controller } = build({ mobileAppRedirect: null });
    const { reply, calls } = makeReply();
    await controller.mobileRedirect(makeRequest({ query: { code: 'abc', state: 's' } }), reply);
    expect(calls.redirect).toContain('audiobookshelf://oauth');
  });

  it('rejects when state is missing', async () => {
    const { controller } = build();
    const { reply } = makeReply();
    expect(await thrownStatus(() => controller.mobileRedirect(makeRequest({ query: { code: 'abc' } }), reply))).toBe(400);
  });
});

describe('AbsOpenidController#callback', () => {
  it('returns the login payload with tokens in the body for the mobile flow', async () => {
    const { controller, sessionService } = build({ resolve: { user: { id: 1 }, authMethod: 'openid-mobile' }, accessibleIds: [4] });
    const { reply, calls } = makeReply();
    await controller.callback(makeRequest({ query: { code: 'c', state: 's', code_verifier: 'v' } }), reply);
    const body = calls.body as Record<string, unknown>;
    const user = body.user as Record<string, unknown>;
    expect(user.accessToken).toBe('acc');
    expect(user.refreshToken).toBe('ref');
    expect(user.librariesAccessible).toEqual(['lib_4']);
    expect(calls.status).toBe(200);
    expect(sessionService.createSession).toHaveBeenCalledTimes(1);
  });

  it("embeds the user's mediaProgress in the login payload (clients seed resume positions from it)", async () => {
    const progress = [{ libraryItemId: 'li_9', currentTime: 120 }];
    const { controller, progressService } = build({ resolve: { user: { id: 1 }, authMethod: 'openid-mobile' }, mediaProgress: progress });
    const { reply, calls } = makeReply();
    await controller.callback(makeRequest({ query: { code: 'c', state: 's', code_verifier: 'v' } }), reply);
    const user = (calls.body as Record<string, unknown>).user as Record<string, unknown>;
    expect(user.mediaProgress).toEqual(progress);
    expect(progressService.listMediaProgressForUser).toHaveBeenCalledWith(1);
  });

  it('forwards the client code_verifier to the resolver', async () => {
    const { controller, oidcService } = build();
    const { reply } = makeReply();
    await controller.callback(makeRequest({ query: { code: 'c', state: 's', code_verifier: 'v' } }), reply);
    expect(oidcService.resolveAbsLoginUser).toHaveBeenCalledWith({ state: 's', code: 'c', clientCodeVerifier: 'v' });
  });

  it('redirects same-origin with the token for the web flow', async () => {
    const { controller } = build({ resolve: { user: { id: 1 }, authMethod: 'openid', finalRedirect: `${APP_URL}/cb` } });
    const { reply, calls } = makeReply();
    await controller.callback(makeRequest({ query: { code: 'c', state: 's' } }), reply);
    const url = new URL(calls.redirect!);
    expect(url.origin).toBe(APP_URL);
    expect(url.searchParams.get('accessToken')).toBe('acc');
    expect(url.searchParams.get('state')).toBe('s');
  });

  it('returns JSON (not a redirect) when a web callback is a foreign origin', async () => {
    const { controller } = build({ resolve: { user: { id: 1 }, authMethod: 'openid', finalRedirect: 'https://evil.example/grab' } });
    const { reply, calls } = makeReply();
    await controller.callback(makeRequest({ query: { code: 'c', state: 's' } }), reply);
    expect(calls.redirect).toBeUndefined();
    expect(calls.status).toBe(200);
    expect((calls.body as Record<string, unknown>).user).toBeDefined();
  });

  it('rejects a callback missing code or state with 400', async () => {
    const { controller } = build();
    const { reply } = makeReply();
    expect(await thrownStatus(() => controller.callback(makeRequest({ query: { state: 's' } }), reply))).toBe(400);
  });

  it('rejects when the resolved user is inactive', async () => {
    const { controller } = build({ user: makeAbsUser({ id: 1, active: false }) });
    const { reply } = makeReply();
    expect(await thrownStatus(() => controller.callback(makeRequest({ query: { code: 'c', state: 's' } }), reply))).toBe(401);
  });
});

describe('AbsOpenidController#config', () => {
  it('returns the discovery doc for an admin', async () => {
    const { controller, oidcService } = build({ discoveryDoc: { issuer: 'https://idp.example', tokenEndpoint: 'https://idp.example/token' } });
    const result = await controller.config(makeAbsUser({ isSuperuser: true }), makeRequest({ query: { issuer: 'https://idp.example' } }));
    expect(result).toMatchObject({ issuer: 'https://idp.example' });
    expect(oidcService.readDiscoveryDoc).toHaveBeenCalledWith('https://idp.example');
  });

  it('returns 403 for a non-admin (matches ABS)', async () => {
    const { controller } = build();
    expect(await thrownStatus(() => controller.config(makeAbsUser({ isSuperuser: false }), makeRequest({ query: { issuer: 'x' } })))).toBe(403);
  });

  it('returns 400 when issuer is missing', async () => {
    const { controller } = build();
    expect(await thrownStatus(() => controller.config(makeAbsUser({ isSuperuser: true }), makeRequest()))).toBe(400);
  });
});
