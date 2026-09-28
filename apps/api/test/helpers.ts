import { Writable } from 'node:stream';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import {
  MemoryObjectStorage,
  MockAnalyticsAdapter,
  MockCatalogAdapter,
  MockCdnPurgeAdapter,
  MockCustomerAuthAdapter,
  MockSegmentsAdapter,
  MockSiemAdapter,
  type Adapters,
} from '@idb-stories/adapters';
import { createLogger, type MediaVariants } from '@idb-stories/core';
import { seedDevUsers } from '@idb-stories/db';
import {
  createTestDatabase,
  testRedisPrefix,
  testRedisUrl,
  type TestDatabase,
} from '@testkit/db.js';
import { createAdminApp } from '../src/app-admin.js';
import { createPublicApp } from '../src/app-public.js';
import type { SessionStore } from '../src/auth/session.js';
import { loadConfig, type Config } from '../src/config.js';
import { createDeps, type AppDeps } from '../src/context.js';

export const ADMIN_ORIGIN = 'https://admin.stories.test';
export const CDN = 'https://cdn.stories.test';
export const CUSTOMER_SECRET = 'test-customer-secret-0123456789abcdef';

export function testEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgresql://unused',
    REDIS_URL: testRedisUrl(),
    REDIS_PREFIX: testRedisPrefix(),
    CDN_BASE_URL: CDN,
    SEGMENTS_CACHE_SALT: 'test-salt-0123456789abcdef',
    ADMIN_ORIGIN,
    S3_ENDPOINT: 'http://s3.test',
    S3_ACCESS_KEY_ID: 'test',
    S3_SECRET_ACCESS_KEY: 'test',
    PUBLIC_CORS_ORIGINS: 'https://www.iledebeaute.test',
    CUSTOMER_AUTH_PROVIDER: 'mock',
    CUSTOMER_AUTH_MOCK_SECRET: CUSTOMER_SECRET,
    FEED_RATE_LIMIT_PER_MIN: '10000',
    EVENTS_RATE_LIMIT_PER_MIN: '10000',
    ...overrides,
  };
}

export interface TestAdapters extends Adapters {
  customerAuth: MockCustomerAuthAdapter;
  segments: MockSegmentsAdapter;
  catalog: MockCatalogAdapter;
  analytics: MockAnalyticsAdapter;
  cdnPurge: MockCdnPurgeAdapter;
  siem: MockSiemAdapter;
}

export interface Session {
  userId: string;
  subject: string;
  cookie: string;
  csrf: string;
}

export interface TestApi {
  db: TestDatabase;
  config: Config;
  deps: AppDeps;
  publicApp: FastifyInstance;
  adminApp: FastifyInstance;
  sessions: SessionStore;
  storage: MemoryObjectStorage;
  adapters: TestAdapters;
  logs: string[];
  /** Текущее время для сервиса (можно двигать в тестах). */
  clock: { now: Date };
  login(subject: string): Promise<Session>;
  admin(
    session: Session | null,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<LightMyRequestResponse>;
  userId(subject: string): Promise<string>;
  close(): Promise<void>;
}

export async function createTestApi(envOverrides: Record<string, string> = {}): Promise<TestApi> {
  const db = await createTestDatabase();
  await seedDevUsers(db.owner);
  const config = loadConfig(testEnv({ ...envOverrides, DATABASE_URL: db.appUrl }));
  const logs: string[] = [];
  const logger = createLogger({
    name: 'test',
    level: 'info',
    destination: new Writable({
      write(chunk: Buffer, _enc, cb) {
        logs.push(chunk.toString());
        cb();
      },
    }),
  });
  const storage = new MemoryObjectStorage('http://s3.test');
  const adapters: TestAdapters = {
    customerAuth: new MockCustomerAuthAdapter({
      secret: CUSTOMER_SECRET,
      issuer: config.customerAuth.provider === 'mock' ? config.customerAuth.issuer : '',
      audience: config.customerAuth.provider === 'mock' ? config.customerAuth.audience : '',
    }),
    segments: new MockSegmentsAdapter(),
    catalog: new MockCatalogAdapter(),
    analytics: new MockAnalyticsAdapter(),
    cdnPurge: new MockCdnPurgeAdapter(),
    siem: new MockSiemAdapter(),
  };
  const clock = { now: new Date() };
  const deps = createDeps(config, { storage, adapters, logger, now: () => new Date(clock.now) });
  const publicApp = await createPublicApp(deps);
  const { app: adminApp, sessions } = await createAdminApp(deps);
  await Promise.all([publicApp.ready(), adminApp.ready()]);
  // Кеш-соединение Redis без offline-очереди: ждём готовности, чтобы тесты были детерминированными.
  for (let i = 0; i < 50 && deps.redis.status !== 'ready' && !envOverrides.REDIS_URL; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }

  const cookieHeader = (res: LightMyRequestResponse) =>
    res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

  const api: TestApi = {
    db,
    config,
    deps,
    publicApp,
    adminApp,
    sessions,
    storage,
    adapters,
    logs,
    clock,
    async login(subject) {
      // Полный путь входа: /auth/login → mock-IdP → /auth/callback (state, nonce, cookie).
      const start = await adminApp.inject({ method: 'GET', url: '/admin/v1/auth/login' });
      const authorize = new URL(start.headers.location as string);
      const idp = await adminApp.inject({
        method: 'POST',
        url: '/admin/v1/dev/mock-idp/authorize',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          subject,
          state: authorize.searchParams.get('state') ?? '',
          nonce: authorize.searchParams.get('nonce') ?? '',
        }).toString(),
      });
      const callback = new URL(idp.headers.location as string);
      const done = await adminApp.inject({
        method: 'GET',
        url: `${callback.pathname}${callback.search}`,
        headers: { cookie: cookieHeader(start) },
      });
      const sessionCookie = done.cookies.find((c) => c.name.endsWith('stories_sid'));
      if (!sessionCookie)
        throw new Error(`Вход не удался: ${done.statusCode} ${String(done.headers.location)}`);
      const cookie = `${sessionCookie.name}=${sessionCookie.value}`;
      const me = await adminApp.inject({
        method: 'GET',
        url: '/admin/v1/auth/me',
        headers: { cookie },
      });
      const body = me.json<{ csrfToken: string; user: { id: string } }>();
      return { userId: body.user.id, subject, cookie, csrf: body.csrfToken };
    },
    admin(session, method, url, body, extraHeaders = {}) {
      return adminApp.inject({
        method,
        url,
        headers: {
          ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...extraHeaders,
        },
        ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
      });
    },
    async userId(subject) {
      const u = await db.owner.adminUser.findUniqueOrThrow({ where: { subject } });
      return u.id;
    },
    async close() {
      await Promise.allSettled([publicApp.close(), adminApp.close()]);
      await deps.close();
      await db.drop();
    },
  };
  return api;
}

