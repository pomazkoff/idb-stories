import { ru } from '../i18n/ru.js';

/**
 * HTTP-клиент admin API (раздел 6, 10.2).
 * - Тот же origin, cookie сессии HttpOnly — JS её не видит, отправляется браузером (`same-origin`).
 * - Каждый изменяющий запрос несёт X-CSRF-Token из /auth/me.
 * - 401 — сессии нет или она истекла: полный переход на SSO с возвратом на текущую страницу.
 */

export const API_BASE = '/admin/v1';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const MUTATING: ReadonlySet<HttpMethod> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown = undefined,
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

// ---------------------------------------------------------------------------
// CSRF-токен (синхронизирующий токен из сессии)
// ---------------------------------------------------------------------------

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

// ---------------------------------------------------------------------------
// Вход
// ---------------------------------------------------------------------------

/** Только относительный путь внутри админки — как и на сервере (защита от open redirect). */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\s]/.test(value)) return '/';
  if (value.startsWith('/login') || value.startsWith(API_BASE)) return '/';
  return value;
}

export function loginUrl(returnTo: string): string {
  return `${API_BASE}/auth/login?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`;
}

export function currentPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}

type Navigate = (url: string) => void;
const assign: Navigate = (url) => window.location.assign(url);

const LOGIN_ATTEMPT_KEY = 'idbs.loginAttemptAt';
/** Повторный 401 вскоре после входа — признак цикла (cookie не сохранилась): показываем /login. */
const LOGIN_LOOP_WINDOW_MS = 15_000;

function readLoginAttempt(): number {
  try {
    return Number(window.sessionStorage.getItem(LOGIN_ATTEMPT_KEY)) || 0;
  } catch {
    return 0;
  }
}

function writeLoginAttempt(): void {
  try {
    window.sessionStorage.setItem(LOGIN_ATTEMPT_KEY, String(Date.now()));
  } catch {
    // sessionStorage может быть недоступен — защита от цикла тогда не работает, вход всё равно возможен.
  }
}

/** Полный переход на SSO (кнопка «Войти»). */
export function startLogin(returnTo: string, navigate: Navigate = assign): void {
  writeLoginAttempt();
  navigate(loginUrl(returnTo));
}

/** Реакция на 401 по умолчанию. */
export function redirectToLogin(navigate: Navigate = assign): void {
  if (window.location.pathname === '/login') return;
  const returnTo = currentPath();
  if (Date.now() - readLoginAttempt() < LOGIN_LOOP_WINDOW_MS) {
    navigate(`/login?error=loop&returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`);
    return;
  }
  startLogin(returnTo, navigate);
}

let unauthorizedHandler: () => void = () => redirectToLogin();

/** Для тестов: подменить реакцию на 401. Возвращает функцию восстановления. */
export function setUnauthorizedHandler(handler: () => void): () => void {
  const previous = unauthorizedHandler;
  unauthorizedHandler = handler;
  return () => {
    unauthorizedHandler = previous;
  };
}

// ---------------------------------------------------------------------------
// Запросы
// ---------------------------------------------------------------------------

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, QueryValue>;
  signal?: AbortSignal;
  /** Не уводить на SSO при 401 (выход, фоновые проверки). */
  noAuthRedirect?: boolean;
}

export function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return `${API_BASE}${path}${qs ? `?${qs}` : ''}`;
}

interface ErrorBody {
  error?: { code?: unknown; message?: unknown; details?: unknown };
  requestId?: unknown;
}

async function toApiError(res: Response): Promise<ApiError> {
  let body: ErrorBody | null;
  try {
    body = (await res.json()) as ErrorBody;
  } catch {
    body = null;
  }
  const err = body?.error;
  const code = typeof err?.code === 'string' ? err.code : 'http_error';
  const message = typeof err?.message === 'string' && err.message ? err.message : ru.errors.http(res.status);
  const requestId = typeof body?.requestId === 'string' ? body.requestId : null;
  return new ApiError(res.status, code, message, err?.details, requestId);
}

interface MeLike {
  csrfToken: string;
}

/** Перечитать CSRF-токен из /auth/me (например, после перезапуска сессии на сервере). */
export async function refreshCsrfToken(): Promise<void> {
  const me = await request<MeLike>('GET', '/auth/me');
  setCsrfToken(me.csrfToken);
}

export async function request<T>(
  method: HttpMethod,
  path: string,
  options: RequestOptions = {},
  isRetry = false,
): Promise<T> {
  const mutating = MUTATING.has(method);
  if (mutating && !csrfToken) await refreshCsrfToken();

  const headers: Record<string, string> = { Accept: 'application/json' };
  const init: RequestInit = { method, headers, credentials: 'same-origin', cache: 'no-store' };
  if (options.signal) init.signal = options.signal;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  if (mutating && csrfToken) headers['X-CSRF-Token'] = csrfToken;

  let res: Response;
  try {
    res = await fetch(buildUrl(path, options.query), init);
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new ApiError(0, 'network', ru.errors.network);
  }

  if (res.status === 401) {
    const error = await toApiError(res);
    if (!options.noAuthRedirect) unauthorizedHandler();
    throw error;
  }
  if (!res.ok) {
    const error = await toApiError(res);
    if (res.status === 403 && error.code === 'csrf_failed' && mutating && !isRetry) {
      await refreshCsrfToken();
      return request<T>(method, path, options, true);
    }
    throw error;
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(res.status, 'invalid_response', ru.errors.unexpected);
  }
}
