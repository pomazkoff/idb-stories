import { Queue } from 'bullmq';
import {
  MockSsoAdapter,
  S3ObjectStorage,
  createAdapters,
  type Adapters,
  type ObjectStorage,
} from '@idb-stories/adapters';
import {
  FeedService,
  QUEUES,
  SecurityLog,
  SettingsService,
  createLogger,
  createRedis,
  redisKeys,
  type Logger,
  type PublishingDeps,
  type Redis,
  type RedisKeys,
} from '@idb-stories/core';
import { createPrismaClient, type PrismaClient } from '@idb-stories/db';
import type { Config } from './config.js';

export interface AppDeps {
  config: Config;
  logger: Logger;
  prisma: PrismaClient;
  /** Кеш: быстрый отказ при недоступности Redis. */
  redis: Redis;
  /** Сессии админки и защита от повторов: обычные ретраи. */
  sessionRedis: Redis;
  queueRedis: Redis;
  keys: RedisKeys;
  queues: { mediaProcess: Queue; eventsIngest: Queue };
  storage: ObjectStorage;
  adapters: Adapters;
  sso: MockSsoAdapter;
  settings: SettingsService;
  feed: FeedService;
  security: SecurityLog;
  publishing: PublishingDeps;
  now: () => Date;
  close(): Promise<void>;
}

export type DepsOverrides = Partial<
  Pick<AppDeps, 'storage' | 'adapters' | 'logger' | 'now' | 'sso'>
>;

export function createDeps(config: Config, overrides: DepsOverrides = {}): AppDeps {
  const logger = overrides.logger ?? createLogger({ name: 'stories-api', level: config.logLevel });
  const now = overrides.now ?? (() => new Date());
  const prisma = createPrismaClient(config.databaseUrl);
  const onRedisError = (err: Error) => logger.error({ err }, 'Redis недоступен');
  const redis = createRedis(config.redisUrl, 'cache', onRedisError);
  const sessionRedis = createRedis(config.redisUrl, 'queue', onRedisError);
  const queueRedis = createRedis(config.redisUrl, 'queue', onRedisError);
  const keys = redisKeys(config.redisPrefix);
  const queueOpts = {
    connection: queueRedis,
    prefix: keys.bullPrefix,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  };
  const queues = {
    mediaProcess: new Queue(QUEUES.mediaProcess, {
      ...queueOpts,
      defaultJobOptions: { ...queueOpts.defaultJobOptions, attempts: 2 },
    }),
    eventsIngest: new Queue(QUEUES.eventsIngest, queueOpts),
  };
  const storage =
    overrides.storage ??
    new S3ObjectStorage({
      endpoint: config.s3.endpoint,
      ...(config.s3.publicEndpoint ? { publicEndpoint: config.s3.publicEndpoint } : {}),
      region: config.s3.region,
      accessKeyId: config.s3.accessKeyId,
      secretAccessKey: config.s3.secretAccessKey,
      forcePathStyle: config.s3.forcePathStyle,
    });
  const adapters =
    overrides.adapters ??
    createAdapters({
      env: config.env,
      customerAuth: config.customerAuth,
      segments: { provider: 'mock' },
      catalog: { provider: 'mock' },
      analytics: { provider: 'mock' },
      cdnPurge: { provider: 'mock' },
      siem: { provider: 'mock' },
    });
  const sso =
    overrides.sso ??
    new MockSsoAdapter({
      authorizeUrl: `${config.admin.origin}/admin/v1/dev/mock-idp/authorize`,
      ...(config.admin.sso.mockSecret ? { secret: config.admin.sso.mockSecret } : {}),
    });
  const settings = new SettingsService(prisma, redis, keys, logger);
  const security = new SecurityLog(logger, adapters.siem);
  const feed = new FeedService({
    prisma,
    redis,
    keys,
    settings,
    logger,
    now: () => now().getTime(),
  });
  const publishing: PublishingDeps = {
    prisma,
    storage,
    buckets: { media: config.s3.buckets.media, public: config.s3.buckets.public },
    redis,
    keys,
    cdnPurge: adapters.cdnPurge,
    security,
    logger,
  };

  return {
    config,
    logger,
    prisma,
    redis,
    sessionRedis,
    queueRedis,
    keys,
    queues,
    storage,
    adapters,
    sso,
    settings,
    feed,
    security,
    publishing,
    now,
    async close() {
      await Promise.allSettled([queues.mediaProcess.close(), queues.eventsIngest.close()]);
      await Promise.allSettled([
        prisma.$disconnect(),
        redis.quit(),
        sessionRedis.quit(),
        queueRedis.quit(),
      ]);
    },
  };
}
