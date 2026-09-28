import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_CONTEXT, runSchedulerTick } from '@idb-stories/core';
import type { AdminGroup, FeedResponse } from '@idb-stories/schema';
import { testRedisPrefix } from '@testkit/db.js';
import { createTestApi, type Session, type TestApi } from './helpers.js';
import { actors, approved, type Actors } from './fixtures.js';

describe('публичная лента GET /v1/feed', () => {
  let api: TestApi;
  let a: Actors;
  let admin: Session;
  let publisher: Session;
  const day = 86400_000;

  const get = (placement: string, headers: Record<string, string> = { 'x-platform': 'web' }) =>
    api.publicApp.inject({ method: 'GET', url: `/v1/feed?placement=${placement}`, headers });
  const ids = (body: FeedResponse) => body.groups.map((g) => g.id);

  beforeAll(async () => {
    api = await createTestApi();
    a = await actors(api);
    admin = await api.login('mock-admin');
    publisher = await api.login('mock-publisher');
  });
  afterAll(async () => {
    await api.close();
  });

  it('обязательные заголовки и параметры', async () => {
    expect(
      (await api.publicApp.inject({ method: 'GET', url: '/v1/feed?placement=home' })).statusCode,
    ).toBe(400);
    expect((await get('nowhere')).statusCode).toBe(400);
    const noVersion = await get('home', { 'x-platform': 'ios' });
    expect(noVersion.statusCode).toBe(400);
    expect(noVersion.json().error.code).toBe('app_version_required');
    expect((await get('home', { 'x-platform': 'ios', 'x-app-version': '5.12.0' })).statusCode).toBe(
      200,
    );
  });

  it('группа не попадает в ленту до start_at и после end_at (T5)', async () => {
    const t0 = Date.now();
    api.clock.now = new Date(t0);
    const grp = await approved(api, a, {
      placement: 'product',
      startAt: new Date(t0 + day).toISOString(),
      endAt: new Date(t0 + 2 * day).toISOString(),
    });
    expect(grp.status).toBe('approved');
    expect(ids((await get('product')).json())).not.toContain(grp.id);
    // медиа ещё не в публичном bucket
    expect(
      [...api.storage.objects.keys()].some(
        (k) => k.startsWith(`${api.config.s3.buckets.public}/`) && k.includes(grp.coverAssetId!),
      ),
    ).toBe(false);

    // наступил start_at: планировщик публикует
    api.clock.now = new Date(t0 + day + 1000);
    const tick = await runSchedulerTick(api.deps.publishing, SYSTEM_CONTEXT, api.clock.now);
    expect(tick.published).toBe(1);
    expect(ids((await get('product')).json())).toContain(grp.id);

    // прошёл end_at: даже до архивации планировщиком лента по времени фильтрует
    api.clock.now = new Date(t0 + 2 * day + 1000);
    expect(ids((await get('product')).json())).not.toContain(grp.id);
    const tick2 = await runSchedulerTick(api.deps.publishing, SYSTEM_CONTEXT, api.clock.now);
    expect(tick2.archived).toBe(1);
    api.clock.now = new Date(t0);
  });

  it('TTL ответа не дольше, чем до ближайшей смены состава', async () => {
    const t0 = Date.now();
    api.clock.now = new Date(t0);
    await approved(api, a, {
      placement: 'catalog',
      startAt: new Date(t0 - day).toISOString(),
      endAt: new Date(t0 + 20_000).toISOString(),
    });
    const res = await get('catalog');
    expect(res.json<FeedResponse>().ttl_sec).toBeLessThanOrEqual(20);
    expect(res.headers['cache-control']).toMatch(/^public, max-age=(1\d|20|[1-9])$/);
  });

  it('фильтр по платформе и min_app_version', async () => {
    const grp = await approved(api, a, {
      placement: 'cart',
      platforms: ['ios', 'android'],
      minAppVersion: { ios: '6.0.0', android: null },
    });
    expect(ids((await get('cart')).json())).not.toContain(grp.id);
    expect(
      ids((await get('cart', { 'x-platform': 'ios', 'x-app-version': '5.99.1' })).json()),
    ).not.toContain(grp.id);
    expect(
      ids((await get('cart', { 'x-platform': 'ios', 'x-app-version': '6.0' })).json()),
    ).toContain(grp.id);
    expect(
      ids((await get('cart', { 'x-platform': 'android', 'x-app-version': '1.0.0' })).json()),
    ).toContain(grp.id);
    // кеш по бакету версии не отдаёт группу старой версии после запроса новой
    expect(
      ids((await get('cart', { 'x-platform': 'ios', 'x-app-version': '5.99.2' })).json()),
    ).not.toContain(grp.id);
  });

  it('сортировка: priority desc, затем start_at desc', async () => {
    const t0 = Date.now();
    api.clock.now = new Date(t0);
    const low = await approved(api, a, { placement: 'home', priority: 1 });
    const high = await approved(api, a, { placement: 'home', priority: 100 });
    const newer = await approved(api, a, {
      placement: 'home',
      priority: 100,
      startAt: new Date(t0 - 1000).toISOString(),
    });
    const order = ids((await get('home')).json());
    expect(order.indexOf(newer.id)).toBeLessThan(order.indexOf(high.id));
    expect(order.indexOf(high.id)).toBeLessThan(order.indexOf(low.id));
  });

  it('в ответе нет имён сегментов, статусов, авторов; только CDN-ссылки', async () => {
    const res = await get('home');
    const text = res.body;
    for (const forbidden of [
      'seg_',
      'status',
      'createdBy',
      'approvedBy',
      'editor',
      'Редактор',
      'X-Amz-Signature',
      's3.test',
    ]) {
      expect(text).not.toContain(forbidden);
    }
    const urls = [...text.matchAll(/"url":"([^"]+)"/g)].map((m) => m[1]!);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith('https://cdn.stories.test/'))).toBe(true);
  });

  describe('таргетинг и кеширование (T6, T12)', () => {
    let targeted: AdminGroup;
    const token = (userId: string, opts?: { expiresInSec?: number; audience?: string }) =>
      api.adapters.customerAuth.issue(userId, opts);

    beforeAll(async () => {
      targeted = await approved(api, a, {
        placement: 'home',
        segmentIds: ['seg_loyal_gold'],
        title: 'Только для Gold',
      });
    });

    it('анонимный ответ публичный и без таргетированных групп', async () => {
      const res = await get('home');
      expect(res.headers['cache-control']).toMatch(/^public, max-age=\d+$/);
      expect(res.headers.vary).toContain('Authorization');
      expect(ids(res.json())).not.toContain(targeted.id);
    });

    it('персональный ответ: Cache-Control private, группы сегмента пользователя', async () => {
      const res = await get('home', {
        'x-platform': 'web',
        authorization: `Bearer ${await token('user-gold-1')}`,
      });
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(ids(res.json())).toContain(targeted.id);
      const other = await get('home', {
        'x-platform': 'web',
        authorization: `Bearer ${await token('user-new-1')}`,
      });
      expect(other.headers['cache-control']).toBe('private, no-store');
      expect(ids(other.json())).not.toContain(targeted.id);
    });

    it('поддельный, просроченный и чужой по audience токен — только общая лента', async () => {
      const valid = await token('user-gold-2');
      const [h, p] = valid.split('.');
      const cases = [
        `${h}.${p}.forged-signature`,
        await token('user-gold-3', { expiresInSec: -60 }),
        await token('user-gold-4', { audience: 'other-service' }),
        `${Buffer.from('{"alg":"none"}').toString('base64url')}.${p}.`,
        'not-a-jwt-token-at-all',
      ];
      for (const t of cases) {
        const res = await get('home', { 'x-platform': 'web', authorization: `Bearer ${t}` });
        expect(res.statusCode).toBe(200);
        expect(res.headers['cache-control']).toBe('private, no-store');
        expect(ids(res.json())).not.toContain(targeted.id);
      }
    });

    it('сегменты кешируются по хешу, а не по user_id; токены не попадают в логи', async () => {
      await get('home', {
        'x-platform': 'web',
        authorization: `Bearer ${await token('user-gold-5')}`,
      });
      const keys = await api.deps.redis.keys(`${api.config.redisPrefix}*`);
      expect(keys.some((k) => k.includes('user-gold'))).toBe(false);
      expect(keys.some((k) => k.startsWith(`${api.config.redisPrefix}seg:`))).toBe(true);
      const logs = api.logs.join('\n');
      expect(logs).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
      expect(logs).not.toContain('user-gold');
    });

    it('если адаптер сегментов недоступен — лента без таргетированных групп', async () => {
      const original = api.adapters.segments.getUserSegments.bind(api.adapters.segments);
      api.adapters.segments.getUserSegments = () => Promise.reject(new Error('down'));
      try {
        const res = await get('home', {
          'x-platform': 'web',
          authorization: `Bearer ${await token('user-gold-new-cache')}`,
        });
        expect(res.statusCode).toBe(200);
        expect(ids(res.json())).not.toContain(targeted.id);
      } finally {
        api.adapters.segments.getUserSegments = original;
      }
    });
  });

  it('kill switch опустошает ленту сразу и включается обратно', async () => {
    expect((await get('home')).json<FeedResponse>().groups.length).toBeGreaterThan(0);
    const bad = await api.admin(admin, 'PUT', '/admin/v1/settings/feed-enabled', {
      enabled: false,
      confirmation: 'отключить',
    });
    expect(bad.statusCode).toBe(400);
    const off = await api.admin(admin, 'PUT', '/admin/v1/settings/feed-enabled', {
      enabled: false,
      confirmation: 'ОТКЛЮЧИТЬ',
    });
    expect(off.statusCode).toBe(200);
    const empty = await get('home');
    expect(empty.json<FeedResponse>().groups).toEqual([]);
    expect(empty.headers['cache-control']).toBe('public, max-age=60');
    expect(api.adapters.siem.events.some((e) => e.type === 'kill_switch.changed')).toBe(true);
    await api.admin(admin, 'PUT', '/admin/v1/settings/feed-enabled', {
      enabled: true,
      confirmation: 'ВКЛЮЧИТЬ',
    });
    expect((await get('home')).json<FeedResponse>().groups.length).toBeGreaterThan(0);
  });

  it('снятие группы применяется сразу, несмотря на кеш', async () => {
    const grp = await approved(api, a, { placement: 'home', title: 'Снимем' });
    expect(ids((await get('home')).json())).toContain(grp.id);
    expect((await get('home')).headers['x-feed-cache']).toBe('hit');
    await api.admin(publisher, 'POST', `/admin/v1/groups/${grp.id}/unpublish`, {});
    expect(ids((await get('home')).json())).not.toContain(grp.id);
  });

  it('лента работает без Redis (деградация)', async () => {
    const broken = await createTestApi({
      REDIS_URL: 'redis://127.0.0.1:1',
      REDIS_PREFIX: testRedisPrefix(),
    });
    try {
      const res = await broken.publicApp.inject({
        method: 'GET',
        url: '/v1/feed?placement=home',
        headers: { 'x-platform': 'web' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<FeedResponse>().groups).toEqual([]);
    } finally {
      await broken.close();
    }
  });
});

describe('rate limit', () => {
  let api: TestApi;
  beforeAll(async () => {
    api = await createTestApi({ FEED_RATE_LIMIT_PER_MIN: '3', EVENTS_RATE_LIMIT_PER_MIN: '2' });
  });
  afterAll(async () => {
    await api.close();
  });

  it('срабатывает на /v1/feed и /v1/events и пишется как событие безопасности', async () => {
    const feed = () =>
      api.publicApp.inject({
        method: 'GET',
        url: '/v1/feed?placement=home',
        headers: { 'x-platform': 'web' },
      });
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await feed()).statusCode);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);

    const events = () =>
      api.publicApp.inject({
        method: 'POST',
        url: '/v1/events',
        headers: { 'content-type': 'application/json' },
        payload: { events: [{}] },
      });
    const ev = [];
    for (let i = 0; i < 4; i++) ev.push((await events()).statusCode);
    expect(ev).toEqual([202, 202, 429, 429]);
    expect(
      api.adapters.siem.events.filter((e) => e.type === 'rate_limit.exceeded').length,
    ).toBeGreaterThanOrEqual(4);
  });
});

