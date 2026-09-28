import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(def ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

const list = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Какие поверхности поднимать в процессе: public, admin или обе (раздельные порты). */
  API_SURFACES: list.pipe(z.array(z.enum(['public', 'admin'])).min(1)).default(['public', 'admin']),
  HOST: z.string().default('0.0.0.0'),
  PUBLIC_PORT: z.coerce.number().int().default(8080),
  ADMIN_PORT: z.coerce.number().int().default(8081),
  METRICS_PORT: z.coerce.number().int().default(9464),
  /** Доверять X-Forwarded-For от ingress/CDN: 'true', 'false' или список адресов/подсетей. */
  TRUST_PROXY: z.string().default('false'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  REDIS_PREFIX: z
    .string()
    .regex(/^[a-z0-9:_-]*$/)
    .default('stories:'),

  // Публичный API
  PUBLIC_CORS_ORIGINS: list,
  CDN_BASE_URL: z.url(),
  FEED_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(600),
  EVENTS_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(300),
  SEGMENTS_CACHE_SALT: z.string().min(16),

  // Admin API
  ADMIN_ORIGIN: z.url(),
  ADMIN_COOKIE_SECURE: bool(true),
  SESSION_IDLE_TIMEOUT_SEC: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 60),
  SESSION_ABSOLUTE_TIMEOUT_SEC: z.coerce
    .number()
    .int()
    .positive()
    .default(8 * 60 * 60),
  SSO_PROVIDER: z.enum(['mock']).default('mock'),
  SSO_MOCK_SECRET: z.string().min(32).optional(),

  // Хранилище
  S3_ENDPOINT: z.url(),
  S3_PUBLIC_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: bool(true),
  S3_BUCKET_QUARANTINE: z.string().default('stories-quarantine'),
  S3_BUCKET_MEDIA: z.string().default('stories-media'),
  S3_BUCKET_PUBLIC: z.string().default('stories-public'),

  // Адаптеры ИДБ
  CUSTOMER_AUTH_PROVIDER: z.enum(['disabled', 'mock']).default('disabled'),
  CUSTOMER_AUTH_MOCK_SECRET: z.string().optional(),
  CUSTOMER_AUTH_ISSUER: z.string().default('https://id.iledebeaute.example'),
  CUSTOMER_AUTH_AUDIENCE: z.string().default('stories'),
});

export type Env = z.infer<typeof EnvSchema>;

export interface Config {
  env: Env['NODE_ENV'];
  logLevel: Env['LOG_LEVEL'];
  surfaces: ('public' | 'admin')[];
  host: string;
  publicPort: number;
  adminPort: number;
  metricsPort: number;
  trustProxy: boolean | string[];
  databaseUrl: string;
  redisUrl: string;
  redisPrefix: string;
  public: {
    corsOrigins: string[];
    cdnBaseUrl: string;
    feedRateLimitPerMin: number;
    eventsRateLimitPerMin: number;
    segmentsCacheSalt: string;
  };
  admin: {
    origin: string;
    cookieSecure: boolean;
    sessionIdleSec: number;
    sessionAbsoluteSec: number;
    sso: { provider: 'mock'; mockSecret: string | undefined };
  };
  s3: {
    endpoint: string;
    publicEndpoint: string | undefined;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
    buckets: { quarantine: string; media: string; public: string };
  };
  customerAuth:
    | { provider: 'disabled' }
    | { provider: 'mock'; secret: string; issuer: string; audience: string };
  /** Проверять ответы по схемам контрактов (dev/test), чтобы OpenAPI не расходился с кодом. */
  validateResponses: boolean;
}

/**
 * Разбор окружения. Небезопасные комбинации в production — ошибка старта, а не предупреждение
 * (раздел 10.2: mock-IdP невозможно включить в production).
 */
