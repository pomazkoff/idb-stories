import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import type { FastifyInstance } from 'fastify';
import { SessionStore } from './auth/session.js';
import type { AppDeps } from './context.js';
import { registerMockIdp } from './dev/mock-idp.js';
import { createBaseApp } from './http/base-app.js';
import { registerRoutes } from './http/routes.js';
import { adminRoutes } from './routes/admin/index.js';

/**
 * Admin API (/admin/v1): только SSO, серверные сессии, CSRF, RBAC на каждом эндпоинте.
 * Сетевой доступ — только из внутренней сети/VPN ИДБ (ingress, [ИНТЕГРАЦИЯ]).
 */
export async function createAdminApp(
  deps: AppDeps,
): Promise<{ app: FastifyInstance; sessions: SessionStore }> {
  // Любой отказ в доступе — событие безопасности (раздел 10.9). CSRF и самосогласование пишутся
  // отдельными типами событий в месте проверки.
  const app = createBaseApp(deps, 'admin', {
    bodyLimit: 256 * 1024,
    onForbidden: (req, err) => {
      if (err.code === 'csrf_failed' || err.code === 'four_eyes') return;
      deps.security.emit('access.denied', {
        actorId: req.actor?.id ?? null,
        ip: req.ip,
        requestId: req.id,
        details: {
          route: req.routeOptions.url,
          method: req.method,
          code: err.code,
          roles: req.actor?.roles ?? [],
        },
      });
    },
  });
  const sessions = new SessionStore(
    deps.sessionRedis,
    deps.keys,
    deps.config.admin.sessionIdleSec,
    deps.config.admin.sessionAbsoluteSec,
    () => deps.now().getTime(),
  );

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
      },
    },
    hsts: { maxAge: 31_536_000, includeSubDomains: true },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });
  await app.register(cors, {
    origin: [deps.config.admin.origin],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Request-Id'],
  });
  await app.register(cookie);

  // Все ответы admin API персональные: никакого кеширования.
  app.addHook('onSend', async (_req, reply) => {
    if (!reply.hasHeader('cache-control')) void reply.header('cache-control', 'no-store');
  });

  registerRoutes(app, adminRoutes(deps, sessions), deps, sessions);
  if (deps.config.env !== 'production' && deps.sso.kind === 'mock')
    await registerMockIdp(app, deps);
  return { app, sessions };
}
