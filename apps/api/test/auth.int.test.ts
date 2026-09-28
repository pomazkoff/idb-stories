import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ADMIN_ORIGIN, createTestApi, testEnv, type TestApi } from './helpers.js';

describe('аутентификация и сессии админки (раздел 10.2)', () => {
  let api: TestApi;
  beforeAll(async () => {
    api = await createTestApi();
  });
  afterAll(async () => {
    await api.close();
  });

  it('вход через SSO создаёт сессию с флагами HttpOnly, Secure, SameSite=Strict', async () => {
    const start = await api.adminApp.inject({
      method: 'GET',
      url: '/admin/v1/auth/login?returnTo=/groups',
    });
    expect(start.statusCode).toBe(302);
    const loginCookie = start.cookies.find((c) => c.name === '__Host-stories_login');
    expect(loginCookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });

    const authorize = new URL(start.headers.location as string);
    const idp = await api.adminApp.inject({
      method: 'POST',
      url: '/admin/v1/dev/mock-idp/authorize',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        subject: 'mock-editor',
        state: authorize.searchParams.get('state')!,
        nonce: authorize.searchParams.get('nonce')!,
      }).toString(),
    });
    const callback = new URL(idp.headers.location as string);
    const done = await api.adminApp.inject({
      method: 'GET',
      url: `${callback.pathname}${callback.search}`,
      headers: { cookie: `__Host-stories_login=${loginCookie!.value}` },
    });
    expect(done.statusCode).toBe(302);
    expect(done.headers.location).toBe(`${ADMIN_ORIGIN}/groups`);
    const sid = done.cookies.find((c) => c.name === '__Host-stories_sid');
    expect(sid).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/' });
    expect(sid!.domain).toBeUndefined();

    const me = await api.adminApp.inject({
      method: 'GET',
      url: '/admin/v1/auth/me',
      headers: { cookie: `__Host-stories_sid=${sid!.value}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: { email: 'editor@idb.local', roles: ['editor'] } });
    expect(me.json().permissions).toContain('groups:write');
    expect(me.json().permissions).not.toContain('groups:review');
  });

  it('подменённый state не проходит и пишется как неуспешный вход', async () => {
    const start = await api.adminApp.inject({ method: 'GET', url: '/admin/v1/auth/login' });
    const authorize = new URL(start.headers.location as string);
    const idp = await api.adminApp.inject({
      method: 'POST',
      url: '/admin/v1/dev/mock-idp/authorize',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        subject: 'mock-admin',
        state: 'forged-state',
        nonce: authorize.searchParams.get('nonce')!,
      }).toString(),
    });
    const callback = new URL(idp.headers.location as string);
    const cookie = start.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const res = await api.adminApp.inject({
      method: 'GET',
      url: `${callback.pathname}${callback.search}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${ADMIN_ORIGIN}/login?error=sso`);
    expect(res.cookies.find((c) => c.name === '__Host-stories_sid')).toBeUndefined();
    expect(api.adapters.siem.events.some((e) => e.type === 'auth.failed')).toBe(true);
  });

  it('returnTo не может увести на чужой домен', async () => {
    for (const evil of ['https://evil.com', '//evil.com', '/\\evil.com']) {
      const start = await api.adminApp.inject({
        method: 'GET',
        url: `/admin/v1/auth/login?returnTo=${encodeURIComponent(evil)}`,
      });
      expect(start.statusCode).toBe(302);
      const stored = await api.deps.sessionRedis.keys(`${api.config.redisPrefix}login:*`);
      expect(stored.length).toBeGreaterThan(0);
    }
    const s = await api.login('mock-editor');
    expect(s.userId).toBeTruthy();
  });

  it('без сессии — 401, с чужой cookie — 401', async () => {
    expect((await api.admin(null, 'GET', '/admin/v1/groups')).statusCode).toBe(401);
    const res = await api.adminApp.inject({
      method: 'GET',
      url: '/admin/v1/groups',
      headers: { cookie: '__Host-stories_sid=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('изменяющие запросы без CSRF-токена или с чужим Origin отклоняются', async () => {
    const s = await api.login('mock-editor');
    const body = {
      title: 'X',
      placement: 'home',
      startAt: '2026-01-01T00:00:00Z',
      endAt: '2027-01-01T00:00:00Z',
      platforms: ['web'],
    };
    const noToken = await api.admin({ ...s, csrf: '' }, 'POST', '/admin/v1/groups', body);
    expect(noToken.statusCode).toBe(403);
    expect(noToken.json().error.code).toBe('csrf_failed');
    const wrongToken = await api.admin(
      { ...s, csrf: 'x'.repeat(43) },
      'POST',
      '/admin/v1/groups',
      body,
    );
    expect(wrongToken.statusCode).toBe(403);
    const evilOrigin = await api.admin(s, 'POST', '/admin/v1/groups', body, {
      origin: 'https://evil.com',
    });
    expect(evilOrigin.statusCode).toBe(403);
    const crossSite = await api.admin(s, 'POST', '/admin/v1/groups', body, {
      'sec-fetch-site': 'cross-site',
    });
    expect(crossSite.statusCode).toBe(403);
    const ok = await api.admin(s, 'POST', '/admin/v1/groups', body, { origin: ADMIN_ORIGIN });
    expect(ok.statusCode).toBe(201);
  });

  it('выход удаляет сессию', async () => {
    const s = await api.login('mock-analyst');
    expect((await api.admin(s, 'POST', '/admin/v1/auth/logout')).statusCode).toBe(204);
    expect((await api.admin(s, 'GET', '/admin/v1/auth/me')).statusCode).toBe(401);
  });

  it('idle-timeout 30 минут и абсолютный 8 часов', async () => {
    const t0 = api.clock.now.getTime();
    try {
      const s = await api.login('mock-analyst');
      const sid = s.cookie.split('=')[1]!;
      api.clock.now = new Date(t0 + 29 * 60 * 1000);
      expect(await api.sessions.get(sid)).not.toBeNull();
      api.clock.now = new Date(t0 + 60 * 60 * 1000);
      expect(await api.sessions.get(sid)).toBeNull();

      // активность каждые 20 минут не продлевает сессию дольше 8 часов
      api.clock.now = new Date(t0);
      const s2 = await api.login('mock-analyst');
      const sid2 = s2.cookie.split('=')[1]!;
      for (let minutes = 20; minutes <= 8 * 60 - 20; minutes += 20) {
        api.clock.now = new Date(t0 + minutes * 60 * 1000);
        expect(await api.sessions.get(sid2)).not.toBeNull();
      }
      api.clock.now = new Date(t0 + (8 * 60 + 1) * 60 * 1000);
      expect(await api.sessions.get(sid2)).toBeNull();
    } finally {
      api.clock.now = new Date(t0);
    }
  });

  it('заблокированный пользователь теряет доступ сразу', async () => {
    const s = await api.login('mock-editor-2');
    await api.db.owner.adminUser.update({ where: { id: s.userId }, data: { disabled: true } });
    expect((await api.admin(s, 'GET', '/admin/v1/auth/me')).statusCode).toBe(401);
    await api.db.owner.adminUser.update({ where: { id: s.userId }, data: { disabled: false } });
  });

  it('пользователь без ролей входит, но не получает прав', async () => {
    const s = await api.login('mock-newcomer');
    const me = await api.admin(s, 'GET', '/admin/v1/auth/me');
    expect(me.json().permissions).toEqual([]);
    expect((await api.admin(s, 'GET', '/admin/v1/groups')).statusCode).toBe(403);
  });
});

describe('конфигурация: mock-IdP невозможно включить в production', () => {
  const prod = {
    NODE_ENV: 'production',
    ADMIN_ORIGIN: 'https://admin.example',
    CDN_BASE_URL: 'https://cdn.example',
    CUSTOMER_AUTH_PROVIDER: 'disabled',
    PUBLIC_CORS_ORIGINS: 'https://www.example',
  };
  it('SSO_PROVIDER=mock в production — ошибка старта', () => {
    expect(() => loadConfig(testEnv({ ...prod, SSO_PROVIDER: 'mock' }))).toThrow(
      /SSO_PROVIDER=mock запрещён/,
    );
  });
  it('процесс только с публичным API в production стартует без SSO', () => {
    const cfg = loadConfig(testEnv({ ...prod, API_SURFACES: 'public' }));
    expect(cfg.env).toBe('production');
    expect(cfg.surfaces).toEqual(['public']);
  });
  it('mock токенов покупателей и небезопасные cookie в production — ошибка старта', () => {
    expect(() =>
      loadConfig(
        testEnv({ ...prod, CUSTOMER_AUTH_PROVIDER: 'mock', ADMIN_COOKIE_SECURE: 'false' }),
      ),
    ).toThrow(/CUSTOMER_AUTH_PROVIDER=mock запрещён[\s\S]*ADMIN_COOKIE_SECURE=false/);
  });
});
