import { Writable } from 'node:stream';
import cookie from '@fastify/cookie';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MockSiemAdapter } from '@idb-stories/adapters';
import { SecurityLog, createLogger } from '@idb-stories/core';
import type { Role } from '@idb-stories/schema';
import { defineContract, type RouteContract } from '@idb-stories/schema/contracts';
import type { SessionData, SessionStore } from '../src/auth/session.js';
import type { AppDeps } from '../src/context.js';
import { createBaseApp } from '../src/http/base-app.js';
import { AppError, notFound } from '../src/http/errors.js';
import {
  auditContext,
  cookieNames,
  registerRoutes,
  route,
  type Actor,
  type RouteDef,
} from '../src/http/routes.js';

const ORIGIN = 'https://admin.routes.test';
const REQUEST_ID = 'req-routes-0001';

interface FakeUser {
  id: string;
  name: string;
  email: string;
  disabled: boolean;
  roles: { role: Role }[];
}

interface LogLine {
  level: string;
  msg: string;
  [key: string]: unknown;
}

interface ErrorBody {
  error: { code: string; message: string; details?: { path: string; code: string }[] };
  requestId: string;
}

/** Хранилище сессий в памяти: registerRoutes использует только get и destroy. */
class FakeSessions {
  readonly data = new Map<string, SessionData>();
  readonly destroyed: { sid: string; userId: string | undefined }[] = [];

  async get(sid: string): Promise<SessionData | null> {
    return this.data.get(sid) ?? null;
  }

  async destroy(sid: string, userId?: string): Promise<void> {
    this.destroyed.push({ sid, userId });
    this.data.delete(sid);
  }
}

interface BuildOptions {
  validateResponses?: boolean;
  cookieSecure?: boolean;
  sessions?: FakeSessions | null;
  users?: FakeUser[];
}

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

/**
 * Минимальное приложение: createBaseApp (единый формат ошибок, request_id) + registerRoutes
 * с поддельными зависимостями — только поля, которые реально читают маршруты.
 */
async function build(routes: RouteDef[], opts: BuildOptions = {}) {
  const lines: string[] = [];
  const logger = createLogger({
    name: 'routes-test',
    level: 'info',
    destination: new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    }),
  });
  const siem = new MockSiemAdapter();
  const users = new Map((opts.users ?? []).map((u) => [u.id, u]));
  const deps = {
    config: {
      trustProxy: false,
      validateResponses: opts.validateResponses ?? true,
      admin: { origin: ORIGIN, cookieSecure: opts.cookieSecure ?? false },
    },
    logger,
    security: new SecurityLog(logger, siem),
    prisma: {
      adminUser: {
        findUnique: async (args: { where: { id: string } }) => users.get(args.where.id) ?? null,
      },
    },
  } as unknown as AppDeps;
  const forbidden: string[] = [];
  const app = createBaseApp(deps, 'admin', {
    bodyLimit: 4096,
    onForbidden: (_req, err) => forbidden.push(err.code),
  });
  apps.push(app);
  await app.register(cookie);
  const sessions = (opts.sessions ?? null) as unknown as SessionStore | null;
  registerRoutes(app, routes, deps, sessions);
  await app.ready();
  const logs = () =>
    lines.flatMap((l) => l.split('\n').filter(Boolean)).map((l) => JSON.parse(l) as LogLine);
  return { app, siem, forbidden, logs };
}

const Item = z.object({ id: z.string(), name: z.string() });

function contract<const C extends Omit<RouteContract, 'summary' | 'tags'>>(c: C) {
  return defineContract({ summary: 'тест', tags: ['test'] as const, ...c });
}

describe('cookieNames', () => {
  it('Secure → имена с префиксом __Host-, иначе без префикса', () => {
    expect(cookieNames(true)).toEqual({
      session: '__Host-stories_sid',
      login: '__Host-stories_login',
    });
    expect(cookieNames(false)).toEqual({ session: 'stories_sid', login: 'stories_login' });
  });
});

