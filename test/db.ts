import { randomBytes } from 'node:crypto';
import { inject } from 'vitest';
import { createPrismaClient, type PrismaClient } from '@idb-stories/db';
import { PG_ROLES, adminUrl, databaseUrl } from './pg.js';

export interface TestDatabase {
  name: string;
  /** Подключение ролью приложения (как в проде). */
  appUrl: string;
  /** Подключение владельцем схемы (для проверок прав и подготовки данных в обход API). */
  ownerUrl: string;
  app: PrismaClient;
  owner: PrismaClient;
  drop(): Promise<void>;
}

/** Отдельная БД для тестового файла, копия мигрированного шаблона. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const pg = inject('pg');
  const name = `t_${randomBytes(6).toString('hex')}`;
  const admin = createPrismaClient(adminUrl(pg, 'postgres'));
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await admin.$executeRawUnsafe(
          `CREATE DATABASE ${name} TEMPLATE ${pg.template} OWNER ${PG_ROLES.owner.user}`,
        );
        break;
      } catch (err) {
        // Шаблон нельзя копировать параллельно из нескольких сессий — повторяем.
        if (attempt > 20 || !String(err).includes('being accessed by other users')) throw err;
        await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
      }
    }
  } finally {
    await admin.$disconnect();
  }
  const appUrl = databaseUrl(pg, name, PG_ROLES.app);
  const ownerUrl = databaseUrl(pg, name, PG_ROLES.owner);
  const app = createPrismaClient(appUrl, { log: 'none' });
  const owner = createPrismaClient(ownerUrl, { log: 'none' });
  return {
    name,
    appUrl,
    ownerUrl,
    app,
    owner,
    async drop() {
      await app.$disconnect();
      await owner.$disconnect();
      const a = createPrismaClient(adminUrl(pg, 'postgres'));
      await a.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.$disconnect();
    },
  };
}

export function testRedisUrl(): string {
  return inject('redisUrl');
}

/** Уникальный префикс ключей Redis для изоляции тестовых файлов. */
export function testRedisPrefix(): string {
  return `t${randomBytes(4).toString('hex')}:`;
}
