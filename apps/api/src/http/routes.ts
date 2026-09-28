import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuditContext } from '@idb-stories/core';
import { hasPermission, type Role } from '@idb-stories/schema';
import type {
  BodyOf,
  HeadersOf,
  ParamsOf,
  QueryOf,
  RouteContract,
} from '@idb-stories/schema/contracts';
import type { z } from 'zod';
import { safeEqual } from '@idb-stories/adapters';
import type { SessionData, SessionStore } from '../auth/session.js';
import type { AppDeps } from '../context.js';
import { AppError, badRequest, forbidden, unauthorized, zodDetails } from './errors.js';

export interface Actor {
  id: string;
  name: string;
  email: string;
  roles: Role[];
}

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor | null;
    session: { sid: string; data: SessionData } | null;
  }
}

export function cookieNames(secure: boolean) {
  // Префикс __Host- требует Secure, Path=/ и запрещает Domain — cookie не утечёт на поддомены.
  return secure
    ? { session: '__Host-stories_sid', login: '__Host-stories_login' }
    : { session: 'stories_sid', login: 'stories_login' };
}

export interface HandlerContext<C extends RouteContract> {
  req: FastifyRequest;
  reply: FastifyReply;
  params: ParamsOf<C>;
  query: QueryOf<C>;
  body: BodyOf<C>;
  headers: HeadersOf<C>;
  actor: C['auth'] extends 'session' ? Actor : null;
  audit: AuditContext;
}

export interface RouteDef {
  contract: RouteContract;
  handler: (ctx: HandlerContext<RouteContract>) => Promise<unknown>;
  /** Дополнительный config маршрута Fastify (например, rateLimit). */
  fastifyConfig?: Record<string, unknown>;
}

export function route<C extends RouteContract>(
  contract: C,
  handler: (ctx: HandlerContext<C>) => Promise<unknown>,
): RouteDef {
  return { contract, handler };
}

function parsePart<T>(schema: z.ZodType<T> | undefined, value: unknown, part: string): T {
  if (!schema) return {} as T;
  const res = schema.safeParse(value);
  if (!res.success) throw badRequest(`Некорректные ${part}`, zodDetails(res.error));
  return res.data;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function auditContext(req: FastifyRequest): AuditContext {
  const ua = req.headers['user-agent'];
  return {
    actorId: req.actor?.id ?? null,
    ip: req.ip,
    userAgent: typeof ua === 'string' ? ua : null,
    requestId: req.id,
  };
}

/** Загружает сессию и пользователя. Роли читаются из БД на каждый запрос — отзыв прав мгновенный. */
export async function authenticate(
  req: FastifyRequest,
  deps: AppDeps,
  sessions: SessionStore,
): Promise<Actor> {
  const names = cookieNames(deps.config.admin.cookieSecure);
  const sid = req.cookies[names.session];
  if (!sid) throw unauthorized();
  const data = await sessions.get(sid);
  if (!data) throw unauthorized('Сессия истекла, войдите снова');
  const user = await deps.prisma.adminUser.findUnique({
    where: { id: data.userId },
    include: { roles: true },
  });
  if (!user || user.disabled) {
    await sessions.destroy(sid, data.userId);
    throw unauthorized('Учётная запись заблокирована');
  }
  const actor: Actor = {
    id: user.id,
    name: user.name,
    email: user.email,
    roles: user.roles.map((r) => r.role),
  };
  req.session = { sid, data };
  req.actor = actor;
  return actor;
}

export function registerRoutes(
  app: FastifyInstance,
  routes: readonly RouteDef[],
  deps: AppDeps,
  sessions: SessionStore | null,
): void {
  for (const { contract: c, handler, fastifyConfig } of routes) {
    const statuses = Object.keys(c.responses).map(Number);
    const defaultStatus = Math.min(...statuses.filter((s) => s >= 200 && s < 400));

    app.route({
      method: c.method,
      url: c.path,
      ...(c.bodyLimit ? { bodyLimit: c.bodyLimit } : {}),
      config: { contractId: c.id, ...fastifyConfig },
      preHandler:
        c.auth === 'session'
          ? async (req) => {
              if (!sessions) throw new AppError(500, 'internal', 'Сессии не настроены');
              const actor = await authenticate(req, deps, sessions);
              if (MUTATING.has(req.method)) checkCsrf(req, deps);
              if (c.permission && !hasPermission(actor.roles, c.permission)) {
                throw forbidden(); // событие access.denied пишет обработчик ошибок
              }
            }
          : undefined,
      handler: async (req, reply) => {
        const ctx = {
          req,
          reply,
          params: parsePart(c.params, req.params, 'параметры пути'),
          query: parsePart(c.query, req.query, 'параметры запроса'),
          body: c.body ? parsePart(c.body, req.body, 'данные') : undefined,
          headers: parsePart(c.headers, req.headers, 'заголовки'),
          actor: req.actor,
          audit: auditContext(req),
        } as HandlerContext<RouteContract>;
        const result = await handler(ctx);
        if (result === reply || reply.sent) return reply;
        const status = reply.statusCode === 200 ? defaultStatus : reply.statusCode;
        if (status === 204 || result === undefined) return reply.code(status).send();
        if (deps.config.validateResponses) {
          const schema = c.responses[status]?.schema;
          const check = schema?.safeParse(result);
          if (check && !check.success) {
            req.log.error(
              { issues: zodDetails(check.error), operation: c.id },
              'Ответ не соответствует контракту',
            );
            throw new AppError(
              500,
              'response_contract_violation',
              'Ответ не соответствует контракту',
              zodDetails(check.error),
            );
          }
        }
        return reply.code(status).send(result);
      },
    });
  }
}

/**
 * CSRF (раздел 10.2): синхронизирующий токен из сессии в заголовке X-CSRF-Token
 * плюс проверка Origin/Sec-Fetch-Site как второй рубеж.
 */
function checkCsrf(req: FastifyRequest, deps: AppDeps): void {
  const token = req.headers['x-csrf-token'];
  const expected = req.session?.data.csrfToken;
  const origin = req.headers.origin;
  const fetchSite = req.headers['sec-fetch-site'];
  const ok =
    typeof token === 'string' &&
    !!expected &&
    safeEqual(token, expected) &&
    (origin === undefined || origin === deps.config.admin.origin) &&
    fetchSite !== 'cross-site';
  if (!ok) {
    deps.security.emit('csrf.failed', {
      actorId: req.actor?.id ?? null,
      ip: req.ip,
      requestId: req.id,
      details: { route: req.routeOptions.url, origin: origin ?? null },
    });
    throw forbidden('Неверный CSRF-токен', 'csrf_failed');
  }
}
