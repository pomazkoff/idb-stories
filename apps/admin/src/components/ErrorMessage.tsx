import { isApiError } from '../api/client.js';
import { UploadError } from '../api/upload.js';
import { ru } from '../i18n/ru.js';

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

interface ErrorDetails {
  title: string | null;
  items: string[];
}

/** Списки из details: not_ready → problems, cta_not_allowed → problems/slides, validation_error → поля. */
export function errorDetails(error: unknown, slideIds: readonly string[] = []): ErrorDetails {
  if (!isApiError(error)) return { title: null, items: [] };
  const details = (error.details ?? null) as Record<string, unknown> | unknown[] | null;
  switch (error.code) {
    case 'not_ready':
      return {
        title: ru.errors.notReady,
        items: details && !Array.isArray(details) ? stringList(details.problems) : [],
      };
    case 'cta_not_allowed': {
      if (!details || Array.isArray(details)) return { title: null, items: [] };
      const problems = stringList(details.problems);
      const slides = stringList(details.slides).map((id) => {
        const index = slideIds.indexOf(id);
        return index >= 0 ? ru.slides.number(index + 1) : id;
      });
      const items = [...problems, ...slides];
      return { title: items.length > 0 ? ru.errors.ctaProblems : null, items };
    }
    case 'invalid_allowlist':
      return { title: null, items: details && !Array.isArray(details) ? stringList(details.errors) : [] };
    case 'validation_error': {
      if (!Array.isArray(details)) return { title: null, items: [] };
      const items = details.flatMap((d) => {
        if (!d || typeof d !== 'object') return [];
        const { path, message } = d as { path?: unknown; message?: unknown };
        if (typeof message !== 'string') return [];
        return [typeof path === 'string' && path ? `${path}: ${message}` : message];
      });
      return { title: items.length > 0 ? ru.errors.fieldIssues : null, items };
    }
    default:
      return { title: null, items: [] };
  }
}

export function errorText(error: unknown): string {
  if (isApiError(error)) return error.message;
  if (error instanceof UploadError) return error.message;
  return ru.errors.unexpected;
}

export interface ErrorMessageProps {
  error: unknown;
  /** Для revision_mismatch — перечитать группу. */
  onReload?: () => void;
  /** Порядок слайдов — чтобы показать «Слайд N» вместо id. */
  slideIds?: readonly string[];
  /** Не показывать список ошибок полей (они уже показаны у полей). */
  hideFieldList?: boolean;
}

/** Ошибка API: сообщение сервера (на русском), списки из details, кнопка перезагрузки при конфликте версий. */
export function ErrorMessage({ error, onReload, slideIds, hideFieldList = false }: ErrorMessageProps) {
  if (!error) return null;
  const api = isApiError(error) ? error : null;
  const { title, items } = errorDetails(error, slideIds);
  const showList = items.length > 0 && !(hideFieldList && api?.code === 'validation_error');
  return (
    <div className="alert alert--error" role="alert">
      <p className="alert__text">{errorText(error)}</p>
      {api?.code === 'validation_error' && hideFieldList ? <p className="alert__text">{ru.errors.fixFields}</p> : null}
      {showList ? (
        <>
          {title ? <p className="alert__text">{title}</p> : null}
          <ul className="alert__list">
            {items.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </>
      ) : null}
      {api?.code === 'revision_mismatch' ? (
        <p className="alert__text">
          {ru.errors.revisionMismatch}{' '}
          {onReload ? (
            <button type="button" className="btn btn--small" onClick={onReload}>
              {ru.errors.reloadGroup}
            </button>
          ) : null}
        </p>
      ) : null}
      {api?.requestId ? <p className="alert__meta">{ru.common.requestId(api.requestId)}</p> : null}
    </div>
  );
}
