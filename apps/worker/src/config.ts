import { z } from 'zod';

const common = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  REDIS_URL: z.string().min(1),
  REDIS_PREFIX: z
    .string()
    .regex(/^[a-z0-9:_-]*$/)
    .default('stories:'),
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  S3_BUCKET_QUARANTINE: z.string().default('stories-quarantine'),
  S3_BUCKET_MEDIA: z.string().default('stories-media'),
  S3_BUCKET_PUBLIC: z.string().default('stories-public'),
  METRICS_PORT: z.coerce.number().int().default(9465),
};

/**
 * Медиа-воркер (раздел 10.5): доступ только к Redis-очереди медиа и S3 (чтение quarantine,
 * запись media). Никакой БД и внешней сети.
 */
const MediaEnv = z.object({
  ...common,
  MEDIA_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  MEDIA_TMP_DIR: z.string().default('/tmp'),
  MEDIA_TIMEOUT_SEC: z.coerce.number().int().positive().default(300),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),
  FFMPEG_THREADS: z.coerce.number().int().min(1).max(16).default(2),
});

/** Фоновые задачи: планировщик публикаций, результаты медиа, события, ретеншн. */
const JobsEnv = z.object({
  ...common,
  DATABASE_URL: z.string().min(1),
  CDN_BASE_URL: z.url(),
  SCHEDULER_INTERVAL_SEC: z.coerce.number().int().min(5).max(300).default(15),
  STATS_TIMEZONE: z.string().default('Europe/Moscow'),
  RAW_EVENTS_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  STATS_RETENTION_DAYS: z.coerce.number().int().positive().default(730),
});

export type MediaConfig = ReturnType<typeof loadMediaConfig>;
export type JobsConfig = ReturnType<typeof loadJobsConfig>;

function parse<T extends z.ZodType>(
  schema: T,
  env: Record<string, string | undefined>,
): z.infer<T> {
  const res = schema.safeParse(env);
  if (!res.success) throw new Error(`Некорректная конфигурация:\n${z.prettifyError(res.error)}`);
  return res.data;
}

function s3(e: z.infer<z.ZodObject<typeof common>>) {
  return {
    endpoint: e.S3_ENDPOINT,
    region: e.S3_REGION,
    accessKeyId: e.S3_ACCESS_KEY_ID,
    secretAccessKey: e.S3_SECRET_ACCESS_KEY,
    forcePathStyle: e.S3_FORCE_PATH_STYLE,
  };
}

export function loadMediaConfig(env: Record<string, string | undefined> = process.env) {
  const e = parse(MediaEnv, env);
  return {
    env: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    redisUrl: e.REDIS_URL,
    redisPrefix: e.REDIS_PREFIX,
    s3: s3(e),
    buckets: { quarantine: e.S3_BUCKET_QUARANTINE, media: e.S3_BUCKET_MEDIA },
    metricsPort: e.METRICS_PORT,
    concurrency: e.MEDIA_CONCURRENCY,
    tmpDir: e.MEDIA_TMP_DIR,
    timeoutMs: e.MEDIA_TIMEOUT_SEC * 1000,
    ffmpegPath: e.FFMPEG_PATH,
    ffprobePath: e.FFPROBE_PATH,
    ffmpegThreads: e.FFMPEG_THREADS,
  };
}

export function loadJobsConfig(env: Record<string, string | undefined> = process.env) {
  const e = parse(JobsEnv, env);
  return {
    env: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    redisUrl: e.REDIS_URL,
    redisPrefix: e.REDIS_PREFIX,
    databaseUrl: e.DATABASE_URL,
    cdnBaseUrl: e.CDN_BASE_URL.replace(/\/+$/, ''),
    s3: s3(e),
    buckets: {
      quarantine: e.S3_BUCKET_QUARANTINE,
      media: e.S3_BUCKET_MEDIA,
      public: e.S3_BUCKET_PUBLIC,
    },
    metricsPort: e.METRICS_PORT,
    schedulerIntervalMs: e.SCHEDULER_INTERVAL_SEC * 1000,
    statsTimezone: e.STATS_TIMEZONE,
    rawEventsRetentionDays: e.RAW_EVENTS_RETENTION_DAYS,
    statsRetentionDays: e.STATS_RETENTION_DAYS,
  };
}
