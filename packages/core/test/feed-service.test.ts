import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@idb-stories/db';
import { FEED_SCHEMA_VERSION, LIMITS, type FeedGroup } from '@idb-stories/schema';
import {
  FeedService,
  bumpFeedGeneration,
  emptyFeed,
  segmentsHash,
  type FeedQueryInput,
} from '../src/feed/service.js';
import { createLogger } from '../src/logger.js';
import { feedCacheTotal } from '../src/metrics.js';
import { redisKeys, type Redis } from '../src/redis.js';
import type { SettingsService } from '../src/settings.js';

const T0 = Date.parse('2026-10-01T09:00:00Z');
const MIN = 60_000;
const keys = redisKeys('t:');
const GEN = keys.feedGeneration;

interface Row {
  groupId: string;
  version: number;
  placement: 'home' | 'catalog' | 'product' | 'cart';
  priority: number;
  startAt: Date;
  endAt: Date;
  platforms: ('ios' | 'android' | 'web')[];
  minAppVersionIos: string | null;
  minAppVersionAndroid: string | null;
  segmentIds: string[];
  payload: FeedGroup;
}

function payload(id: string): FeedGroup {
  return {
    id,
    version: 1,
    title: id,
    cover: { url: 'https://cdn.example/c.webp', w: 256, h: 256 },
    slides: [
      {
        id: '00000000-0000-4000-8000-000000000001',
        type: 'product',
        duration_ms: 6000,
        product_skus: ['SKU1'],
        elements: [],
        cta: null,
      },
    ],
  };
}

function row(id: string, overrides: Partial<Row> = {}): Row {
  return {
    groupId: id,
    version: 1,
    placement: 'home',
    priority: 0,
    startAt: new Date(T0 - 60 * MIN),
    endAt: new Date(T0 + 60 * MIN),
    platforms: ['ios', 'android', 'web'],
    minAppVersionIos: null,
    minAppVersionAndroid: null,
    segmentIds: [],
    payload: payload(id),
    ...overrides,
  };
}

/** Redis в памяти с переключаемыми отказами отдельных команд. */
class FakeRedis {
  store = new Map<string, string>();
  gets: string[] = [];
  sets: { key: string; value: string; mode: string; ttl: number }[] = [];
  failGet: (key: string) => boolean = () => false;
  failSet = false;
  failIncr = false;

  get(key: string): Promise<string | null> {
    this.gets.push(key);
    if (this.failGet(key)) return Promise.reject(new Error('redis get: connection refused'));
    return Promise.resolve(this.store.get(key) ?? null);
  }

  set(key: string, value: string, mode: string, ttl: number): Promise<'OK'> {
    this.sets.push({ key, value, mode, ttl });
    if (this.failSet) return Promise.reject(new Error('redis set: connection refused'));
    this.store.set(key, value);
    return Promise.resolve('OK');
  }

  incr(key: string): Promise<number> {
    if (this.failIncr) return Promise.reject(new Error('redis incr: connection refused'));
    const next = Number(this.store.get(key) ?? '0') + 1;
    this.store.set(key, String(next));
    return Promise.resolve(next);
  }

  /** Все чтения, кроме ключа поколения. */
  responseGets(): string[] {
    return this.gets.filter((k) => k !== GEN);
  }
}

function captureLogger() {
  const lines: string[] = [];
  const logger = createLogger({
    name: 'feed-test',
    level: 'debug',
    destination: new Writable({
      write(chunk: Buffer, _e, cb) {
        lines.push(chunk.toString());
        cb();
      },
    }),
  });
  const entries = () =>
    lines.map((l) => JSON.parse(l) as { level: string; msg: string; err?: { message: string } });
  return { logger, entries };
}

function setup(opts: { rows?: Row[]; enabled?: boolean; withClock?: boolean } = {}) {
  const redis = new FakeRedis();
  const clock = { now: T0 };
  const db = {
    rows: opts.rows ?? [row('g1')],
    calls: [] as unknown[],
    findMany: (args: unknown): Promise<Row[]> => {
      db.calls.push(args);
      return Promise.resolve(db.rows);
    },
  };
  const settings = { enabled: opts.enabled ?? true };
  const { logger, entries } = captureLogger();
  const service = new FeedService({
    prisma: {
      publishedSnapshot: { findMany: (args: unknown) => db.findMany(args) },
    } as unknown as PrismaClient,
    redis: redis as unknown as Redis,
    keys,
    settings: {
      isFeedEnabled: () => Promise.resolve(settings.enabled),
    } as unknown as SettingsService,
    logger,
    now: opts.withClock === false ? undefined : () => clock.now,
  });
  return { service, redis, clock, db, settings, entries };
}

