import { afterEach, describe, expect, it, vi } from 'vitest';
import { CSRF, makeGroup, makeMe, mockApi, uuid } from '../test/utils.js';
import {
  ApiError,
  loginUrl,
  redirectToLogin,
  safeReturnTo,
  setCsrfToken,
  setUnauthorizedHandler,
  startLogin,
} from './client.js';
import { api } from './endpoints.js';

const GROUP = uuid(100);

afterEach(() => {
  window.sessionStorage.clear();
});

describe('API-клиент', () => {
  it('изменяющий запрос отправляет X-CSRF-Token и cookie только same-origin', async () => {
    const { fetchMock, requests } = mockApi({
      'POST /admin/v1/groups/:id/submit': () => ({ body: makeGroup({ status: 'in_review' }) }),
    });
    setCsrfToken(CSRF);

    const group = await api.submit(GROUP, 3);

    expect(group.status).toBe('in_review');
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.credentials).toBe('same-origin');
    expect(requests[0]!.headers.get('X-CSRF-Token')).toBe(CSRF);
    expect(requests[0]!.headers.get('Content-Type')).toBe('application/json');
    expect(requests[0]!.body).toEqual({ revision: 3 });
  });

  it.each([
    ['PATCH', () => api.updateGroup(GROUP, { revision: 1, title: 'x' }), `PATCH /admin/v1/groups/:id`],
    ['PUT', () => api.reorderSlides(GROUP, 1, [uuid(1)]), 'PUT /admin/v1/groups/:id/slides/order'],
    ['DELETE', () => api.deleteGroup(GROUP), 'DELETE /admin/v1/groups/:id'],
  ] as const)('%s тоже с CSRF-токеном', async (_method, call, route) => {
    const { requests } = mockApi({ [route]: () => ({ status: 200, body: makeGroup() }) });
    setCsrfToken(CSRF);
    await call();
    expect(requests[0]!.headers.get('X-CSRF-Token')).toBe(CSRF);
  });

  it('GET не отправляет CSRF-токен', async () => {
    const { requests, fetchMock } = mockApi({ 'GET /admin/v1/groups/:id': () => ({ body: makeGroup() }) });
    setCsrfToken(CSRF);
    await api.getGroup(GROUP);
    expect(requests[0]!.headers.get('X-CSRF-Token')).toBeNull();
    expect(fetchMock.mock.calls[0]![1]?.credentials).toBe('same-origin');
  });

  it('без токена сначала запрашивает /auth/me', async () => {
    const { requests } = mockApi({
      'GET /admin/v1/auth/me': () => ({ body: makeMe(['editor']) }),
      'POST /admin/v1/groups/:id/duplicate': () => ({ status: 201, body: makeGroup() }),
    });
    await api.duplicateGroup(GROUP);
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /admin/v1/auth/me',
      `POST /admin/v1/groups/${GROUP}/duplicate`,
    ]);
    expect(requests[1]!.headers.get('X-CSRF-Token')).toBe(CSRF);
    // Тело не отправляется — и Content-Type тоже (иначе Fastify ответит 400 на пустой JSON).
    expect(requests[1]!.headers.get('Content-Type')).toBeNull();
  });

  it('при csrf_failed перечитывает токен и повторяет запрос один раз', async () => {
    let attempts = 0;
    const { requests } = mockApi({
      'GET /admin/v1/auth/me': () => ({ body: { ...makeMe(['editor']), csrfToken: 'fresh' } }),
      'POST /admin/v1/groups/:id/publish': (req) => {
        attempts += 1;
        return req.headers.get('X-CSRF-Token') === 'fresh'
          ? { body: makeGroup() }
          : { status: 403, body: { error: { code: 'csrf_failed', message: 'Неверный CSRF-токен' } } };
      },
    });
    setCsrfToken('stale');
    await api.publish(GROUP);
    expect(attempts).toBe(2);
    expect(requests.at(-1)!.headers.get('X-CSRF-Token')).toBe('fresh');
  });

  it('401 — вызывает переход на вход и бросает ApiError', async () => {
    mockApi({
      'GET /admin/v1/groups': () => ({ status: 401, body: { error: { code: 'unauthorized', message: 'Требуется вход' } } }),
    });
    const onUnauthorized = vi.fn();
    const restore = setUnauthorizedHandler(onUnauthorized);
    try {
      await expect(api.listGroups({})).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('по умолчанию 401 уводит на SSO с возвратом на текущую страницу', () => {
    window.history.replaceState(null, '', '/groups?status=draft');
    const navigate = vi.fn();
    redirectToLogin(navigate);
    expect(navigate).toHaveBeenCalledWith(`/admin/v1/auth/login?returnTo=${encodeURIComponent('/groups?status=draft')}`);
  });

  it('повторный 401 сразу после входа не зацикливает SSO — показывает /login', () => {
    window.history.replaceState(null, '', '/groups');
    const navigate = vi.fn();
    startLogin('/groups', navigate);
    redirectToLogin(navigate);
    expect(navigate).toHaveBeenLastCalledWith(`/login?error=loop&returnTo=${encodeURIComponent('/groups')}`);
  });

  it('на странице /login 401 не вызывает переход', () => {
    window.history.replaceState(null, '', '/login');
    const navigate = vi.fn();
    redirectToLogin(navigate);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('returnTo — только относительный путь внутри админки', () => {
    expect(safeReturnTo('https://evil.example/')).toBe('/');
    expect(safeReturnTo('//evil.example/')).toBe('/');
    expect(safeReturnTo('/\\evil')).toBe('/');
    expect(safeReturnTo('/groups/1')).toBe('/groups/1');
    expect(loginUrl('/review')).toBe('/admin/v1/auth/login?returnTo=%2Freview');
  });

  it('ошибка API содержит code, message, details и requestId', async () => {
    mockApi({
      'POST /admin/v1/groups/:id/submit': () => ({
        status: 409,
        body: {
          error: { code: 'not_ready', message: 'Группа не готова к согласованию', details: { problems: ['Обложка'] } },
          requestId: 'req-1',
        },
      }),
    });
    setCsrfToken(CSRF);
    const error = await api.submit(GROUP, 1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: 'not_ready',
      message: 'Группа не готова к согласованию',
      details: { problems: ['Обложка'] },
      requestId: 'req-1',
    });
  });

  it('сетевая ошибка превращается в ApiError с понятным сообщением', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(api.settings()).rejects.toMatchObject({ status: 0, code: 'network' });
  });
});
