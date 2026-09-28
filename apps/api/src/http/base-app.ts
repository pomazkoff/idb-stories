import { randomUUID } from 'node:crypto';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyRequest,
} from 'fastify';
import { prometheus } from '@idb-stories/core';
import type { AppDeps } from '../context.js';
import { installErrorHandler, type AppError } from './errors.js';

export const httpRegistry = new prometheus.Registry();

const httpDuration = new prometheus.Histogram({
  name: 'stories_http_request_duration_seconds',
  help: 'Длительность HTTP-запросов',
  labelNames: ['surface', 'route', 'method', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.4, 0.75, 1, 2.5, 5],
  registers: [httpRegistry],
});

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Общая основа публичного и admin-приложения: request_id (трассировка через все логи и аудит),
 * структурированный логгер с маскированием, единый формат ошибок, метрики.
 */
export function createBaseApp(
  deps: AppDeps,
  surface: 'public' | 'admin',
  opts: { bodyLimit: number; onForbidden?: (req: FastifyRequest, err: AppError) => void },
): FastifyInstance {
  const app = Fastify({
    // Приведение к базовому типу: иначе FastifyInstance параметризуется типом pino и не совместим с остальным кодом.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    loggerInstance: deps.logger.child({ surface }) as FastifyBaseLogger,
    trustProxy: deps.config.trustProxy,
    bodyLimit: opts.bodyLimit,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
    },
    routerOptions: { maxParamLength: 128, ignoreTrailingSlash: false },
    return503OnClosing: true,
  });

  app.decorateRequest('actor', null);
  app.decorateRequest('session', null);

  app.addHook('onRequest', async (req, reply) => {
    void reply.header('x-request-id', req.id);
  });

  app.addHook('onResponse', async (req, reply) => {
    httpDuration.observe(
      {
        surface,
        route: req.routeOptions.url ?? 'unknown',
        method: req.method,
        status: String(reply.statusCode),
      },
      reply.elapsedTime / 1000,
    );
  });

  installErrorHandler(app, { ...(opts.onForbidden ? { onForbidden: opts.onForbidden } : {}) });
  return app;
}
