/**
 * Глобальная подготовка интеграционных тестов: реальные PostgreSQL 16 и Redis.
 *
 * - В CI (и в docker compose-профиле test) адреса передаются через TEST_PG_ADMIN_URL и TEST_REDIS_URL.
 * - Локально без Docker поднимаются embedded-postgres и redis-memory-server из npm.
 *
 * Схема мигрируется один раз в шаблонную БД владельцем (как в проде), затем каждому тестовому
 * файлу создаётся своя БД из шаблона. Приложение в тестах ходит в БД ролью stories_app —
 * с теми же урезанными правами, что и в проде (append-only аудит проверяется по-настоящему).
 */
import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import type { TestProject } from 'vitest/node';
import { PG_ROLES, adminUrl, databaseUrl, type PgConnection } from './pg.js';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() =>
        typeof addr === 'object' && addr ? resolve(addr.port) : reject(new Error('port')),
      );
    });
  });
}

export default async function setup(project: TestProject) {
  const teardown: (() => Promise<void>)[] = [];

  // --- PostgreSQL -----------------------------------------------------------
  let pg: PgConnection;
  if (process.env.TEST_PG_ADMIN_URL) {
    const u = new URL(process.env.TEST_PG_ADMIN_URL);
    pg = {
      host: u.hostname,
      port: Number(u.port || 5432),
      adminUser: decodeURIComponent(u.username),
      adminPassword: decodeURIComponent(u.password),
      template: `stories_template_${process.pid}`,
    };
  } else {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    const port = await freePort();
    const dir = path.join(root, '.cache', 'pg-test', `${process.pid}`);
    await rm(dir, { recursive: true, force: true });
    await mkdir(path.dirname(dir), { recursive: true });
    const server = new EmbeddedPostgres({
      databaseDir: dir,
      user: 'postgres',
      password: 'postgres',
      port,
      persistent: false,
      // Как в проде: UTF8, иначе char_length и varchar считают байты кириллицы.
      initdbFlags: ['--encoding=UTF8', '--locale=C'],
      onLog: () => {},
    });
    await server.initialise();
    await server.start();
    teardown.push(async () => {
      await server.stop();
      await rm(dir, { recursive: true, force: true });
    });
    pg = {
      host: '127.0.0.1',
      port,
      adminUser: 'postgres',
      adminPassword: 'postgres',
      template: 'stories_template',
    };
  }

  const { createPrismaClient, applyGrants, seedReferenceData } = await import('@idb-stories/db');
  const admin = createPrismaClient(adminUrl(pg, 'postgres'));
  try {
    for (const role of [PG_ROLES.owner, PG_ROLES.app]) {
      await admin.$executeRawUnsafe(
        `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role.user}') THEN
           CREATE ROLE ${role.user} LOGIN PASSWORD '${role.password}'; END IF; END $$`,
      );
    }
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${pg.template}`);
    await admin.$executeRawUnsafe(`CREATE DATABASE ${pg.template} OWNER ${PG_ROLES.owner.user}`);
  } finally {
    await admin.$disconnect();
  }
  teardown.push(async () => {
    const a = createPrismaClient(adminUrl(pg, 'postgres'));
    await a
      .$executeRawUnsafe(`DROP DATABASE IF EXISTS ${pg.template} WITH (FORCE)`)
      .catch(() => {});
    await a.$disconnect();
  });

  const ownerUrl = databaseUrl(pg, pg.template, PG_ROLES.owner);
  await exec(
    path.join(root, 'packages/db/node_modules/.bin/prisma'),
    ['migrate', 'deploy', '--schema', path.join(root, 'packages/db/prisma/schema.prisma')],
    { env: { ...process.env, DATABASE_URL: ownerUrl } },
  );
  const owner = createPrismaClient(ownerUrl);
  try {
    await applyGrants(owner, PG_ROLES.app.user);
    await seedReferenceData(owner);
  } finally {
    await owner.$disconnect();
  }
  project.provide('pg', pg);

  // --- Redis ----------------------------------------------------------------
  if (process.env.TEST_REDIS_URL) {
    project.provide('redisUrl', process.env.TEST_REDIS_URL);
  } else {
    const { RedisMemoryServer } = await import('redis-memory-server');
    const redis = await RedisMemoryServer.create();
    teardown.push(() => redis.stop().then(() => undefined));
    project.provide('redisUrl', `redis://${await redis.getHost()}:${await redis.getPort()}`);
  }

  return async () => {
    for (const fn of teardown.reverse()) await fn();
  };
}
