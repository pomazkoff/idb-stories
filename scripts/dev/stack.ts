/**
 * Локальный стенд без Docker: `pnpm dev:local`.
 * Поднимает embedded PostgreSQL 16, Redis (redis-memory-server), S3-эмулятор, применяет миграции,
 * права ролей, seed и настройку бакетов, затем запускает API (public :8080, admin :8081), фоновые задачи,
 * медиа-воркер (ffmpeg из npm) и админку (Vite :5173). Основной способ по ТЗ — `docker compose up`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createPrismaClient } from '@idb-stories/db';
import { startS3Emulator } from './s3-emulator.js';

const root = path.resolve(import.meta.dirname, '../..');
const cache = path.join(root, '.cache', 'dev');
const require = createRequire(path.join(root, 'apps/worker/package.json'));
const bin = (p: string) => path.join(root, p);

const PG_PORT = Number(process.env.DEV_PG_PORT ?? 5433);
const REDIS_PORT = Number(process.env.DEV_REDIS_PORT ?? 6380);
const S3_PORT = Number(process.env.DEV_S3_PORT ?? 9000);
const ADMIN_ORIGIN = 'http://localhost:5173';

const secrets = {
  owner: 'dev-owner-password',
  app: 'dev-app-password',
  s3Key: 'dev-s3-access-key',
  s3Secret: 'dev-s3-secret-key-change-me',
};

const children: ChildProcess[] = [];
const stops: (() => Promise<unknown>)[] = [];

function run(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  name: string,
  wait = false,
): Promise<void> {
  const child = spawn(cmd, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = `[${name}]`.padEnd(9);
  const out = (data: Buffer) => {
    for (const line of data.toString().split('\n'))
      if (line.trim()) console.log(`${prefix} ${line}`);
  };
  child.stdout.on('data', out);
  child.stderr.on('data', out);
  if (!wait) {
    children.push(child);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) =>
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${name}: код ${code}`)),
    ),
  );
}

async function main() {
  await mkdir(cache, { recursive: true });

  // --- PostgreSQL -----------------------------------------------------------
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const pgDir = path.join(cache, 'pg');
  const pg = new EmbeddedPostgres({
    databaseDir: pgDir,
    user: 'postgres',
    password: 'postgres',
    port: PG_PORT,
    persistent: true,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {},
  });
  try {
    await pg.initialise();
  } catch {
    // уже инициализирован
  }
  await pg.start();
  stops.push(() => pg.stop());
  const admin = createPrismaClient(`postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/postgres`, {
    log: 'none',
  });
  for (const [role, pw] of [
    ['stories_owner', secrets.owner],
    ['stories_app', secrets.app],
  ] as const) {
    await admin.$executeRawUnsafe(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN CREATE ROLE ${role} LOGIN PASSWORD '${pw}'; END IF; END $$`,
    );
  }
  const exists = await admin.$queryRawUnsafe<unknown[]>(
    "SELECT 1 FROM pg_database WHERE datname='stories'",
  );
  if (exists.length === 0)
    await admin.$executeRawUnsafe('CREATE DATABASE stories OWNER stories_owner');
  await admin.$disconnect();
  console.log(`[dev]     PostgreSQL :${PG_PORT}`);

  // --- Redis ----------------------------------------------------------------
  // Бинарник Redis собирает/кеширует redis-memory-server при установке; запускаем его напрямую.
  const { RedisBinary } = await import('redis-memory-server');
  const redisPath = await RedisBinary.getPath();
  const redis = spawn(
    redisPath,
    ['--port', String(REDIS_PORT), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'],
    {
      stdio: 'ignore',
    },
  );
  stops.push(() => Promise.resolve(redis.kill('SIGTERM')));
  await new Promise((r) => setTimeout(r, 300));
  console.log(`[dev]     Redis :${REDIS_PORT}`);

  // --- S3 -------------------------------------------------------------------
  const s3 = await startS3Emulator({
    port: S3_PORT,
    dataDir: path.join(cache, 's3'),
    accessKeyId: secrets.s3Key,
    secretAccessKey: secrets.s3Secret,
    log: (m) => console.log(`[s3]      ${m}`),
  });
  stops.push(() => s3.close());

  const common: NodeJS.ProcessEnv = {
    NODE_ENV: 'development',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
    REDIS_URL: `redis://127.0.0.1:${REDIS_PORT}`,
    REDIS_PREFIX: 'stories:',
    S3_ENDPOINT: `http://localhost:${S3_PORT}`,
    S3_PUBLIC_ENDPOINT: `http://localhost:${S3_PORT}`,
    S3_ACCESS_KEY_ID: secrets.s3Key,
    S3_SECRET_ACCESS_KEY: secrets.s3Secret,
    CDN_BASE_URL: `http://localhost:${S3_PORT}/stories-public`,
    ADMIN_ORIGIN,
  };
  const ownerUrl = `postgresql://stories_owner:${secrets.owner}@127.0.0.1:${PG_PORT}/stories`;
  const appUrl = `postgresql://stories_app:${secrets.app}@127.0.0.1:${PG_PORT}/stories`;

  // --- Миграции, права, seed, бакеты -----------------------------------------
  const tsx = bin('node_modules/.bin/tsx');
  await run(
    bin('packages/db/node_modules/.bin/prisma'),
    ['migrate', 'deploy', '--schema', 'packages/db/prisma/schema.prisma'],
    { DATABASE_URL: ownerUrl },
    'migrate',
    true,
  );
  await run(
    tsx,
    ['--conditions=@idb-stories/source', 'packages/db/src/scripts/apply-grants.ts'],
    { DATABASE_URL: ownerUrl, DB_APP_ROLE: 'stories_app' },
    'grants',
    true,
  );
  await run(
    tsx,
    ['--conditions=@idb-stories/source', 'packages/db/src/scripts/seed.ts'],
    { DATABASE_URL: ownerUrl },
    'seed',
    true,
  );
  await run(
    tsx,
    ['--conditions=@idb-stories/source', 'apps/api/src/scripts/storage-init.ts'],
    common,
    'storage',
    true,
  );

  // --- Сервисы --------------------------------------------------------------
  await run(
    tsx,
    ['watch', '--conditions=@idb-stories/source', 'apps/api/src/server.ts'],
    {
      ...common,
      DATABASE_URL: appUrl,
      ADMIN_COOKIE_SECURE: 'false',
      PUBLIC_CORS_ORIGINS: ADMIN_ORIGIN,
      SEGMENTS_CACHE_SALT: 'dev-segments-salt-0123456789',
      CUSTOMER_AUTH_PROVIDER: 'mock',
      CUSTOMER_AUTH_MOCK_SECRET: 'dev-customer-token-secret-0123456789ab',
      TRUST_PROXY: 'true',
    },
    'api',
  );
  await run(
    tsx,
    ['watch', '--conditions=@idb-stories/source', 'apps/worker/src/jobs/main.ts'],
    { ...common, DATABASE_URL: appUrl, METRICS_PORT: '9465' },
    'jobs',
  );
  await run(
    tsx,
    ['watch', '--conditions=@idb-stories/source', 'apps/worker/src/media/main.ts'],
    {
      ...common,
      FFMPEG_PATH: require('ffmpeg-static') as string,
      FFPROBE_PATH: (require('ffprobe-static') as { path: string }).path,
      MEDIA_TMP_DIR: path.join(cache, 'tmp'),
      METRICS_PORT: '9466',
    },
    'media',
  );
  await mkdir(path.join(cache, 'tmp'), { recursive: true });
  if (process.env.DEV_NO_ADMIN !== '1') {
    await run(
      bin('apps/admin/node_modules/.bin/vite'),
      ['--port', '5173', '--strictPort'],
      {},
      'admin',
    );
  }

  console.log(`
[dev]     Готово:
          Админка        ${ADMIN_ORIGIN}   (вход через mock SSO)
          Публичный API  http://localhost:8080/v1/feed?placement=home  (заголовок X-Platform: web)
          Admin API      http://localhost:8081/admin/v1
          S3 / «CDN»     http://localhost:${S3_PORT}
          Ctrl+C — остановить`);
}

async function shutdown() {
  for (const c of children) c.kill('SIGTERM');
  for (const stop of stops.reverse()) await stop().catch(() => undefined);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

main().catch(async (err: unknown) => {
  console.error(err);
  await shutdown();
});
