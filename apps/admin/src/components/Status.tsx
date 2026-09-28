import type { ReactNode } from 'react';
import { ru } from '../i18n/ru.js';
import { ErrorMessage } from './ErrorMessage.js';

export function Loading({ label = ru.app.loading }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function QueryError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="stack">
      <ErrorMessage error={error} />
      {onRetry ? (
        <div>
          <button type="button" className="btn" onClick={onRetry}>
            {ru.common.retry}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Короткое уведомление об успешном действии (озвучивается скринридером). */
export function Notice({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div className="alert alert--success" role="status">
      {children}
    </div>
  );
}

export function PageHeader({ title, actions, children }: { title: string; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-header">
      <div className="page-header__main">
        <h1 className="page-title">{title}</h1>
        {children}
      </div>
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </div>
  );
}
