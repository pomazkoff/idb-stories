import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { api } from '../../api/endpoints.js';
import { qk } from '../../api/queries.js';
import type { GroupStats } from '../../api/types.js';
import { Loading, PageHeader, QueryError } from '../../components/Status.js';
import { ru } from '../../i18n/ru.js';
import { formatDay, lastDays } from '../../lib/datetime.js';
import { barWidth, formatNumber, formatPercent } from '../../lib/format.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function periodFrom(params: URLSearchParams): { from: string; to: string } {
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  if (DATE_RE.test(from) && DATE_RE.test(to) && from <= to) return { from, to };
  return lastDays(7);
}

/** Статистика группы (раздел 6.2, экран 4): итоги, воронка по слайдам, таблица по дням. */
export function StatsPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const period = periodFrom(params);
  const group = useQuery({ queryKey: qk.group(id), queryFn: ({ signal }) => api.getGroup(id, signal) });
  const stats = useQuery({
    queryKey: qk.stats(id, period.from, period.to),
    queryFn: ({ signal }) => api.stats(id, period.from, period.to, signal),
    placeholderData: keepPreviousData,
  });

  const setPeriod = (from: string, to: string) => setParams(new URLSearchParams({ from, to }), { replace: true });
  const title = group.data ? ru.stats.title(group.data.title) : ru.stats.heading;

  return (
    <div className="stack">
      <title>{ru.app.pageTitle(title)}</title>
      <p>
        <Link to={`/groups/${id}`}>{group.data ? group.data.title : ru.editor.backToList}</Link>
      </p>
      <PageHeader title={title} />
      <PeriodPicker key={`${period.from}:${period.to}`} from={period.from} to={period.to} onApply={setPeriod} />
      {stats.isPending ? (
        <Loading />
      ) : stats.isError ? (
        <QueryError error={stats.error} onRetry={() => void stats.refetch()} />
      ) : (
        <StatsView stats={stats.data} />
      )}
    </div>
  );
}

function PeriodPicker({ from, to, onApply }: { from: string; to: string; onApply: (from: string, to: string) => void }) {
  const id = useId();
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!DATE_RE.test(draftFrom) || !DATE_RE.test(draftTo) || draftFrom > draftTo) {
      setError(ru.stats.periodInvalid);
      return;
    }
    setError(null);
    onApply(draftFrom, draftTo);
  };

  const preset = (days: number) => {
    const p = lastDays(days);
    onApply(p.from, p.to);
  };

  return (
    <form className="filters card" onSubmit={submit} aria-label={ru.stats.period}>
      <div className="field">
        <label className="field__label" htmlFor={`${id}-from`}>
          {ru.stats.from}
        </label>
        <input id={`${id}-from`} type="date" value={draftFrom} max={draftTo} onChange={(e) => setDraftFrom(e.target.value)} />
      </div>
      <div className="field">
        <label className="field__label" htmlFor={`${id}-to`}>
          {ru.stats.to}
        </label>
        <input id={`${id}-to`} type="date" value={draftTo} min={draftFrom} onChange={(e) => setDraftTo(e.target.value)} />
      </div>
      <div className="field field--end">
        <div className="actions">
          <button type="submit" className="btn btn--primary">
            {ru.stats.apply}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => preset(7)}>
            {ru.stats.last7}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => preset(30)}>
            {ru.stats.last30}
          </button>
        </div>
      </div>
      {error ? (
        <p className="field__error field--wide" role="alert">
          {error}
        </p>
      ) : null}
      <p className="field__hint field--wide">{ru.stats.daysNote}</p>
    </form>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <dt className="metric__label">{label}</dt>
      <dd className="metric__value">{value}</dd>
    </div>
  );
}

