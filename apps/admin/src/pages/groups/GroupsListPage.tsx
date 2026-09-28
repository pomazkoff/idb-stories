import {
  GROUP_STATUSES,
  PLACEMENTS,
  type GroupStatus,
  type Placement,
  type ScheduleState,
} from '@idb-stories/schema';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../../api/endpoints.js';
import { qk } from '../../api/queries.js';
import type { AdminGroupSummary } from '../../api/types.js';
import { useCan } from '../../auth/session.js';
import { ScheduleBadge, StatusBadge } from '../../components/Badges.js';
import { Period } from '../../components/Period.js';
import { Loading, PageHeader, QueryError } from '../../components/Status.js';
import { ru } from '../../i18n/ru.js';
import { dateEndExclusiveIso, dateStartIso, formatDateTime } from '../../lib/datetime.js';

const PAGE_SIZE = 20;
const SCHEDULES: readonly ScheduleState[] = ['live', 'scheduled', 'expired', 'not_published'];

interface Filters {
  status: string;
  placement: string;
  schedule: string;
  from: string;
  to: string;
  q: string;
}

const FILTER_KEYS = ['status', 'placement', 'schedule', 'from', 'to', 'q'] as const;

function readFilters(params: URLSearchParams): Filters {
  const get = (k: string) => params.get(k) ?? '';
  const status = get('status');
  const placement = get('placement');
  const schedule = get('schedule');
  return {
    status: (GROUP_STATUSES as readonly string[]).includes(status) ? status : '',
    placement: (PLACEMENTS as readonly string[]).includes(placement) ? placement : '',
    schedule: (SCHEDULES as readonly string[]).includes(schedule) ? schedule : '',
    from: get('from'),
    to: get('to'),
    q: get('q').slice(0, 100),
  };
}

