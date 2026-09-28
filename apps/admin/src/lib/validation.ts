import { ru } from '../i18n/ru.js';
import { isApiError } from '../api/client.js';

/**
 * Клиентская проверка форм теми же zod-схемами, что и на сервере (@idb-stories/schema).
 * Сообщения схем уже на русском; для стандартных проверок zod подставляем русский текст.
 */

export type FieldErrors = Record<string, string>;

interface Issue {
  path: readonly PropertyKey[];
  message: string;
}

type SafeResult<T> = { success: true; data: T } | { success: false; error: { issues: readonly Issue[] } };

interface RawIssue {
  code?: string;
  origin?: string;
  minimum?: unknown;
  maximum?: unknown;
  input?: unknown;
}

interface ParseSchema<T> {
  safeParse(data: unknown, params?: { error?: (issue: RawIssue) => string | undefined }): SafeResult<T>;
}

function russianIssue(issue: RawIssue): string | undefined {
  const limit = (v: unknown) => (typeof v === 'number' || typeof v === 'bigint' ? String(v) : '');
  switch (issue.code) {
    case 'invalid_type':
      return issue.input === undefined || issue.input === null ? ru.validation.required : ru.validation.invalid;
    case 'too_small':
      if (issue.origin === 'string') {
        const min = Number(limit(issue.minimum));
        return min <= 1 ? ru.validation.required : ru.validation.tooShort(min);
      }
      if (issue.origin === 'array' || issue.origin === 'set') return ru.validation.tooFewItems(limit(issue.minimum));
      return ru.validation.tooSmall(limit(issue.minimum));
    case 'too_big':
      if (issue.origin === 'string') return ru.validation.tooLong(Number(limit(issue.maximum)));
      if (issue.origin === 'array' || issue.origin === 'set') return ru.validation.tooManyItems(limit(issue.maximum));
      return ru.validation.tooBig(limit(issue.maximum));
    case 'invalid_format':
      return ru.validation.invalidFormat;
    default:
      return ru.validation.invalid;
  }
}

export function pathKey(path: readonly PropertyKey[]): string {
  return path.map((p) => (typeof p === 'symbol' ? '' : String(p))).join('.');
}

export type Validated<T> = { ok: true; data: T } | { ok: false; errors: FieldErrors };

export function validate<T>(schema: ParseSchema<T>, data: unknown): Validated<T> {
  const res = schema.safeParse(data, { error: russianIssue });
  if (res.success) return { ok: true, data: res.data };
  const errors: FieldErrors = {};
  for (const issue of res.error.issues) {
    const key = pathKey(issue.path);
    errors[key] ??= issue.message;
  }
  return { ok: false, errors };
}

/** Ошибки полей из ответа сервера `validation_error` (details: [{ path, message }]). */
export function serverFieldErrors(error: unknown): FieldErrors {
  if (!isApiError(error) || error.code !== 'validation_error' || !Array.isArray(error.details)) return {};
  const errors: FieldErrors = {};
  for (const item of error.details as unknown[]) {
    if (item && typeof item === 'object') {
      const { path, message } = item as { path?: unknown; message?: unknown };
      if (typeof path === 'string' && typeof message === 'string') errors[path] ??= message;
    }
  }
  return errors;
}

/** Ошибки для поля и всех вложенных путей (например, `minAppVersion` и `minAppVersion.ios`). */
export function errorFor(errors: FieldErrors, key: string): string | undefined {
  if (errors[key]) return errors[key];
  const nested = Object.keys(errors).find((k) => k.startsWith(`${key}.`));
  return nested ? errors[nested] : undefined;
}