describe('auditContext', () => {
  const fakeReq = (headers: Record<string, unknown>, actor: Actor | null) =>
    ({ ip: '10.1.2.3', id: 'req-audit-1', headers, actor }) as unknown as FastifyRequest;

  it('берёт ip, user-agent, request id и id пользователя', () => {
    const actor: Actor = { id: 'u-1', name: 'Анна', email: 'a@test', roles: ['editor'] };
    expect(auditContext(fakeReq({ 'user-agent': 'Browser/1.0' }, actor))).toEqual({
      actorId: 'u-1',
      ip: '10.1.2.3',
      userAgent: 'Browser/1.0',
      requestId: 'req-audit-1',
    });
  });

  it('без user-agent и без пользователя → null', () => {
    expect(auditContext(fakeReq({}, null))).toEqual({
      actorId: null,
      ip: '10.1.2.3',
      userAgent: null,
      requestId: 'req-audit-1',
    });
  });

  it('нестроковый user-agent не попадает в аудит', () => {
    expect(auditContext(fakeReq({ 'user-agent': ['a', 'b'] }, null)).userAgent).toBeNull();
  });

  it('в обработчик приходит контекст аудита реального запроса', async () => {
    const c = contract({
      id: 'testAudit',
      method: 'GET',
      path: '/t/audit',
      auth: 'public',
      responses: { 200: { description: 'OK' } },
    });
    const { app } = await build([route(c, async ({ audit }) => audit)]);
    const res = await app.inject({
      method: 'GET',
      url: '/t/audit',
      headers: { 'user-agent': 'StoriesTest/2.0', 'x-request-id': REQUEST_ID },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      actorId: null,
      ip: '127.0.0.1',
      userAgent: 'StoriesTest/2.0',
      requestId: REQUEST_ID,
    });
  });
});