describe('токены покупателей: граничные случаи', () => {
  let api: TestApi;
  beforeAll(async () => {
    api = await createTestApi();
  });
  afterAll(async () => {
    await api.close();
  });
  const get = (authorization: string) =>
    api.publicApp.inject({
      method: 'GET',
      url: '/v1/feed?placement=home',
      headers: { 'x-platform': 'web', authorization },
    });

  it('не Bearer-схема и недоступный адаптер авторизации — общая лента без ошибки', async () => {
    const basic = await get('Basic dXNlcjpwYXNz');
    expect(basic.statusCode).toBe(200);
    expect(basic.headers['cache-control']).toBe('private, no-store');
    const original = api.adapters.customerAuth.verify.bind(api.adapters.customerAuth);
    api.adapters.customerAuth.verify = () => Promise.reject(new Error('IdP down'));
    try {
      const res = await get(`Bearer ${await api.adapters.customerAuth.issue('user-gold-9')}`);
      expect(res.statusCode).toBe(200);
    } finally {
      api.adapters.customerAuth.verify = original;
    }
  });

  it('сегменты берутся из кеша при повторном запросе', async () => {
    const token = await api.adapters.customerAuth.issue('user-gold-cache');
    let calls = 0;
    const original = api.adapters.segments.getUserSegments.bind(api.adapters.segments);
    api.adapters.segments.getUserSegments = (id) => {
      calls += 1;
      return original(id);
    };
    try {
      await get(`Bearer ${token}`);
      await get(`Bearer ${token}`);
      expect(calls).toBe(1);
    } finally {
      api.adapters.segments.getUserSegments = original;
    }
  });
});
