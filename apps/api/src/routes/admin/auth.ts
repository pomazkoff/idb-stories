import { SsoError, randomToken } from '@idb-stories/adapters';
import { permissionsOf } from '@idb-stories/schema';
import { authCallback, authLogin, authLogout, authMe } from '@idb-stories/schema/contracts';
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { SessionStore } from '../../auth/session.js';
import type { AppDeps } from '../../context.js';
import { cookieNames, route } from '../../http/routes.js';
import { toUserDto } from '../../services/mappers.js';

const LOGIN_STATE_TTL_SEC = 600;

/** Только относительный путь внутри админки — защита от open redirect после входа. */
export function safeReturnTo(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\s]/.test(value))
    return '/';
  return value;
}

interface LoginState {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
}

export function authRoutes(deps: AppDeps, sessions: SessionStore) {
  const { origin, cookieSecure, sessionAbsoluteSec } = deps.config.admin;
  const names = cookieNames(cookieSecure);
  const redirectUri = `${origin}/admin/v1/auth/callback`;
  const base: CookieSerializeOptions = { httpOnly: true, secure: cookieSecure, path: '/' };

  return [
    route(authLogin, async ({ query, reply }) => {
      // nosemgrep: ajinabraham.njsscan.redirect.open_redirect.express_open_redirect
      const auth = await deps.sso.createAuthRequest(redirectUri);
      const loginId = randomToken(24);
      const state: LoginState = {
        state: auth.state,
        nonce: auth.nonce,
        codeVerifier: auth.codeVerifier,
        returnTo: safeReturnTo(query.returnTo),
      };
      await deps.sessionRedis.set(
        deps.keys.loginState(loginId),
        JSON.stringify(state),
        'EX',
        LOGIN_STATE_TTL_SEC,
      );
      // Lax: cookie должна прийти на callback — это top-level переход с домена IdP.
      void reply.setCookie(names.login, loginId, {
        ...base,
        sameSite: 'lax',
        maxAge: LOGIN_STATE_TTL_SEC,
      });
      return reply.redirect(auth.url, 302);
    }),

    route(authCallback, async ({ req, query, reply }) => {
      const loginId = req.cookies[names.login];
      void reply.clearCookie(names.login, { ...base, sameSite: 'lax' });
      const fail = (reason: string) => {
        deps.security.emit('auth.failed', { ip: req.ip, requestId: req.id, details: { reason } });
        return reply.redirect(`${origin}/login?error=sso`, 302);
      };
      if (query.error) return fail(`idp_error:${query.error}`);
      if (!loginId || !/^[A-Za-z0-9_-]{32}$/.test(loginId)) return fail('no_login_state');
      const raw = await deps.sessionRedis.getdel(deps.keys.loginState(loginId));
      if (!raw) return fail('login_state_expired');
      const stored = JSON.parse(raw) as LoginState;

      const params = new URLSearchParams();
      if (query.code) params.set('code', query.code);
      if (query.state) params.set('state', query.state);
      let identity;
      try {
        identity = await deps.sso.handleCallback(params, stored, redirectUri);
      } catch (err) {
        return fail(err instanceof SsoError ? err.reason : 'sso_error');
      }

      const user = await deps.prisma.adminUser.upsert({
        where: { subject: identity.subject },
        create: {
          subject: identity.subject,
          email: identity.email,
          name: identity.name,
          lastLoginAt: deps.now(),
        },
        update: { email: identity.email, name: identity.name, lastLoginAt: deps.now() },
      });
      if (user.disabled) return fail('user_disabled');

      // Новый идентификатор сессии при каждом входе (защита от фиксации сессии).
      const { sid } = await sessions.create(user.id, req.ip);
      void reply.setCookie(names.session, sid, {
        ...base,
        sameSite: 'strict',
        maxAge: sessionAbsoluteSec,
      });
      deps.security.emit('auth.login', { actorId: user.id, ip: req.ip, requestId: req.id });
      return reply.redirect(`${origin}${stored.returnTo}`, 302);
    }),

    route(authLogout, async ({ req, reply, actor }) => {
      if (req.session) await sessions.destroy(req.session.sid, actor.id);
      void reply.clearCookie(names.session, { ...base, sameSite: 'strict' });
      deps.security.emit('auth.logout', { actorId: actor.id, ip: req.ip, requestId: req.id });
      reply.code(204);
      return undefined;
    }),

    route(authMe, async ({ req, actor }) => {
      const user = await deps.prisma.adminUser.findUniqueOrThrow({
        where: { id: actor.id },
        include: { roles: true },
      });
      const session = req.session!;
      return {
        user: toUserDto(user),
        permissions: permissionsOf(actor.roles),
        csrfToken: session.data.csrfToken,
        sessionExpiresAt: sessions.expiresAt(session.data).toISOString(),
      };
    }),
  ];
}
