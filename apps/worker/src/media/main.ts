import { Queue, Worker } from 'bullmq';
import { S3ObjectStorage } from '@idb-stories/adapters';
import {
  MediaProcessJob,
  QUEUES,
  createLogger,
  createRedis,
  prometheus,
  redisKeys,
  type MediaResultJob,
} from '@idb-stories/core';
import { loadMediaConfig } from '../config.js';
import { startMetricsServer, workerRegistry } from '../metrics.js';
import { configureSharp } from './image.js';
import { processMedia } from './process.js';

/**
 * Изолированный медиа-воркер (раздел 10.5). Сеть: только Redis (очереди media-*) и S3.
 * Права S3: чтение quarantine, запись media. Доступа к БД нет — результат уходит в очередь
 * media-results, её разбирают фоновые задачи.
 */
const config = loadMediaConfig();
const logger = createLogger({ name: 'stories-media-worker', level: config.logLevel });
const keys = redisKeys(config.redisPrefix);
const connection = createRedis(config.redisUrl, 'queue', (err) =>
  logger.error({ err }, 'Redis недоступен'),
);
const storage = new S3ObjectStorage(config.s3);
configureSharp();

const processed = new prometheus.Counter({
  name: 'stories_media_processed_total',
  help: 'Обработанные медиафайлы',
  labelNames: ['kind', 'status'] as const,
  registers: [workerRegistry],
});
const duration = new prometheus.Histogram({
  name: 'stories_media_processing_seconds',
  help: 'Время обработки файла',
  labelNames: ['kind'] as const,
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 300],
  registers: [workerRegistry],
});

const results = new Queue<MediaResultJob>(QUEUES.mediaResults, {
  connection,
  prefix: keys.bullPrefix,
  defaultJobOptions: {
    attempts: 10,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: 1000,
  },
});

const worker = new Worker<MediaProcessJob>(
  QUEUES.mediaProcess,
  async (job) => {
    const data = MediaProcessJob.parse(job.data);
    const end = duration.startTimer({ kind: data.kind });
    const result = await processMedia(
      {
        storage,
        buckets: config.buckets,
        tmpDir: config.tmpDir,
        timeoutMs: config.timeoutMs,
        tools: {
          ffmpegPath: config.ffmpegPath,
          ffprobePath: config.ffprobePath,
          threads: config.ffmpegThreads,
        },
        logger,
      },
      data,
    );
    end();
    processed.inc({ kind: data.kind, status: result.status });
    await results.add('result', result, { jobId: `result-${data.assetId}` });
    return { status: result.status };
  },
  {
    connection,
    prefix: keys.bullPrefix,
    concurrency: config.concurrency,
    // Лок дольше таймаута обработки, чтобы задача не ушла второму воркеру.
    lockDuration: config.timeoutMs + 60_000,
  },
);

// Исчерпаны попытки из-за инфраструктурной ошибки: сообщаем, чтобы файл не завис в processing.
worker.on('failed', (job, err) => {
  logger.error({ err, assetId: job?.data.assetId }, 'Ошибка обработки медиа');
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    void results.add(
      'result',
      {
        assetId: job.data.assetId,
        status: 'rejected',
        rejectReason: 'Не удалось обработать файл, попробуйте загрузить ещё раз',
        sha256: null,
        detectedMime: null,
      },
      { jobId: `result-${job.data.assetId}` },
    );
  }
});

const metrics = startMetricsServer(config.metricsPort, 'stories_media_');
logger.info({ concurrency: config.concurrency }, 'Медиа-воркер запущен');

async function shutdown() {
  await worker.close();
  await results.close();
  metrics.close();
  await connection.quit();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
