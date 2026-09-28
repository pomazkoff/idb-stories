import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '../../api/endpoints.js';
import { qk } from '../../api/queries.js';
import { Period } from '../../components/Period.js';
import { Loading, PageHeader, QueryError } from '../../components/Status.js';
import { ru } from '../../i18n/ru.js';
import { formatDateTime } from '../../lib/datetime.js';

/** Очередь согласования: группы в статусе in_review. */
export function ReviewQueuePage() {
  const query = useInfiniteQuery({
    queryKey: [...qk.groups, 'review-queue'],
    queryFn: ({ pageParam, signal }) => api.listGroups({ status: 'in_review', limit: 50, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="stack">
      <title>{ru.app.pageTitle(ru.review.queueTitle)}</title>
      <PageHeader title={ru.review.queueTitle} />
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <QueryError error={query.error} onRetry={() => void query.refetch()} />
      ) : items.length === 0 ? (
        <p className="empty">{ru.review.queueEmpty}</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">{ru.review.queueCaption}</caption>
            <thead>
              <tr>
                <th scope="col">{ru.groups.colTitle}</th>
                <th scope="col">{ru.groups.colPlacement}</th>
                <th scope="col">{ru.groups.colPeriod}</th>
                <th scope="col" className="num">
                  {ru.groups.colSlides}
                </th>
                <th scope="col">{ru.groups.colVersions}</th>
                <th scope="col">{ru.review.colSubmitted}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((g) => (
                <tr key={g.id}>
                  <td>
                    <Link to={`/review/${g.id}`} className="table__title">
                      {g.title}
                    </Link>
                  </td>
                  <td>{ru.labels.placement[g.placement]}</td>
                  <td>
                    <Period start={g.startAt} end={g.endAt} />
                  </td>
                  <td className="num">{g.slidesCount}</td>
                  <td>{g.liveVersion !== null ? ru.groups.liveVersion(g.liveVersion) : ru.common.dash}</td>
                  <td className="small">
                    {ru.groups.updatedBy(formatDateTime(g.updatedAt), g.updatedBy?.name ?? ru.common.dash)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