export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Некорректная конфигурация:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  const prod = e.NODE_ENV === 'production';

  const problems: string[] = [];
  if (prod) {
    // Mock-IdP нельзя включить в production (10.2). Процессу только с публичным API SSO не нужен.
    if (e.API_SURFACES.includes('admin') && e.SSO_PROVIDER === 'mock') {
      problems.push('SSO_PROVIDER=mock запрещён в production');
    }
    if (e.CUSTOMER_AUTH_PROVIDER === 'mock')
      problems.push('CUSTOMER_AUTH_PROVIDER=mock запрещён в production');
    if (!e.ADMIN_COOKIE_SECURE) problems.push('ADMIN_COOKIE_SECURE=false запрещён в production');
    if (!e.ADMIN_ORIGIN.startsWith('https://')) problems.push('ADMIN_ORIGIN должен быть https');
    if (!e.CDN_BASE_URL.startsWith('https://')) problems.push('CDN_BASE_URL должен быть https');
    if (e.PUBLIC_CORS_ORIGINS.some((o) => !o.startsWith('https://'))) {
      problems.push('PUBLIC_CORS_ORIGINS: только https');
    }
  }
  if (e.CUSTOMER_AUTH_PROVIDER === 'mock' && (e.CUSTOMER_AUTH_MOCK_SECRET?.length ?? 0) < 32) {
    problems.push('CUSTOMER_AUTH_MOCK_SECRET: нужно не меньше 32 символов');
  }
  if (problems.length > 0)
    throw new Error(`Небезопасная конфигурация:\n- ${problems.join('\n- ')}`);

  const trustProxy =
    e.TRUST_PROXY === 'true'
      ? true
      : e.TRUST_PROXY === 'false'
        ? false
        : e.TRUST_PROXY.split(',').map((s) => s.trim());

  return {
    env: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    surfaces: e.API_SURFACES,
    host: e.HOST,
    publicPort: e.PUBLIC_PORT,
    adminPort: e.ADMIN_PORT,
    metricsPort: e.METRICS_PORT,
    trustProxy,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    redisPrefix: e.REDIS_PREFIX,
    public: {
      corsOrigins: e.PUBLIC_CORS_ORIGINS,
      cdnBaseUrl: e.CDN_BASE_URL.replace(/\/+$/, ''),
      feedRateLimitPerMin: e.FEED_RATE_LIMIT_PER_MIN,
      eventsRateLimitPerMin: e.EVENTS_RATE_LIMIT_PER_MIN,
      segmentsCacheSalt: e.SEGMENTS_CACHE_SALT,
    },
    admin: {
      origin: new URL(e.ADMIN_ORIGIN).origin,
      cookieSecure: e.ADMIN_COOKIE_SECURE,
      sessionIdleSec: e.SESSION_IDLE_TIMEOUT_SEC,
      sessionAbsoluteSec: e.SESSION_ABSOLUTE_TIMEOUT_SEC,
      sso: { provider: e.SSO_PROVIDER, mockSecret: e.SSO_MOCK_SECRET },
    },
    s3: {
      endpoint: e.S3_ENDPOINT,
      publicEndpoint: e.S3_PUBLIC_ENDPOINT,
      region: e.S3_REGION,
      accessKeyId: e.S3_ACCESS_KEY_ID,
      secretAccessKey: e.S3_SECRET_ACCESS_KEY,
      forcePathStyle: e.S3_FORCE_PATH_STYLE,
      buckets: {
        quarantine: e.S3_BUCKET_QUARANTINE,
        media: e.S3_BUCKET_MEDIA,
        public: e.S3_BUCKET_PUBLIC,
      },
    },
    customerAuth:
      e.CUSTOMER_AUTH_PROVIDER === 'mock'
        ? {
            provider: 'mock',
            secret: e.CUSTOMER_AUTH_MOCK_SECRET ?? '',
            issuer: e.CUSTOMER_AUTH_ISSUER,
            audience: e.CUSTOMER_AUTH_AUDIENCE,
          }
        : { provider: 'disabled' },
    validateResponses: !prod,
  };
}
