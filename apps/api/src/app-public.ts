import compress from '@fastify/compress';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import { LIMITS } from '@idb-stories/schema';
import type { AppDeps } from './context.js';
import { createBaseApp } from './http/base-app.js';
import { registerRoutes, type RouteDef } from './http/routes.js';
import { eventsRoutes } from './routes/public/events.js';
import { feedRoutes } from './routes/public/feed.js';
import { healthRoutes } from './routes/public/health.js';

/** Публичный API: /v1/feed, /v1/events, /v1/health. Отдельный порт и хост от admin API. */
export async function createPublicApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = createBaseApp(deps, 'public', { bodyLimit: LIMITS.eventsBodyMaxBytes });

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
    hsts: { maxAge: 31_536_000, includeSubDomains: true },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });
  // CORS только для доменов сайта ИДБ (раздел 10.6); cookie не используются.
  await app.register(cors, {
    origin: deps.config.public.corsOrigins,
    methods: ['GET', 'POST'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'X-Platform',
      'X-App-Version',
      'X-Request-Id',
    ],
    credentials: false,
    maxAge: 600,
  });
  await app.register(compress, { global: true, threshold: 1024, encodings: ['br', 'gzip'] });
  // navigator.sendBeacon при закрытии страницы отправляет JSON как text/plain (без CORS preflight).
  // Публичный API принимает тело только на /v1/events, поэтому разбираем text/plain как JSON.
  app.removeContentTypeParser('text/plain');
  app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(Object.assign(new Error('Некорректный JSON'), { statusCode: 400 }), undefined);
    }
  });
  await app.register(rateLimit, {
    global: false,
    redis: deps.redis,
    nameSpace: deps.keys.rateLimit,
    skipOnError: true,
    keyGenerator: (req) => req.ip,
    onExceeded: (req) => {
      deps.security.emit('rate_limit.exceeded', {
        ip: req.ip,
        requestId: req.id,
        details: { route: req.routeOptions.url },
      });
    },
  });

  const limited = (defs: RouteDef[], max: number): RouteDef[] =>
    defs.map((d) => ({ ...d, fastifyConfig: { rateLimit: { max, timeWindow: 60_000 } } }));

  registerRoutes(
    app,
    [
      ...healthRoutes(deps),
      ...limited(feedRoutes(deps), deps.config.public.feedRateLimitPerMin),
      ...limited(eventsRoutes(deps), deps.config.public.eventsRateLimitPerMin),
    ],
    deps,
    null,
  );
  return app;
}
