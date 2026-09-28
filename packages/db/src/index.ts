import { PrismaClient } from '../generated/client/index.js';

export { Prisma, PrismaClient } from '../generated/client/index.js';
export type * from '../generated/client/index.js';
export { applyGrants, assertSqlIdentifier } from './grants.js';
export { seedReferenceData, seedDevUsers, DEFAULT_ALLOWLIST, SETTING_KEYS } from './seed-data.js';

export function createPrismaClient(
  url: string,
  opts: { log?: 'errors' | 'none' | 'verbose' } = {},
): PrismaClient {
  const log = opts.log ?? (process.env.PRISMA_LOG as 'none' | undefined) ?? 'errors';
  return new PrismaClient({
    datasources: { db: { url } },
    log: log === 'none' ? [] : log === 'verbose' ? ['warn', 'error'] : ['error'],
  });
}