const req: FeedQueryInput = {
  placement: 'home',
  platform: 'ios',
  appVersion: '5.12.0',
  userSegments: null,
};
const respKey = (gen: string, parts = 'home:ios:v0of0:anon') => keys.feedResponse(gen, parts);

interface FeedBody {
  schema_version: number;
  generated_at: string;
  ttl_sec: number;
  groups: FeedGroup[];
}
const parse = (body: string) => JSON.parse(body) as FeedBody;
const groupIds = (body: string) => parse(body).groups.map((g) => g.id);

/** Все фейки отвечают через микрозадачи: после setImmediate очередь микрозадач уже пуста. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

async function cacheCounter(result: 'hit' | 'miss' | 'disabled'): Promise<number> {
  const metric = await feedCacheTotal.get();
  return metric.values.find((v) => v.labels.result === result)?.value ?? 0;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('FeedService: kill switch', () => {
  it('выключенная лента: пустой ответ с ttl 60, без обращений к БД и кешу ответов', async () => {
    const { service, redis, db } = setup({ enabled: false });
    const before = await cacheCounter('disabled');

    const res = await service.getFeed(req);

    expect(res).toEqual({ body: emptyFeed(T0), ttlSec: 60, cache: 'disabled' });
    expect(parse(res.body)).toEqual({
      schema_version: FEED_SCHEMA_VERSION,
      generated_at: '2026-10-01T09:00:00.000Z',
      ttl_sec: 60,
      groups: [],
    });
    expect(db.calls).toHaveLength(0);
    expect(redis.gets).toEqual([]);
    expect(redis.sets).toEqual([]);
    expect(await cacheCounter('disabled')).toBe(before + 1);
  });

  it('без внедрённых часов используется Date.now', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0 + 1234);
    const { service } = setup({ enabled: false, withClock: false });
    const res = await service.getFeed(req);
    expect(parse(res.body).generated_at).toBe(new Date(T0 + 1234).toISOString());
  });
});

describe('FeedService: кеш ответа в Redis', () => {
  it('промах: лента считается из снимков и кладётся в Redis как expiresAt + \\n + тело с EX ttl', async () => {
    const { service, redis, db, entries } = setup();
    const before = await cacheCounter('miss');

    const res = await service.getFeed(req);

    expect(res.cache).toBe('miss');
    expect(res.ttlSec).toBe(60);
    // Отсутствие записи в кеше — штатная ситуация, в лог ничего не пишется.
    expect(entries()).toEqual([]);
    expect(parse(res.body)).toEqual({
      schema_version: FEED_SCHEMA_VERSION,
      generated_at: '2026-10-01T09:00:00.000Z',
      ttl_sec: 60,
      groups: [payload('g1')],
    });
    expect(db.calls).toEqual([
      {
        where: { state: 'published', endAt: { gt: new Date(T0) } },
        select: {
          groupId: true,
          version: true,
          placement: true,
          priority: true,
          startAt: true,
          endAt: true,
          platforms: true,
          minAppVersionIos: true,
          minAppVersionAndroid: true,
          segmentIds: true,
          payload: true,
        },
      },
    ]);
    // Ключ поколения отсутствует — используется поколение '0'.
    expect(redis.gets).toEqual([GEN, respKey('0')]);
    expect(redis.sets).toEqual([
      { key: respKey('0'), value: `${T0 + 60_000}\n${res.body}`, mode: 'EX', ttl: 60 },
    ]);
    expect(await cacheCounter('miss')).toBe(before + 1);
  });

  it('TTL ответа не дольше, чем до ближайшего start_at/end_at; даты из БД переводятся в мс', async () => {
    const { service, redis } = setup({
      rows: [
        row('ends-soon', { endAt: new Date(T0 + 10_500) }),
        row('starts-later', { startAt: new Date(T0 + 30_000) }),
      ],
    });

    const res = await service.getFeed(req);

    expect(groupIds(res.body)).toEqual(['ends-soon']);
    expect(res.ttlSec).toBe(11);
    expect(parse(res.body).ttl_sec).toBe(11);
    expect(redis.sets[0]).toMatchObject({ value: `${T0 + 11_000}\n${res.body}`, ttl: 11 });
  });

  it('платформы снимка из БД учитываются: группа видна только на своих платформах', async () => {
    const { service } = setup({
      rows: [
        row('ios-only', { platforms: ['ios'] }),
        row('android-only', { platforms: ['android'] }),
      ],
    });

    expect(groupIds((await service.getFeed(req)).body)).toEqual(['ios-only']);
    const android = await service.getFeed({ ...req, platform: 'android' });
    expect(groupIds(android.body)).toEqual(['android-only']);
    const web = await service.getFeed({ ...req, platform: 'web', appVersion: null });
    expect(groupIds(web.body)).toEqual([]);
  });

  it('ключ кеша: бакет версии и hash сегментов, никогда не сами сегменты', async () => {
    const { service, redis } = setup({
      rows: [row('ios6', { minAppVersionIos: '6.0.0' }), row('vip', { segmentIds: ['vip'] })],
    });

    const old = await service.getFeed(req);
    expect(groupIds(old.body)).toEqual([]);
    const seg = await service.getFeed({ ...req, appVersion: '6.1.0', userSegments: ['vip', 'b'] });
    expect(groupIds(seg.body).sort()).toEqual(['ios6', 'vip']);
    // Для web min_app_version не применяется.
    const web = await service.getFeed({ ...req, platform: 'web', appVersion: null });
    expect(groupIds(web.body)).toEqual(['ios6']);

    expect(redis.sets.map((s) => s.key)).toEqual([
      respKey('0', 'home:ios:v0of1:anon'),
      respKey('0', `home:ios:v1of1:s${segmentsHash(['b', 'vip'])}`),
      respKey('0', 'home:web:web:anon'),
    ]);
    for (const s of redis.sets) expect(s.key).not.toContain('vip');
  });

  it('попадание: отдаётся сохранённое тело и оставшийся TTL без пересчёта', async () => {
    const { service, redis, db, clock } = setup();
    const first = await service.getFeed(req);
    const before = await cacheCounter('hit');

    // Состав в БД поменялся, но поколение то же — ответ берётся из кеша.
    db.rows = [row('other')];
    clock.now = T0 + 20_500;
    const res = await service.getFeed(req);

    expect(res).toEqual({ body: first.body, ttlSec: 40, cache: 'hit' });
    expect(db.calls).toHaveLength(1);
    expect(redis.sets).toHaveLength(1);
    expect(await cacheCounter('hit')).toBe(before + 1);
  });

  it('попадание отдаёт тело из Redis как есть (без повторной сериализации)', async () => {
    const { service, redis, db } = setup();
    redis.store.set(respKey('0'), `${T0 + 30_000}\n{"cached":true}`);

    const res = await service.getFeed(req);

    expect(res).toEqual({ body: '{"cached":true}', ttlSec: 30, cache: 'hit' });
    expect(redis.sets).toEqual([]);
    // Набор снимков всё равно нужен для бакета версии.
    expect(db.calls).toHaveLength(1);
  });

  it('истёкшая запись (ttl < 1) пересчитывается и перезаписывается', async () => {
    const { service, redis } = setup();
    redis.store.set(respKey('0'), `${T0 - 1}\n{"stale":true}`);

    const res = await service.getFeed(req);

    expect(res.cache).toBe('miss');
    expect(groupIds(res.body)).toEqual(['g1']);
    expect(redis.store.get(respKey('0'))).toBe(`${T0 + 60_000}\n${res.body}`);
  });

  it('повреждённая запись (без разделителя, с пустым или нечисловым сроком, пустая) — промах и перезапись', async () => {
    const malformed = [
      // Без '\n' indexOf даёт -1, и срез «до разделителя» отрезал бы только последний символ:
      // срок получился бы корректным, поэтому решает именно проверка наличия разделителя.
      `${T0 + 30_000} `,
      `\n{"stale":true}`,
      '',
      'garbage\n{"x":1}',
    ];
    for (const cached of malformed) {
      const { service, redis, entries } = setup();
      redis.store.set(respKey('0'), cached);

      const res = await service.getFeed(req);

      expect(res.cache, JSON.stringify(cached)).toBe('miss');
      expect(groupIds(res.body)).toEqual(['g1']);
      expect(redis.sets).toHaveLength(1);
      expect(redis.store.get(respKey('0'))).toBe(`${T0 + 60_000}\n${res.body}`);
      // Повреждённая запись — обычный промах, а не ошибка Redis.
      expect(entries()).toEqual([]);
    }
  });

  it('ошибка чтения кеша ответа: лента всё равно отдаётся, в лог — предупреждение', async () => {
    const { service, redis, entries } = setup();
    redis.failGet = (key) => key !== GEN;

    const res = await service.getFeed(req);

    expect(res.cache).toBe('miss');
    expect(groupIds(res.body)).toEqual(['g1']);
    expect(redis.responseGets()).toEqual([respKey('0')]);
    const warn = entries().find((e) => e.msg === 'Кеш ленты недоступен');
    expect(warn).toMatchObject({
      level: 'warn',
      err: { message: 'redis get: connection refused' },
    });
  });

  it('ошибка записи кеша ответа не ломает запрос и логируется', async () => {
    const { service, redis, entries } = setup();
    redis.failSet = true;

    const res = await service.getFeed(req);

    expect(res.cache).toBe('miss');
    expect(groupIds(res.body)).toEqual(['g1']);
    expect(redis.store.has(respKey('0'))).toBe(false);
    await vi.waitFor(() =>
      expect(entries().find((e) => e.msg === 'Не удалось записать кеш ленты')).toMatchObject({
        level: 'warn',
        err: { message: 'redis set: connection refused' },
      }),
    );
  });
});

describe('FeedService: набор опубликованных снимков в памяти', () => {
  it('Redis недоступен: БД читается один раз, набор переиспользуется 5 с, затем перечитывается', async () => {
    const { service, redis, db, clock } = setup();
    redis.failGet = () => true;

    const first = await service.getFeed(req);
    expect(first.cache).toBe('miss');
    expect(groupIds(first.body)).toEqual(['g1']);
    expect(db.calls).toHaveLength(1);

    db.rows = [row('g2')];
    clock.now = T0 + 4_999;
    const second = await service.getFeed(req);
    expect(groupIds(second.body)).toEqual(['g1']);
    expect(db.calls).toHaveLength(1);

    clock.now = T0 + 5_000;
    const third = await service.getFeed(req);
    expect(groupIds(third.body)).toEqual(['g2']);
    expect(db.calls).toHaveLength(2);

    // Перечитанный набор запоминается, и 5 с отсчитываются заново от момента загрузки.
    db.rows = [];
    clock.now = T0 + 9_999;
    const fourth = await service.getFeed(req);
    expect(groupIds(fourth.body)).toEqual(['g2']);
    expect(db.calls).toHaveLength(2);

    // Без поколения ключ кеша не строится: ответы не читаются и не пишутся.
    expect(redis.responseGets()).toEqual([]);
    expect(redis.sets).toEqual([]);
  });

  it('Redis отказал после успешной загрузки: 5 с отдаётся набор из памяти, кеш ответа не трогается', async () => {
    const { service, redis, db, clock } = setup();
    await service.getFeed(req);
    expect(redis.sets).toHaveLength(1);

    redis.failGet = () => true;
    db.rows = [];
    clock.now = T0 + 1_000;
    const res = await service.getFeed(req);

    expect(res.cache).toBe('miss');
    expect(groupIds(res.body)).toEqual(['g1']);
    expect(db.calls).toHaveLength(1);
    // Без поколения ключ ответа не строится: второй запрос кеш ответа не читает и не пишет.
    expect(redis.responseGets()).toEqual([respKey('0')]);
    expect(redis.sets).toHaveLength(1);
  });

  it('смена поколения (bumpFeedGeneration) — перечитывание БД и новый ключ кеша', async () => {
    const { service, redis, db, clock, entries } = setup();
    await service.getFeed(req);
    expect(db.calls).toHaveLength(1);

    db.rows = [row('g2')];
    clock.now = T0 + 1_000;
    const { logger } = captureLogger();
    await bumpFeedGeneration(redis as unknown as Redis, keys, logger);
    const res = await service.getFeed(req);

    expect(res.cache).toBe('miss');
    expect(groupIds(res.body)).toEqual(['g2']);
    expect(db.calls).toHaveLength(2);
    expect(db.calls[1]).toMatchObject({ where: { endAt: { gt: new Date(T0 + 1_000) } } });
    expect(redis.sets.map((s) => s.key)).toEqual([respKey('0'), respKey('1')]);

    // Набор нового поколения запоминается: следующий запрос БД не читает.
    clock.now = T0 + 2_000;
    const again = await service.getFeed({ ...req, platform: 'android' });
    expect(groupIds(again.body)).toEqual(['g2']);
    expect(db.calls).toHaveLength(2);
    expect(entries()).toEqual([]);
  });

  it('набор снимков одного поколения живёт не дольше 60 с', async () => {
    const { service, redis, db, clock } = setup();
    redis.store.set(GEN, '7');
    await service.getFeed(req);

    db.rows = [row('g2')];
    clock.now = T0 + 59_999;
    const cached = await service.getFeed(req);
    expect(cached).toMatchObject({ cache: 'hit', ttlSec: 1 });
    expect(groupIds(cached.body)).toEqual(['g1']);
    expect(db.calls).toHaveLength(1);

    clock.now = T0 + 60_000;
    const res = await service.getFeed(req);
    expect(db.calls).toHaveLength(2);
    expect(res.cache).toBe('miss');
    expect(groupIds(res.body)).toEqual(['g2']);
    expect(redis.sets.map((s) => s.key)).toEqual([respKey('7'), respKey('7')]);
  });

  it('single-flight: параллельные запросы ждут одну загрузку из БД', async () => {
    const { service, db } = setup();
    const load = gate();
    db.findMany = async (args: unknown) => {
      db.calls.push(args);
      await load.opened;
      return db.rows;
    };

    const pending = [
      service.getFeed(req),
      service.getFeed(req),
      service.getFeed({ ...req, platform: 'android' }),
    ];
    // Все три запроса дошли до загрузки и ждут её.
    await flush();
    expect(db.calls).toHaveLength(1);
    load.open();

    const results = await Promise.all(pending);
    expect(db.calls).toHaveLength(1);
    for (const r of results) expect(groupIds(r.body)).toEqual(['g1']);
  });

  it('загрузка, начатая до смены поколения, не переиспользуется запросом нового поколения', async () => {
    const { service, redis, db, entries } = setup({ rows: [row('old')] });
    redis.store.set(GEN, '3');
    const firstLoad = gate();
    db.findMany = async (args: unknown) => {
      db.calls.push(args);
      // Запрос видит состояние БД на момент чтения.
      const rows = db.rows;
      if (db.calls.length === 1) await firstLoad.opened;
      return rows;
    };

    // A прочитал поколение 3 и медленно читает БД (ещё старый состав).
    const a = service.getFeed(req);
    await flush();
    expect(db.calls).toHaveLength(1);

    // Пока A читает, группу сняли и опубликовали другую: транзакция закоммичена, поколение 4.
    db.rows = [row('new')];
    await bumpFeedGeneration(redis as unknown as Redis, keys, captureLogger().logger);
    expect(redis.store.get(GEN)).toBe('4');

    // B с поколением 4 не присоединяется к загрузке A, а читает БД сам, не дожидаясь A.
    const pendingB = service.getFeed(req);
    await flush();
    expect(db.calls).toHaveLength(2);
    const b = await pendingB;
    expect(b.cache).toBe('miss');
    expect(groupIds(b.body)).toEqual(['new']);
    const gen4Entry = `${T0 + 60_000}\n${b.body}`;
    expect(redis.store.get(respKey('4'))).toBe(gen4Entry);

    // A завершается со старым составом и пишет только под своим поколением.
    firstLoad.open();
    const resA = await a;
    expect(groupIds(resA.body)).toEqual(['old']);
    expect(redis.store.get(respKey('3'))).toBe(`${T0 + 60_000}\n${resA.body}`);
    expect(redis.store.get(respKey('4'))).toBe(gen4Entry);

    // Следующие запросы поколения 4 получают только новый состав.
    const c = await service.getFeed(req);
    expect(c).toEqual({ body: b.body, ttlSec: 60, cache: 'hit' });
    expect(entries()).toEqual([]);
  });

  it('старая загрузка, завершившаяся раньше новой, не отменяет single-flight нового поколения', async () => {
    const { service, redis, db } = setup({ rows: [row('old')] });
    redis.store.set(GEN, '3');
    const loads = [gate(), gate()];
    db.findMany = async (args: unknown) => {
      const n = db.calls.push(args);
      const rows = db.rows;
      await loads[n - 1]?.opened;
      return rows;
    };

    const a = service.getFeed(req);
    await flush();
    db.rows = [row('new')];
    redis.store.set(GEN, '4');
    const b = service.getFeed(req);
    await flush();
    expect(db.calls).toHaveLength(2);

    // Загрузка поколения 3 завершается, пока загрузка поколения 4 ещё идёт.
    loads[0]?.open();
    expect(groupIds((await a).body)).toEqual(['old']);

    // C того же поколения, что и B, присоединяется к загрузке B, а не начинает третью.
    const c = service.getFeed({ ...req, platform: 'android' });
    await flush();
    expect(db.calls).toHaveLength(2);
    loads[1]?.open();

    const [resB, resC] = await Promise.all([b, c]);
    expect(groupIds(resB.body)).toEqual(['new']);
    expect(groupIds(resC.body)).toEqual(['new']);
    expect(db.calls).toHaveLength(2);
  });

  it('ошибка БД не залипает: запрос падает, следующий загружает набор заново', async () => {
    const { service, db } = setup();
    const ok = db.findMany;
    db.findMany = (args: unknown) => {
      db.calls.push(args);
      return Promise.reject(new Error('db down'));
    };

    await expect(service.getFeed(req)).rejects.toThrow('db down');

    db.findMany = ok;
    const res = await service.getFeed(req);
    expect(groupIds(res.body)).toEqual(['g1']);
    expect(db.calls).toHaveLength(2);
  });
});

describe('bumpFeedGeneration', () => {
  it('увеличивает поколение ключей кеша', async () => {
    const redis = new FakeRedis();
    const { logger, entries } = captureLogger();

    await bumpFeedGeneration(redis as unknown as Redis, keys, logger);
    expect(redis.store.get(GEN)).toBe('1');
    await bumpFeedGeneration(redis as unknown as Redis, keys, logger);
    expect(redis.store.get(GEN)).toBe('2');
    expect(entries()).toEqual([]);
  });

  it('Redis недоступен: ошибка логируется, исключение не выбрасывается', async () => {
    const redis = new FakeRedis();
    redis.failIncr = true;
    const { logger, entries } = captureLogger();

    await expect(
      bumpFeedGeneration(redis as unknown as Redis, keys, logger),
    ).resolves.toBeUndefined();

    expect(redis.store.has(GEN)).toBe(false);
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({
      level: 'error',
      msg: 'Не удалось сбросить кеш ленты в Redis',
      err: { message: 'redis incr: connection refused' },
    });
  });
});

describe('segmentsHash и emptyFeed', () => {
  it('hash сегментов не зависит от порядка и повторов', () => {
    const h = segmentsHash(['b', 'a', 'c']);
    expect(h).toMatch(/^[0-9a-f]{32}$/);
    expect(segmentsHash(['c', 'b', 'a'])).toBe(h);
    expect(segmentsHash(['a', 'a', 'b', 'c', 'c'])).toBe(h);
    expect(segmentsHash(['a', 'b'])).not.toBe(h);
    expect(segmentsHash([])).toMatch(/^[0-9a-f]{32}$/);
    expect(segmentsHash([])).not.toBe(h);
  });

  it('hash сегментов не склеивает ID, содержащие разделитель', () => {
    expect(segmentsHash(['a\nb'])).not.toBe(segmentsHash(['a', 'b']));
    expect(segmentsHash(['a,b'])).not.toBe(segmentsHash(['a', 'b']));
    expect(segmentsHash(['a', 'b\nc'])).not.toBe(segmentsHash(['a\nb', 'c']));
    expect(segmentsHash([''])).not.toBe(segmentsHash([]));
  });

  it('пустая лента: TTL по умолчанию — максимум, можно задать свой', () => {
    expect(parse(emptyFeed(T0))).toEqual({
      schema_version: FEED_SCHEMA_VERSION,
      generated_at: '2026-10-01T09:00:00.000Z',
      ttl_sec: LIMITS.feedTtlMaxSec,
      groups: [],
    });
    expect(parse(emptyFeed(T0, 5)).ttl_sec).toBe(5);
  });
});