function StatsView({ stats }: { stats: GroupStats }) {
  const t = stats.totals;
  const funnelId = useId();
  const dailyId = useId();
  return (
    <>
      <section className="card stack" aria-label={ru.stats.totals}>
        <h2 className="section-title">{ru.stats.totals}</h2>
        <dl className="metrics">
          <Metric label={ru.stats.impressions} value={formatNumber(t.impressions)} />
          <Metric label={ru.stats.opens} value={formatNumber(t.opens)} />
          <Metric label={ru.stats.openRate} value={formatPercent(t.openRate)} />
          <Metric label={ru.stats.ctaClicks} value={formatNumber(t.ctaClicks)} />
          <Metric label={ru.stats.ctr} value={formatPercent(t.ctr)} />
          <Metric label={ru.stats.addToCart} value={formatNumber(t.addToCart)} />
        </dl>
        <p className="field__hint">{ru.stats.attributionNote}</p>
      </section>

      <section className="card stack" aria-labelledby={funnelId}>
        <h2 id={funnelId} className="section-title">
          {ru.stats.funnel}
        </h2>
        <p className="field__hint">{ru.stats.funnelHint}</p>
        {stats.slides.length === 0 ? (
          <p className="muted">{ru.stats.empty}</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">{ru.stats.funnelCaption}</caption>
              <thead>
                <tr>
                  <th scope="col">{ru.stats.colSlide}</th>
                  <th scope="col" className="funnel-col">
                    {ru.stats.colReach}
                  </th>
                  <th scope="col" className="num">
                    {ru.stats.colViews}
                  </th>
                  <th scope="col" className="num">
                    {ru.stats.colCompletion}
                  </th>
                  <th scope="col" className="num">
                    {ru.stats.colCta}
                  </th>
                  <th scope="col" className="num">
                    {ru.stats.colCtr}
                  </th>
                  <th scope="col" className="num">
                    {ru.stats.colCart}
                  </th>
                </tr>
              </thead>
              <tbody>
                {stats.slides.map((s) => (
                  <tr key={s.slideId}>
                    <th scope="row">
                      {s.position !== null ? ru.slides.number(s.position + 1) : ru.stats.oldSlide}
                      {s.type ? (
                        <span className="muted small"> · {ru.labels.slideType[s.type as 'image' | 'video' | 'product'] ?? s.type}</span>
                      ) : null}
                    </th>
                    <td className="funnel-col">
                      <div className="bar">
                        <span className="bar__track" aria-hidden="true">
                          <span className="bar__fill" style={{ width: barWidth(s.reach) }} />
                        </span>
                        <span className="bar__value">{formatPercent(s.reach)}</span>
                      </div>
                    </td>
                    <td className="num">{formatNumber(s.views)}</td>
                    <td className="num">{formatPercent(s.completionRate)}</td>
                    <td className="num">{formatNumber(s.ctaClicks)}</td>
                    <td className="num">{formatPercent(s.ctr)}</td>
                    <td className="num">{formatNumber(s.addToCart)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card stack" aria-labelledby={dailyId}>
        <h2 id={dailyId} className="section-title">
          {ru.stats.daily}
        </h2>
        {stats.daily.length === 0 ? (
          <p className="muted">{ru.stats.empty}</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">{ru.stats.dailyCaption}</caption>
              <thead>
                <tr>
                  <th scope="col">{ru.stats.colDate}</th>
                  <th scope="col" className="num">
                    {ru.stats.colImpressions}
                  </th>
                  <th scope="col" className="num">
                    {ru.stats.colOpens}
                  </th>
                  <th scope="col" className="num">
                    {ru.stats.colSlideViews}
                  </th>
                  <th scope="col" className="num">
                    {ru.stats.colCta}
                  </th>
                  <th scope="col" className="num">
                    {ru.stats.colCart}
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...stats.daily]
                  .sort((a, b) => (a.date < b.date ? -1 : 1))
                  .map((d) => (
                    <tr key={d.date}>
                      <th scope="row">{formatDay(d.date)}</th>
                      <td className="num">{formatNumber(d.impressions)}</td>
                      <td className="num">{formatNumber(d.opens)}</td>
                      <td className="num">{formatNumber(d.slideViews)}</td>
                      <td className="num">{formatNumber(d.ctaClicks)}</td>
                      <td className="num">{formatNumber(d.addToCart)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
