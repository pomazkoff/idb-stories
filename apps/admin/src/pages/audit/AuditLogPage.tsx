import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { api } from '../../api/endpoints.js';
import { qk } from '../../api/queries.js';
import type { AuditEntry, AuditParams } from '../../api/types.js';
import { useCan } from '../../auth/session.js';
import { Loading, PageHeader, QueryError } from '../../components/Status.js';
import { ru } from '../../i18n/ru.js';
import { dateEndExclusiveIso, dateStartIso, formatDateTimeSeconds } from '../../lib/datetime.js';

const PAGE_SIZE = 50;

interface AuditFilters {
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  from: string;
  to: string;
}

const EMPTY: AuditFilters = { actorId: '', action: '', entityType: '', entityId: '', from: '', to: '' };

function toParams(f: AuditFilters): AuditParams {
  return {
    actorId: f.actorId || undefined,
    action: f.action || undefined,
    entityType: f.entityType || undefined,
    entityId: f.entityId.trim() || undefined,
    from: f.from ? (dateStartIso(f.from) ?? undefined) : undefined,
    to: f.to ? (dateEndExclusiveIso(f.to) ?? undefined) : undefined,
  };
}

/** Журнал аудита (только администратор): фильтры, таблица, подгрузка «Показать ещё». */
export function AuditLogPage() {
  const [filters, setFilters] = useState<AuditFilters>(EMPTY);
  const query = useInfiniteQuery({
    queryKey: [...qk.audit, filters],
    queryFn: ({ pageParam, signal }) => api.auditLog({ ...toParams(filters), limit: PAGE_SIZE, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="stack">
      <title>{ru.app.pageTitle(ru.audit.title)}</title>
      <PageHeader title={ru.audit.title} />
      <AuditFiltersForm initial={filters} onApply={setFilters} />
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <QueryError error={query.error} onRetry={() => void query.refetch()} />
      ) : items.length === 0 ? (
        <p className="empty">{ru.audit.empty}</p>
      ) : (
        <AuditTable items={items} />
      )}
      {query.hasNextPage ? (
        <div>
          <button type="button" className="btn" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
            {query.isFetchingNextPage ? ru.common.loadingMore : ru.common.showMore}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function AuditFiltersForm({ initial, onApply }: { initial: AuditFilters; onApply: (f: AuditFilters) => void }) {
  const can = useCan();
  const id = useId();
  const [draft, setDraft] = useState(initial);
  const users = useQuery({ queryKey: qk.users, queryFn: ({ signal }) => api.users(signal), enabled: can('users:read') });
  const set = (patch: Partial<AuditFilters>) => setDraft((d) => ({ ...d, ...patch }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onApply(draft);
  };

  return (
    <form className="filters card" onSubmit={submit} aria-label={ru.audit.filters} role="search">
      <div className="field">
        <label className="field__label" htmlFor={`${id}-actor`}>
          {ru.audit.actor}
        </label>
        <select id={`${id}-actor`} value={draft.actorId} onChange={(e) => set({ actorId: e.target.value })}>
          <option value="">{ru.audit.anyActor}</option>
          {(users.data?.items ?? []).map((u) => (
            <option key={u.id} value={u.id}>
              {u.name} ({u.email})
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="field__label" htmlFor={`${id}-action`}>
          {ru.audit.action}
        </label>
        <select id={`${id}-action`} value={draft.action} onChange={(e) => set({ action: e.target.value })}>
          <option value="">{ru.audit.anyAction}</option>
          {Object.entries(ru.audit.actions).map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="field__label" htmlFor={`${id}-type`}>
          {ru.audit.entityType}
        </label>
        <select id={`${id}-type`} value={draft.entityType} onChange={(e) => set({ entityType: e.target.value })}>
          <option value="">{ru.audit.anyEntity}</option>
          {Object.entries(ru.audit.entityTypes).map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="field__label" htmlFor={`${id}-entity`}>
          {ru.audit.entityId}
        </label>
        <input
          id={`${id}-entity`}
          type="text"
          value={draft.entityId}
          maxLength={100}
          spellCheck={false}
          onChange={(e) => set({ entityId: e.target.value })}
        />
      </div>
      <div className="field">
        <label className="field__label" htmlFor={`${id}-from`}>
          {ru.audit.from}
        </label>
        <input id={`${id}-from`} type="date" value={draft.from} onChange={(e) => set({ from: e.target.value })} />
      </div>
      <div className="field">
        <label className="field__label" htmlFor={`${id}-to`}>
          {ru.audit.to}
        </label>
        <input id={`${id}-to`} type="date" value={draft.to} onChange={(e) => set({ to: e.target.value })} />
      </div>
      <div className="field field--end">
        <div className="actions">
          <button type="submit" className="btn btn--primary">
            {ru.common.apply}
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              setDraft(EMPTY);
              onApply(EMPTY);
            }}
          >
            {ru.common.reset}
          </button>
        </div>
      </div>
    </form>
  );
}

function diffText(diff: unknown): string | null {
  if (diff === null || diff === undefined) return null;
  try {
    return JSON.stringify(diff, null, 2);
  } catch {
    return null;
  }
}

function AuditTable({ items }: { items: AuditEntry[] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="sr-only">{ru.audit.caption}</caption>
        <thead>
          <tr>
            <th scope="col">{ru.audit.colTime}</th>
            <th scope="col">{ru.audit.colActor}</th>
            <th scope="col">{ru.audit.colAction}</th>
            <th scope="col">{ru.audit.colEntity}</th>
            <th scope="col">{ru.audit.colIp}</th>
            <th scope="col">{ru.audit.colDiff}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((entry) => {
            const diff = diffText(entry.diff);
            return (
              <tr key={entry.id}>
                <td className="nowrap">{formatDateTimeSeconds(entry.ts)}</td>
                <td>{entry.actor?.name ?? ru.audit.system}</td>
                <td>
                  {ru.audit.actions[entry.action] ?? entry.action}
                  <div className="muted small mono">{entry.action}</div>
                </td>
                <td>
                  {ru.audit.entityTypes[entry.entityType] ?? entry.entityType}
                  {entry.entityId ? <div className="muted small mono break">{entry.entityId}</div> : null}
                </td>
                <td className="mono small">
                  {entry.ip ?? ru.common.dash}
                  {entry.requestId ? <div className="muted break">{ru.audit.requestId(entry.requestId)}</div> : null}
                </td>
                <td>
                  {diff ? (
                    <details>
                      <summary>{ru.audit.showDiff}</summary>
                      <pre className="code">{diff}</pre>
                    </details>
                  ) : (
                    ru.common.dash
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
