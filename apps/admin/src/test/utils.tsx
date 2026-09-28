import { permissionsOf, type Role } from '@idb-stories/schema';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, type RenderResult } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, vi } from 'vitest';
import { setCsrfToken, setUnauthorizedHandler } from '../api/client.js';
import type { AdminGroup, Me, SettingsDto } from '../api/types.js';
import { createRoutes } from '../router.js';

const restorers: (() => void)[] = [];

// vitest без globals: чистим DOM вручную.
afterEach(() => {
  cleanup();
  restorers.splice(0).forEach((restore) => restore());
  setCsrfToken(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

export const CSRF = 'csrf-test-token';

export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

export function makeMe(roles: Role[], id = uuid(1)): Me {
  return {
    user: {
      id,
      email: 'user@idb.local',
      name: 'Тест Пользователь',
      roles,
      disabled: false,
      lastLoginAt: null,
      createdAt: '2026-09-01T00:00:00.000Z',
    },
    permissions: permissionsOf(roles),
    csrfToken: CSRF,
    sessionExpiresAt: '2026-09-28T20:00:00.000Z',
  };
}

export const SETTINGS: SettingsDto = {
  feedEnabled: true,
  ctaAllowlist: { deeplinkSchemes: ['idb'], urlDomains: ['iledebeaute.ru'] },
};

export function makeGroup(overrides: Partial<AdminGroup> = {}): AdminGroup {
  return {
    id: uuid(100),
    title: 'Осенняя коллекция',
    placement: 'home',
    priority: 0,
    startAt: '2026-10-01T09:00:00.000Z',
    endAt: '2026-10-08T09:00:00.000Z',
    platforms: ['ios', 'android', 'web'],
    status: 'draft',
    revision: 3,
    liveVersion: null,
    pendingVersion: null,
    schedule: 'not_published',
    slidesCount: 1,
    coverAssetId: null,
    updatedAt: '2026-09-28T10:00:00.000Z',
    updatedBy: { id: uuid(1), name: 'Ева Редактор' },
    minAppVersion: { ios: null, android: null },
    segmentIds: [],
    createdAt: '2026-09-27T10:00:00.000Z',
    createdBy: { id: uuid(1), name: 'Ева Редактор' },
    lastEditedBy: { id: uuid(1), name: 'Ева Редактор' },
    submittedAt: null,
    submittedBy: null,
    reviewedAt: null,
    reviewedBy: null,
    reviewComment: null,
    slides: [
      {
        id: uuid(201),
        position: 0,
        type: 'product',
        durationMs: 6000,
        mediaAssetId: null,
        productSkus: ['SKU1'],
        elements: [{ kind: 'text', text: 'Новинки сезона', style: 'title', position: 'top' }],
        cta: null,
      },
    ],
    actions: {
      canEdit: true,
      canSubmit: true,
      canApprove: false,
      canReject: false,
      canPublish: false,
      canUnpublish: false,
      approveBlockedReason: null,
    },
    ...overrides,
  };
}

export const EMPTY_PREVIEW = {
  feed: { schema_version: 1, generated_at: '2026-09-28T10:00:00.000Z', ttl_sec: 60, groups: [] },
  mediaOrigins: [],
  warnings: [],
};

export interface MockRequest {
  method: string;
  path: string;
  url: URL;
  headers: Headers;
  body: unknown;
  params: Record<string, string>;
}

export interface MockReply {
  status?: number;
  body?: unknown;
}

type Handler = (req: MockRequest) => MockReply | Promise<MockReply>;

function compile(pattern: string): { method: string; re: RegExp; names: string[] } {
  const [method = 'GET', path = '/'] = pattern.split(' ');
  const names: string[] = [];
  const source = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, (_, name: string) => {
    names.push(name);
    return '([^/]+)';
  });
  return { method, re: new RegExp(`^${source}$`), names };
}

/**
 * Подменяет fetch: ключи вида `GET /admin/v1/groups/:id`. Неизвестный маршрут — 404 в формате API.
 * Возвращает vi.fn с историей вызовов и список разобранных запросов.
 */
export function mockApi(routes: Record<string, Handler>) {
  const compiled = Object.entries(routes).map(([pattern, handler]) => ({ ...compile(pattern), handler }));
  const requests: MockRequest[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    for (const route of compiled) {
      if (route.method !== method) continue;
      const m = route.re.exec(url.pathname);
      if (!m) continue;
      const params = Object.fromEntries(route.names.map((n, i) => [n, decodeURIComponent(m[i + 1] ?? '')]));
      const req: MockRequest = { method, path: url.pathname, url, headers, body, params };
      requests.push(req);
      const reply = await route.handler(req);
      const status = reply.status ?? 200;
      return new Response(status === 204 ? null : JSON.stringify(reply.body ?? {}), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    requests.push({ method, path: url.pathname, url, headers, body, params: {} });
    return new Response(JSON.stringify({ error: { code: 'not_found', message: 'Не найдено' } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, requests };
}

/** Рендер всего приложения (маршруты, React Query) на заданном адресе. */
export interface RenderedApp extends RenderResult {
  router: ReturnType<typeof createMemoryRouter>;
  client: QueryClient;
}

export function renderApp(path: string): RenderedApp {
  restorers.push(setUnauthorizedHandler(() => {}));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(createRoutes(), { initialEntries: [path] });
  const utils = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...utils, router, client };
}