describe('registerRoutes: статус и тело ответа', () => {
  const create = contract({
    id: 'testCreate',
    method: 'POST',
    path: '/t/items',
    auth: 'public',
    body: z.object({ name: z.string().min(1) }),
    responses: {
      202: { description: 'Принято', schema: z.object({ queued: z.literal(true) }) },
      201: { description: 'Создано', schema: Item },
      400: { description: 'Ошибка валидации' },
    },
  });

  it('по умолчанию — наименьший 2xx из контракта (201), тело проходит через схему', async () => {
    const { app } = await build([
      route(create, async ({ body }) => ({ id: 'i-1', name: body.name, extra: 'лишнее' })),
    ]);
    const res = await app.inject({ method: 'POST', url: '/t/items', payload: { name: 'Весна' } });
    expect(res.statusCode).toBe(201);
    // Схема не обрезает ответ: отправляется результат обработчика как есть.
    expect(res.json()).toEqual({ id: 'i-1', name: 'Весна', extra: 'лишнее' });
  });

  it('статус, выставленный обработчиком, сохраняется и проверяется своей схемой', async () => {
    const { app } = await build([
      route(create, async ({ reply, body }) => {
        void reply.code(202);
        // «mismatch»: тело подходит под схему 201, но не под схему выставленного статуса 202.
        return body.name === 'mismatch' ? { id: 'i-1', name: 'x' } : { queued: true };
      }),
    ]);
    const res = await app.inject({ method: 'POST', url: '/t/items', payload: { name: 'x' } });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ queued: true });

    const wrong = await app.inject({
      method: 'POST',
      url: '/t/items',
      payload: { name: 'mismatch' },
    });
    expect(wrong.statusCode).toBe(500);
    expect(wrong.json<ErrorBody>().error.code).toBe('response_contract_violation');
    expect(wrong.json<ErrorBody>().error.details).toEqual([
      expect.objectContaining({ path: 'queued' }),
    ]);
  });

  it('контракт только с 3xx: статус по умолчанию — 302', async () => {
    const c = contract({
      id: 'testRedirect',
      method: 'GET',
      path: '/t/redirect',
      auth: 'public',
      responses: { 302: { description: 'Редирект' }, 401: { description: 'Нет входа' } },
    });
    const { app } = await build([
      route(c, async ({ reply }) => {
        void reply.header('location', '/t/next');
        return undefined;
      }),
    ]);
    const res = await app.inject({ method: 'GET', url: '/t/redirect' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/t/next');
    expect(res.body).toBe('');
  });

  it('обработчик вернул undefined → пустое тело со статусом по умолчанию', async () => {
    const { app } = await build([route(create, async () => undefined)]);
    const res = await app.inject({ method: 'POST', url: '/t/items', payload: { name: 'x' } });
    expect(res.statusCode).toBe(201);
    expect(res.body).toBe('');
  });

  it('204 → тело не отправляется, даже если обработчик что-то вернул', async () => {
    const c = contract({
      id: 'testDelete',
      method: 'DELETE',
      path: '/t/items/:id',
      auth: 'public',
      params: z.object({ id: z.string() }),
      responses: { 204: { description: 'Удалено' }, 404: { description: 'Нет' } },
    });
    const { app } = await build([route(c, async ({ params }) => ({ deleted: params.id }))]);
    const res = await app.inject({ method: 'DELETE', url: '/t/items/abc' });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
  });

  it('обработчик сам отправил ответ и вернул reply → ответ не трогается', async () => {
    const c = contract({
      id: 'testRaw',
      method: 'GET',
      path: '/t/raw',
      auth: 'public',
      responses: { 200: { description: 'OK', schema: Item } },
    });
    const { app, logs } = await build([
      route(c, async ({ reply }) => reply.code(200).type('text/plain').send('сырой ответ')),
    ]);
    const res = await app.inject({ method: 'GET', url: '/t/raw' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.body).toBe('сырой ответ');
    expect(logs().filter((l) => l.level === 'error' || l.level === 'warn')).toEqual([]);
  });

  it('обработчик вернул reply и отправил ответ позже → ответ дожидается отправки, повтора нет', async () => {
    const c = contract({
      id: 'testDeferred',
      method: 'GET',
      path: '/t/deferred',
      auth: 'public',
      responses: { 200: { description: 'OK', schema: Item } },
    });
    const { app, logs } = await build([
      route(c, async ({ reply }) => {
        setImmediate(() => void reply.code(202).send({ later: true }));
        return reply;
      }),
    ]);
    const res = await app.inject({ method: 'GET', url: '/t/deferred' });
    // reply не проверяется как тело ответа (иначе 500 по схеме Item) и не отправляется повторно.
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ later: true });
    await new Promise((resolve) => setImmediate(resolve));
    expect(logs().filter((l) => l.level === 'error' || l.level === 'warn')).toEqual([]);
  });

  it('обработчик отправил ответ, но вернул другое значение → второй отправки нет', async () => {
    const c = contract({
      id: 'testSent',
      method: 'GET',
      path: '/t/sent',
      auth: 'public',
      responses: { 200: { description: 'OK', schema: Item } },
    });
    const { app, logs } = await build([
      route(c, async ({ reply }) => {
        void reply.code(202).send({ manual: true });
        return { id: 'потеряно', name: 'потеряно' };
      }),
    ]);
    const res = await app.inject({ method: 'GET', url: '/t/sent' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ manual: true });
    // Повторный reply.send дал бы предупреждение Fastify «Reply was already sent».
    expect(logs().filter((l) => l.level === 'error' || l.level === 'warn')).toEqual([]);
  });

  it('без схем в контракте: params/query/headers — пустые объекты, body — undefined', async () => {
    const c = contract({
      id: 'testBare',
      method: 'POST',
      path: '/t/bare',
      auth: 'public',
      responses: { 200: { description: 'OK' } },
    });
    const { app } = await build([
      route(c, async ({ params, query, headers, body }) => ({
        params,
        query,
        headers,
        bodyIsUndefined: body === undefined,
      })),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/t/bare?x=1',
      payload: { anything: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ params: {}, query: {}, headers: {}, bodyIsUndefined: true });
  });

  it('в config маршрута есть contractId и дополнительный fastifyConfig', async () => {
    const c = contract({
      id: 'testConfig',
      method: 'GET',
      path: '/t/config',
      auth: 'public',
      responses: { 200: { description: 'OK' } },
    });
    const def: RouteDef = {
      ...route(c, async ({ req }) => req.routeOptions.config),
      fastifyConfig: { rateLimit: { max: 5 } },
    };
    const { app } = await build([def]);
    const res = await app.inject({ method: 'GET', url: '/t/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ contractId: 'testConfig', rateLimit: { max: 5 } });
  });
});

describe('registerRoutes: валидация входа → 400 validation_error', () => {
  const c = contract({
    id: 'testValidate',
    method: 'POST',
    path: '/t/groups/:id/items',
    auth: 'public',
    params: z.object({ id: z.uuid() }),
    query: z.object({ limit: z.coerce.number().int().max(50).optional() }),
    headers: z.object({ 'x-client-version': z.string().regex(/^\d+\.\d+$/) }),
    body: z.object({ name: z.string().min(1) }),
    responses: { 200: { description: 'OK' }, 400: { description: 'Ошибка валидации' } },
  });
  const ID = '6f9619ff-8b86-4d01-b42d-00cf4fc964ff';
  let calls = 0;
  const echo = route(c, async ({ params, query, headers, body }) => {
    calls++;
    return { params, query, headers, body };
  });

  async function send(url: string, payload: unknown, headers: Record<string, string> = {}) {
    const { app } = await build([echo]);
    return app.inject({
      method: 'POST',
      url,
      headers: { 'x-client-version': '5.12', 'x-request-id': REQUEST_ID, ...headers },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  }

  function expectValidation(
    res: { statusCode: number; json: <T>() => T },
    message: string,
    details: { path: string; code: string }[],
  ) {
    expect(res.statusCode).toBe(400);
    const body = res.json<ErrorBody>();
    expect(body.error.code).toBe('validation_error');
    expect(body.error.message).toBe(message);
    expect(body.requestId).toBe(REQUEST_ID);
    expect(body.error.details).toEqual(details.map((d): unknown => expect.objectContaining(d)));
  }

  it('корректный запрос: обработчик получает разобранные и приведённые значения', async () => {
    calls = 0;
    const res = await send(`/t/groups/${ID}/items?limit=20`, { name: 'Весна' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      params: { id: ID },
      query: { limit: 20 },
      // Лишние заголовки (host, user-agent, x-request-id…) отбрасываются схемой.
      headers: { 'x-client-version': '5.12' },
      body: { name: 'Весна' },
    });
    expect(calls).toBe(1);
  });

  it('параметры пути', async () => {
    calls = 0;
    const res = await send('/t/groups/not-a-uuid/items?limit=500', { name: '' });
    // Параметры пути проверяются первыми; обработчик не вызывается.
    expectValidation(res, 'Некорректные параметры пути', [{ path: 'id', code: 'invalid_format' }]);
    expect(calls).toBe(0);
  });

  it('параметры запроса', async () => {
    calls = 0;
    const res = await send(`/t/groups/${ID}/items?limit=500`, { name: 'x' });
    expectValidation(res, 'Некорректные параметры запроса', [{ path: 'limit', code: 'too_big' }]);
    expect(calls).toBe(0);
  });

  it('тело запроса', async () => {
    calls = 0;
    const res = await send(`/t/groups/${ID}/items`, { name: '' });
    expectValidation(res, 'Некорректные данные', [{ path: 'name', code: 'too_small' }]);
    expect(calls).toBe(0);
  });

  it('отсутствующее тело при обязательной схеме', async () => {
    calls = 0;
    const res = await send(`/t/groups/${ID}/items`, undefined);
    expectValidation(res, 'Некорректные данные', [{ path: '', code: 'invalid_type' }]);
    expect(calls).toBe(0);
  });

  it('заголовки', async () => {
    calls = 0;
    const res = await send(`/t/groups/${ID}/items`, { name: 'x' }, { 'x-client-version': 'v5' });
    expectValidation(res, 'Некорректные заголовки', [
      { path: 'x-client-version', code: 'invalid_format' },
    ]);
    expect(calls).toBe(0);
  });
});

describe('registerRoutes: проверка ответа по контракту', () => {
  const c = contract({
    id: 'testContractOut',
    method: 'GET',
    path: '/t/out',
    auth: 'public',
    responses: { 200: { description: 'OK', schema: Item } },
  });
  // Обработчик нарушает контракт: id — число, name отсутствует.
  const broken = route(c, async () => ({ id: 42 }));

  it('validateResponses=true: несоответствие → 500 response_contract_violation и лог', async () => {
    const { app, logs } = await build([broken], { validateResponses: true });
    const res = await app.inject({
      method: 'GET',
      url: '/t/out',
      headers: { 'x-request-id': REQUEST_ID },
    });
    expect(res.statusCode).toBe(500);
    const body = res.json<ErrorBody>();
    expect(body).toEqual({
      error: {
        code: 'response_contract_violation',
        message: 'Ответ не соответствует контракту',
        details: [
          expect.objectContaining({ path: 'id', code: 'invalid_type' }),
          expect.objectContaining({ path: 'name', code: 'invalid_type' }),
        ],
      },
      requestId: REQUEST_ID,
    });
    // Неверное тело клиенту не уходит.
    expect(res.body).not.toContain('42');
    const violation = logs().find((l) => l.msg === 'Ответ не соответствует контракту');
    expect(violation).toMatchObject({
      level: 'error',
      operation: 'testContractOut',
      issues: [{ path: 'id' }, { path: 'name' }],
    });
    expect(logs().some((l) => l.msg === 'app error' && l.level === 'error')).toBe(true);
  });

  it('validateResponses=false: тело отправляется как есть', async () => {
    const { app, logs } = await build([broken], { validateResponses: false });
    const res = await app.inject({ method: 'GET', url: '/t/out' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: 42 });
    expect(logs().some((l) => l.msg === 'Ответ не соответствует контракту')).toBe(false);
  });

  it('статус без схемы в контракте не проверяется', async () => {
    const { app } = await build([
      route(c, async ({ reply }) => {
        void reply.code(203);
        return { anything: 'goes' };
      }),
    ]);
    const res = await app.inject({ method: 'GET', url: '/t/out' });
    expect(res.statusCode).toBe(203);
    expect(res.json()).toEqual({ anything: 'goes' });
  });
});

describe('registerRoutes: сессионные маршруты', () => {
  const me = contract({
    id: 'testMe',
    method: 'GET',
    path: '/t/me',
    auth: 'session',
    responses: { 200: { description: 'OK' } },
  });
  const write = contract({
    id: 'testWrite',
    method: 'POST',
    path: '/t/write',
    auth: 'session',
    permission: 'groups:write',
    responses: { 200: { description: 'OK' } },
  });
  let handled = 0;
  const routes = [
    route(me, async ({ actor, audit }) => {
      handled++;
      return { actor, auditActor: audit.actorId };
    }),
    route(write, async ({ actor }) => {
      handled++;
      return { by: actor.id };
    }),
  ];

  const editor: FakeUser = {
    id: 'u-editor',
    name: 'Редактор',
    email: 'editor@test',
    disabled: false,
    roles: [{ role: 'editor' }],
  };
  const analyst: FakeUser = { ...editor, id: 'u-analyst', roles: [{ role: 'analyst' }] };
  const blocked: FakeUser = { ...editor, id: 'u-blocked', disabled: true };

  function sessionsWith(entries: Record<string, string>) {
    const s = new FakeSessions();
    for (const [sid, userId] of Object.entries(entries)) {
      s.data.set(sid, { userId, csrfToken: `csrf-${sid}`, createdAt: 0, lastSeenAt: 0, ip: null });
    }
    return s;
  }

  it('без хранилища сессий → 500 internal, обработчик не вызывается', async () => {
    handled = 0;
    const { app, logs } = await build(routes, { sessions: null });
    const res = await app.inject({ method: 'GET', url: '/t/me' });
    expect(res.statusCode).toBe(500);
    expect(res.json<ErrorBody>().error).toEqual({
      code: 'internal',
      message: 'Сессии не настроены',
    });
    expect(handled).toBe(0);
    expect(logs().some((l) => l.msg === 'app error')).toBe(true);
  });

  it('без cookie → 401; неизвестная сессия → 401 «Сессия истекла»', async () => {
    const { app } = await build(routes, { sessions: sessionsWith({}) });
    const noCookie = await app.inject({ method: 'GET', url: '/t/me' });
    expect(noCookie.statusCode).toBe(401);
    expect(noCookie.json<ErrorBody>().error).toEqual({
      code: 'unauthorized',
      message: 'Требуется вход',
    });
    const unknown = await app.inject({
      method: 'GET',
      url: '/t/me',
      headers: { cookie: 'stories_sid=missing' },
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json<ErrorBody>().error.message).toBe('Сессия истекла, войдите снова');
  });

  it('заблокированный или удалённый пользователь → 401, сессия уничтожается', async () => {
    const sessions = sessionsWith({ s1: blocked.id, s2: 'u-deleted' });
    const { app } = await build(routes, { sessions, users: [blocked] });
    for (const sid of ['s1', 's2']) {
      const res = await app.inject({
        method: 'GET',
        url: '/t/me',
        headers: { cookie: `stories_sid=${sid}` },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json<ErrorBody>().error.message).toBe('Учётная запись заблокирована');
    }
    expect(sessions.destroyed).toEqual([
      { sid: 's1', userId: blocked.id },
      { sid: 's2', userId: 'u-deleted' },
    ]);
    expect(sessions.data.size).toBe(0);
  });

  it('GET с сессией: пользователь и роли из хранилища, CSRF не нужен', async () => {
    handled = 0;
    const { app } = await build(routes, {
      sessions: sessionsWith({ s1: editor.id }),
      users: [editor],
    });
    const res = await app.inject({
      method: 'GET',
      url: '/t/me',
      headers: { cookie: 'stories_sid=s1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      actor: { id: editor.id, name: editor.name, email: editor.email, roles: ['editor'] },
      auditActor: editor.id,
    });
    expect(handled).toBe(1);
  });

  it('cookieSecure: принимается только cookie с префиксом __Host-', async () => {
    const { app } = await build(routes, {
      cookieSecure: true,
      sessions: sessionsWith({ s1: editor.id }),
      users: [editor],
    });
    const plain = await app.inject({
      method: 'GET',
      url: '/t/me',
      headers: { cookie: 'stories_sid=s1' },
    });
    expect(plain.statusCode).toBe(401);
    const host = await app.inject({
      method: 'GET',
      url: '/t/me',
      headers: { cookie: '__Host-stories_sid=s1' },
    });
    expect(host.statusCode).toBe(200);
  });

  it('auth: anonymous (вход через SSO) — сессия не нужна, actor = null', async () => {
    const login = contract({
      id: 'testLogin',
      method: 'GET',
      path: '/t/login',
      auth: 'anonymous',
      responses: { 200: { description: 'OK' } },
    });
    const { app } = await build(
      [route(login, async ({ actor, audit }) => ({ actor, auditActor: audit.actorId }))],
      { sessions: sessionsWith({}) },
    );
    // Без cookie сессии: маршрут входа обязан работать до создания сессии.
    const res = await app.inject({ method: 'GET', url: '/t/login' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ actor: null, auditActor: null });
  });

  describe('CSRF для изменяющих запросов', () => {
    async function post(headers: Record<string, string>, user: FakeUser = editor) {
      handled = 0;
      const ctx = await build(routes, { sessions: sessionsWith({ s1: user.id }), users: [user] });
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/t/write',
        headers: { cookie: 'stories_sid=s1', 'x-request-id': REQUEST_ID, ...headers },
      });
      return { ...ctx, res };
    }

    it('верный токен и свой Origin → 200', async () => {
      const { res, siem } = await post({ 'x-csrf-token': 'csrf-s1', origin: ORIGIN });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ by: editor.id });
      expect(siem.events).toEqual([]);
    });

    it('верный токен без Origin, Sec-Fetch-Site: same-origin → 200', async () => {
      const { res, siem } = await post({
        'x-csrf-token': 'csrf-s1',
        'sec-fetch-site': 'same-origin',
      });
      expect(res.statusCode).toBe(200);
      expect(handled).toBe(1);
      expect(siem.events).toEqual([]);
    });

    it('пустой CSRF-токен в сессии не совпадает с пустым заголовком → 403 csrf_failed', async () => {
      handled = 0;
      const sessions = new FakeSessions();
      sessions.data.set('s1', {
        userId: editor.id,
        csrfToken: '',
        createdAt: 0,
        lastSeenAt: 0,
        ip: null,
      });
      const { app, siem } = await build(routes, { sessions, users: [editor] });
      const res = await app.inject({
        method: 'POST',
        url: '/t/write',
        headers: { cookie: 'stories_sid=s1', 'x-csrf-token': '', origin: ORIGIN },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json<ErrorBody>().error.code).toBe('csrf_failed');
      expect(handled).toBe(0);
      expect(siem.events.map((e) => e.type)).toEqual(['csrf.failed']);
    });

    it.each([
      ['без токена', {}, null],
      ['чужой токен', { 'x-csrf-token': 'csrf-other' }, null],
      [
        'чужой Origin',
        { 'x-csrf-token': 'csrf-s1', origin: 'https://evil.test' },
        'https://evil.test',
      ],
      [
        'Sec-Fetch-Site: cross-site',
        { 'x-csrf-token': 'csrf-s1', 'sec-fetch-site': 'cross-site' },
        null,
      ],
    ] as const)('%s → 403 csrf_failed и событие csrf.failed', async (_name, headers, origin) => {
      const { res, siem, forbidden } = await post(headers);
      expect(res.statusCode).toBe(403);
      expect(res.json<ErrorBody>()).toEqual({
        error: { code: 'csrf_failed', message: 'Неверный CSRF-токен' },
        requestId: REQUEST_ID,
      });
      expect(handled).toBe(0);
      expect(forbidden).toEqual(['csrf_failed']);
      expect(siem.events).toEqual([
        expect.objectContaining({
          type: 'csrf.failed',
          actorId: editor.id,
          ip: '127.0.0.1',
          requestId: REQUEST_ID,
          details: { route: '/t/write', origin },
        }),
      ]);
    });

    it.each(['PUT', 'PATCH', 'DELETE'] as const)(
      '%s тоже требует CSRF-токен, как и POST',
      async (method) => {
        const c = contract({
          id: `testMutate${method}`,
          method,
          path: '/t/mutate',
          auth: 'session',
          responses: { 200: { description: 'OK' } },
        });
        const { app, siem, forbidden } = await build(
          [route(c, async ({ actor }) => ({ by: actor.id }))],
          { sessions: sessionsWith({ s1: editor.id }), users: [editor] },
        );
        const forged = await app.inject({
          method,
          url: '/t/mutate',
          headers: { cookie: 'stories_sid=s1' },
        });
        expect(forged.statusCode).toBe(403);
        expect(forged.json<ErrorBody>().error.code).toBe('csrf_failed');
        expect(siem.events.map((e) => e.type)).toEqual(['csrf.failed']);
        expect(forbidden).toEqual(['csrf_failed']);

        const ok = await app.inject({
          method,
          url: '/t/mutate',
          headers: { cookie: 'stories_sid=s1', 'x-csrf-token': 'csrf-s1' },
        });
        expect(ok.statusCode).toBe(200);
        expect(ok.json()).toEqual({ by: editor.id });
      },
    );

    it('нет права из матрицы → 403 forbidden после проверки CSRF', async () => {
      const { res, forbidden, siem } = await post(
        { 'x-csrf-token': 'csrf-s1', origin: ORIGIN },
        analyst,
      );
      expect(res.statusCode).toBe(403);
      expect(res.json<ErrorBody>().error).toEqual({
        code: 'forbidden',
        message: 'Недостаточно прав',
      });
      expect(handled).toBe(0);
      expect(forbidden).toEqual(['forbidden']);
      expect(siem.events).toEqual([]);

      // CSRF проверяется раньше прав: подделанный запрос от пользователя без права
      // всё равно фиксируется как csrf.failed, а не маскируется под обычный forbidden.
      const forged = await post({ origin: 'https://evil.test' }, analyst);
      expect(forged.res.statusCode).toBe(403);
      expect(forged.res.json<ErrorBody>().error.code).toBe('csrf_failed');
      expect(forged.siem.events.map((e) => e.type)).toEqual(['csrf.failed']);
    });
  });
});

describe('installErrorHandler: единый формат ошибок', () => {
  const upload = contract({
    id: 'testUpload',
    method: 'POST',
    path: '/t/upload',
    auth: 'public',
    bodyLimit: 64,
    body: z.object({ text: z.string() }),
    responses: { 200: { description: 'OK' } },
  });
  const boom = contract({
    id: 'testBoom',
    method: 'GET',
    path: '/t/boom/:kind',
    auth: 'public',
    params: z.object({ kind: z.string() }),
    responses: { 200: { description: 'OK' } },
  });
  const failing = route(boom, async ({ params }) => {
    switch (params.kind) {
      case 'rate':
        throw Object.assign(new Error('limit exceeded'), { statusCode: 429 });
      case 'teapot':
        throw Object.assign(new Error('внутренняя деталь 418'), { statusCode: 418 });
      case 'weird-status':
        throw Object.assign(new Error('строковый статус'), { statusCode: '400' });
      case 'app-details':
        throw new AppError(409, 'version_conflict', 'Версия устарела', { expected: 3 });
      case 'app-forbidden':
        throw new AppError(403, 'four_eyes', 'Нельзя согласовать свою группу');
      case 'app-not-found':
        throw notFound();
      default:
        throw new Error('connect ECONNREFUSED db.internal:5432 password=hunter2');
    }
  });

  async function app() {
    return build([route(upload, async ({ body }) => ({ len: body.text.length })), failing]);
  }

  it('тело больше bodyLimit маршрута → 413 payload_too_large', async () => {
    const { app: a } = await app();
    const small = await a.inject({ method: 'POST', url: '/t/upload', payload: { text: 'ok' } });
    expect(small.statusCode).toBe(200);
    const res = await a.inject({
      method: 'POST',
      url: '/t/upload',
      headers: { 'x-request-id': REQUEST_ID },
      payload: { text: 'x'.repeat(200) },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({
      error: { code: 'payload_too_large', message: 'Слишком большой запрос' },
      requestId: REQUEST_ID,
    });
  });

  it('429 → rate_limited', async () => {
    const { app: a } = await app();
    const res = await a.inject({ method: 'GET', url: '/t/boom/rate' });
    expect(res.statusCode).toBe(429);
    expect(res.json<ErrorBody>().error).toEqual({
      code: 'rate_limited',
      message: 'Слишком много запросов',
    });
  });

  it('неподдерживаемый Content-Type → 415 unsupported_media_type', async () => {
    const { app: a } = await app();
    const res = await a.inject({
      method: 'POST',
      url: '/t/upload',
      headers: { 'content-type': 'application/xml' },
      payload: '<text>x</text>',
    });
    expect(res.statusCode).toBe(415);
    expect(res.json<ErrorBody>().error).toEqual({
      code: 'unsupported_media_type',
      message: 'Некорректный запрос',
    });
  });

  it('прочие 4xx (битый JSON, произвольный статус) → bad_request без внутренних деталей', async () => {
    const { app: a } = await app();
    const json = await a.inject({
      method: 'POST',
      url: '/t/upload',
      headers: { 'content-type': 'application/json' },
      payload: '{"text":',
    });
    expect(json.statusCode).toBe(400);
    expect(json.json<ErrorBody>().error).toEqual({
      code: 'bad_request',
      message: 'Некорректный запрос',
    });
    const teapot = await a.inject({ method: 'GET', url: '/t/boom/teapot' });
    expect(teapot.statusCode).toBe(418);
    expect(teapot.json<ErrorBody>().error.code).toBe('bad_request');
    expect(teapot.body).not.toContain('внутренняя деталь');
  });

  it('необработанная ошибка → 500 internal без утечки сообщения, ошибка в логе', async () => {
    const { app: a, logs } = await app();
    const res = await a.inject({
      method: 'GET',
      url: '/t/boom/crash',
      headers: { 'x-request-id': REQUEST_ID },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: { code: 'internal', message: 'Внутренняя ошибка' },
      requestId: REQUEST_ID,
    });
    expect(res.body).not.toMatch(/ECONNREFUSED|hunter2|db\.internal/);
    const logged = logs().find((l) => l.msg === 'unhandled error');
    expect(logged?.level).toBe('error');
    expect(JSON.stringify(logged)).toContain('ECONNREFUSED');
  });

  it('нечисловой statusCode ошибки → 500 internal', async () => {
    const { app: a } = await app();
    const res = await a.inject({ method: 'GET', url: '/t/boom/weird-status' });
    expect(res.statusCode).toBe(500);
    expect(res.json<ErrorBody>().error.code).toBe('internal');
  });

  it('AppError: details передаются, 403 вызывает хук onForbidden', async () => {
    const { app: a, forbidden } = await app();
    const missing = await a.inject({ method: 'GET', url: '/t/boom/app-not-found' });
    expect(missing.statusCode).toBe(404);
    // Без details ключ не добавляется вовсе.
    expect(missing.json<ErrorBody>().error).toEqual({ code: 'not_found', message: 'Не найдено' });
    const conflict = await a.inject({ method: 'GET', url: '/t/boom/app-details' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<ErrorBody>().error).toEqual({
      code: 'version_conflict',
      message: 'Версия устарела',
      details: { expected: 3 },
    });
    expect(forbidden).toEqual([]);
    const denied = await a.inject({ method: 'GET', url: '/t/boom/app-forbidden' });
    expect(denied.statusCode).toBe(403);
    expect(denied.json<ErrorBody>().error).toEqual({
      code: 'four_eyes',
      message: 'Нельзя согласовать свою группу',
    });
    expect(forbidden).toEqual(['four_eyes']);
  });

  it('неизвестный маршрут → 404 not_found', async () => {
    const { app: a } = await app();
    const res = await a.inject({
      method: 'GET',
      url: '/t/nowhere',
      headers: { 'x-request-id': REQUEST_ID },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: 'not_found', message: 'Не найдено' },
      requestId: REQUEST_ID,
    });
  });
});