/** Готовое медиа (как после воркера) — чтобы тестировать публикацию без реального транскодинга. */
export async function createReadyAsset(
  api: TestApi,
  opts: { kind: 'image' | 'video'; purpose: 'slide' | 'cover'; uploadedBy: string },
): Promise<string> {
  const key = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const file = (name: string, mime: 'image/webp' | 'image/jpeg' | 'video/mp4') => ({
    key: `${key}/${name}`,
    size: 100,
    mime,
  });
  const variants: MediaVariants =
    opts.kind === 'video'
      ? {
          images: [],
          videos: [
            {
              name: '1080p',
              w: 1080,
              h: 1920,
              bitrateKbps: 2500,
              file: file('1080p.mp4', 'video/mp4'),
            },
            {
              name: '720p',
              w: 720,
              h: 1280,
              bitrateKbps: 1200,
              file: file('720p.mp4', 'video/mp4'),
            },
          ],
          poster: {
            name: 'poster',
            w: 1080,
            h: 1920,
            files: [file('poster.webp', 'image/webp'), file('poster.jpg', 'image/jpeg')],
          },
        }
      : {
          images:
            opts.purpose === 'cover'
              ? [
                  {
                    name: '256x256',
                    w: 256,
                    h: 256,
                    files: [file('256x256.webp', 'image/webp'), file('256x256.jpg', 'image/jpeg')],
                  },
                ]
              : [
                  {
                    name: '1080x1920',
                    w: 1080,
                    h: 1920,
                    files: [
                      file('1080x1920.webp', 'image/webp'),
                      file('1080x1920.jpg', 'image/jpeg'),
                    ],
                  },
                  {
                    name: '720x1280',
                    w: 720,
                    h: 1280,
                    files: [
                      file('720x1280.webp', 'image/webp'),
                      file('720x1280.jpg', 'image/jpeg'),
                    ],
                  },
                ],
          videos: [],
          poster: null,
        };
  for (const f of [
    ...variants.images.flatMap((i) => i.files),
    ...variants.videos.map((v) => v.file),
    ...(variants.poster?.files ?? []),
  ]) {
    await api.storage.put(api.config.s3.buckets.media, f.key, Buffer.from('x'), {
      contentType: f.mime,
    });
  }
  const asset = await api.db.owner.mediaAsset.create({
    data: {
      kind: opts.kind,
      purpose: opts.purpose,
      status: 'ready',
      declaredContentType: opts.kind === 'video' ? 'video/mp4' : 'image/jpeg',
      declaredSize: 1000,
      originalKey: `uploads/${key}`,
      storageKey: key,
      variants,
      width: 1080,
      height: 1920,
      durationMs: opts.kind === 'video' ? 12_000 : null,
      uploadedById: opts.uploadedBy,
      sha256: '0'.repeat(64),
      size: 1000,
    },
  });
  return asset.id;
}

export function groupInput(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    title: 'Новинки осени',
    placement: 'home',
    priority: 10,
    startAt: new Date(now - 3600_000).toISOString(),
    endAt: new Date(now + 7 * 24 * 3600_000).toISOString(),
    platforms: ['ios', 'android', 'web'],
    ...overrides,
  };
}
