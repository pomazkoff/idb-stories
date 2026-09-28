import { Queue, Worker, type Job } from 'bullmq';
import { S3ObjectStorage, createAdapters, withTimeout } from '@idb-stories/adapters';
import {
  QUEUES,
  SYSTEM_CONTEXT,
  SecurityLog,
  adapterErrorsTotal,
  createLogger,
  createRedis,
  redisKeys,
  runSchedulerTick,
  type AnalyticsForwardJob,
  type EventsIngestJob,
  type MaintenanceJob,
  type PublishingDeps,
} from '@idb-stories/core';
import { createPrismaClient } from '@idb-stories/db';
import { loadJobsConfig } from '../config.js';
import { startMetricsServer } from '../metrics.js';
import { ingestEvents } from './events-ingest.js';
import { applyMediaResult } from './media-results.js';
import { runRetention } from './retention.js';
import { syncSegments } from './segments-sync.js';

/**
 * Фоновые задачи: публикация по start_at и архивирование по end_at, результаты медиа-воркера,
 * события (сырые + агрегаты + аналитика ИДБ с ретраями), ретеншн, синхронизация сегментов.
 * Периодические задачи — через планировщик BullMQ: при нескольких инстансах тик выполняется один раз.
 */
const config = loadJobsConfig();
const logger = createLogger({ name: 'stories-jobs', level: config.logLevel });
const keys = redisKeys(config.redisPrefix);
const onRedisError = (err: Error) => logger.error({ err }, 'Redis недоступен');
const connection = createRedis(config.redisUrl, 'queue', onRedisError);
const cache = createRedis(config.redisUrl, 'cache', onRedisError);
const prisma = createPrismaClient(config.databaseUrl);
const storage = new S3ObjectStorage(config.s3);
const adapters = createAdapters({
  env: config.env,
  customerAuth: { provider: 'disabled' },
  segments: { provider: 'mock' },
  catalog: { provider: 'mock' },
  analytics: { provider: 'mock' },
  cdnPurge: { provider: 'mock' },
  siem: { provider: 'mock' },
});
const security = new SecurityLog(logger, adapters.siem);
const publishing: PublishingDeps = {
  prisma,
  storage,
  buckets: { media: config.buckets.media, public: config.buckets.public },
  redis: cache,
  keys,
  cdnPurge: adapters.cdnPurge,
  security,
  logger,
};

const base = { connection, prefix: keys.bullPrefix };
const analyticsQueue = new Queue<AnalyticsForwardJob>(QUEUES.analyticsForward, {
  ...base,
  defaultJobOptions: {
    attempts: 8,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 1000,
    removeOnFail: 10_000,
  },
});
const schedulerQueue = new Queue(QUEUES.scheduler, base);
const maintenanceQueue = new Queue<MaintenanceJob>(QUEUES.maintenance, base);

await schedulerQueue.upsertJobScheduler(
  'publish-tick',
  { every: config.schedulerIntervalMs },
  { name: 'tick' },
);
await maintenanceQueue.upsertJobScheduler(
  'retention',
  { pattern: '0 3 * * *', tz: config.statsTimezone },
  {
    name: 'retention',
    data: { task: 'retention' },
  },
);
await maintenanceQueue.upsertJobScheduler(
  'segments-sync',
  { pattern: '17 * * * *' },
  {
    name: 'segments-sync',
    data: { task: 'segments-sync' },
  },
);

const workers = [
  new Worker(
    QUEUES.scheduler,
    async () => {
      const res = await runSchedulerTick(publishing, SYSTEM_CONTEXT);
      if (res.published || res.archived) logger.info(res, 'Планировщик: изменения ленты');
      return res;
    },
    { ...base, concurrency: 1 },
  ),
  new Worker(QUEUES.mediaResults, (job: Job) => applyMediaResult(prisma, security, job.data), {
    ...base,
    concurrency: 4,
  }),
  new Worker(
    QUEUES.eventsIngest,
    async (job: Job<EventsIngestJob>) => {
      const res = await ingestEvents(
        prisma,
        job.data.events,
        new Date(job.data.receivedAt),
        config.statsTimezone,
      );
      await analyticsQueue.add('forward', { events: job.data.events });
      return res;
    },
    { ...base, concurrency: 4 },
  ),
  new Worker(
    QUEUES.analyticsForward,
    async (job: Job<AnalyticsForwardJob>) => {
      try {
        await withTimeout('analytics', 10_000, () =>
          adapters.analytics.sendEvents(job.data.events),
        );
      } catch (err) {
        adapterErrorsTotal.inc({ adapter: 'analytics' });
        throw err;
      }
    },
    { ...base, concurrency: 4 },
  ),
  new Worker(
    QUEUES.maintenance,
    async (job: Job<MaintenanceJob>) => {
      if (job.data.task === 'retention') {
        return runRetention(prisma, {
          rawEventsDays: config.rawEventsRetentionDays,
          statsDays: config.statsRetentionDays,
        });
      }
      return { segments: await syncSegments(prisma, adapters.segments) };
    },
    { ...base, concurrency: 1 },
  ),
];
for (const q of [analyticsQueue, schedulerQueue, maintenanceQueue]) {
  q.on('error', (err) => logger.error({ err, queue: q.name }, 'Ошибка очереди'));
}
for (const w of workers) {
  w.on('error', (err) => logger.error({ err, queue: w.name }, 'Ошибка воркера очереди'));
  w.on('failed', (job, err) =>
    logger.error({ err, queue: w.name, jobId: job?.id }, 'Фоновая задача упала'),
  );
}

const metrics = startMetricsServer(config.metricsPort, 'stories_jobs_');
logger.info({ schedulerIntervalMs: config.schedulerIntervalMs }, 'Фоновые задачи запущены');

async function shutdown() {
  await Promise.allSettled(workers.map((w) => w.close()));
  await Promise.allSettled([
    analyticsQueue.close(),
    schedulerQueue.close(),
    maintenanceQueue.close(),
  ]);
  metrics.close();
  await prisma.$disconnect();
  await Promise.allSettled([connection.quit(), cache.quit()]);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