export function GroupsListPage() {
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const filters = readFilters(params);
  const hasFilters = FILTER_KEYS.some((k) => filters[k] !== '');

  const setFilter = (key: keyof Filters, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const query = useInfiniteQuery({
    queryKey: [...qk.groups, 'list', filters],
    queryFn: ({ pageParam, signal }) =>
      api.listGroups(
        {
          status: filters.status || undefined,
          placement: filters.placement || undefined,
          schedule: filters.schedule || undefined,
          from: filters.from ? (dateStartIso(filters.from) ?? undefined) : undefined,
          to: filters.to ? (dateEndExclusiveIso(filters.to) ?? undefined) : undefined,
          q: filters.q || undefined,
          limit: PAGE_SIZE,
          cursor: pageParam,
        },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="stack">
      <title>{ru.app.pageTitle(ru.groups.title)}</title>
      <PageHeader
        title={ru.groups.title}
        actions={
          can('groups:write') ? (
            <Link to="/groups/new" className="btn btn--primary">
              {ru.groups.create}
            </Link>
          ) : null
        }
      />
      <GroupFilters
        filters={filters}
        onChange={setFilter}
        onReset={() => setParams(new URLSearchParams(), { replace: true })}
        hasFilters={hasFilters}
      />
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <QueryError error={query.error} onRetry={() => void query.refetch()} />
      ) : items.length === 0 ? (
        <p className="empty">{hasFilters ? ru.groups.emptyFiltered : ru.groups.empty}</p>
      ) : (
        <>
          <GroupsTable items={items} showStats={can('stats:read')} />
          {query.hasNextPage ? (
            <div>
              <button
                type="button"
                className="btn"
                onClick={() => void query.fetchNextPage()}
                disabled={query.isFetchingNextPage}
              >
                {query.isFetchingNextPage ? ru.common.loadingMore : ru.common.showMore}
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

interface GroupFiltersProps {
  filters: Filters;
  onChange: (key: keyof Filters, value: string) => void;
  onReset: () => void;
  hasFilters: boolean;
}

function GroupFilters({ filters, onChange, onReset, hasFilters }: GroupFiltersProps) {
  const ids = {
    status: useId(),
    placement: useId(),
    schedule: useId(),
    from: useId(),
    to: useId(),
  };

  return (
    <div className="filters card" role="search" aria-label={ru.groups.filters}>
      <div className="field">
        <label className="field__label" htmlFor={ids.status}>
          {ru.groups.filterStatus}
        </label>
        <select id={ids.status} value={filters.status} onChange={(e) => onChange('status', e.target.value)}>
          <option value="">{ru.common.all}</option>
          {GROUP_STATUSES.map((s: GroupStatus) => (
            <option key={s} value={s}>
              {ru.labels.groupStatus[s]}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="field__label" htmlFor={ids.placement}>
          {ru.groups.filterPlacement}
        </label>
        <select id={ids.placement} value={filters.placement} onChange={(e) => onChange('placement', e.target.value)}>
          <option value="">{ru.common.all}</option>
          {PLACEMENTS.map((p: Placement) => (
            <option key={p} value={p}>
              {ru.labels.placement[p]}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="field__label" htmlFor={ids.schedule}>
          {ru.groups.filterSchedule}
        </label>
        <select id={ids.schedule} value={filters.schedule} onChange={(e) => onChange('schedule', e.target.value)}>
          <option value="">{ru.common.all}</option>
          {SCHEDULES.map((s) => (
            <option key={s} value={s}>
              {ru.labels.schedule[s]}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="field__label" htmlFor={ids.from}>
          {ru.groups.filterFrom}
        </label>
        <input id={ids.from} type="date" value={filters.from} onChange={(e) => onChange('from', e.target.value)} />
      </div>
      <div className="field">
        <label className="field__label" htmlFor={ids.to}>
          {ru.groups.filterTo}
        </label>
        <input id={ids.to} type="date" value={filters.to} onChange={(e) => onChange('to', e.target.value)} />
      </div>
      {/* key: при сбросе фильтров поле поиска получает значение из адреса заново. */}
      <SearchBox key={filters.q} initial={filters.q} onSearch={(q) => onChange('q', q)} />
      {hasFilters ? (
        <div className="field field--end">
          <button type="button" className="btn btn--ghost" onClick={onReset}>
            {ru.groups.resetFilters}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SearchBox({ initial, onSearch }: { initial: string; onSearch: (q: string) => void }) {
  const id = useId();
  const [search, setSearch] = useState(initial);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSearch(search.trim());
  };
  return (
    <form className="field field--grow" onSubmit={submit}>
      <label className="field__label" htmlFor={id}>
        {ru.groups.filterSearch}
      </label>
      <div className="input-row">
        <input
          id={id}
          type="search"
          value={search}
          maxLength={100}
          placeholder={ru.groups.searchPlaceholder}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button type="submit" className="btn">
          {ru.common.apply}
        </button>
      </div>
    </form>
  );
}

function Versions({ group }: { group: AdminGroupSummary }) {
  const parts: string[] = [];
  if (group.liveVersion !== null) parts.push(ru.groups.liveVersion(group.liveVersion));
  if (group.pendingVersion !== null) parts.push(ru.groups.pendingVersion(group.pendingVersion));
  return <>{parts.length > 0 ? parts.join(', ') : ru.common.dash}</>;
}

function GroupsTable({ items, showStats }: { items: AdminGroupSummary[]; showStats: boolean }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="sr-only">{ru.groups.listCaption}</caption>
        <thead>
          <tr>
            <th scope="col">{ru.groups.colTitle}</th>
            <th scope="col">{ru.groups.colStatus}</th>
            <th scope="col">{ru.groups.colPlacement}</th>
            <th scope="col">{ru.groups.colPeriod}</th>
            <th scope="col" className="num">
              {ru.groups.colPriority}
            </th>
            <th scope="col" className="num">
              {ru.groups.colSlides}
            </th>
            <th scope="col">{ru.groups.colVersions}</th>
            <th scope="col">{ru.groups.colUpdated}</th>
            {showStats ? <th scope="col">{ru.groups.colActions}</th> : null}
          </tr>
        </thead>
        <tbody>
          {items.map((g) => (
            <tr key={g.id}>
              <td>
                <Link to={`/groups/${g.id}`} className="table__title">
                  {g.title}
                </Link>
              </td>
              <td>
                <div className="badges">
                  <StatusBadge status={g.status} />
                  <ScheduleBadge schedule={g.schedule} />
                </div>
              </td>
              <td>{ru.labels.placement[g.placement]}</td>
              <td>
                <Period start={g.startAt} end={g.endAt} />
              </td>
              <td className="num">{g.priority}</td>
              <td className="num">{g.slidesCount}</td>
              <td>
                <Versions group={g} />
              </td>
              <td className="small">
                {ru.groups.updatedBy(formatDateTime(g.updatedAt), g.updatedBy?.name ?? ru.common.dash)}
              </td>
              {showStats ? (
                <td>
                  <Link to={`/groups/${g.id}/stats`}>{ru.groups.stats}</Link>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
