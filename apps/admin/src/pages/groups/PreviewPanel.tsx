import type { Placement } from '@idb-stories/schema';
import type { CatalogProduct } from '@idb-stories/web-player';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { api } from '../../api/endpoints.js';
import { qk, useSettings } from '../../api/queries.js';
import { useCan } from '../../auth/session.js';
import { PhonePreview } from '../../components/PhonePreview.js';
import { Loading, QueryError } from '../../components/Status.js';
import { ru } from '../../i18n/ru.js';
import { useDebouncedValue } from '../../lib/hooks.js';

const PREVIEW_DEBOUNCE_MS = 700;
/** Подписанные URL медиа в превью живут 15 минут — перечитываем раньше. */
const PREVIEW_REFRESH_MS = 10 * 60_000;

async function fetchProducts(skus: string[]): Promise<CatalogProduct[]> {
  return (await api.catalogProducts(skus)).items;
}

/**
 * Живое превью рабочей копии в веб-плеере: перечитывается после каждого сохранения
 * (ревизия группы) с задержкой, чтобы серия правок не порождала серию запросов.
 */
export function PreviewPanel({ groupId, revision, placement }: { groupId: string; revision: number; placement: Placement }) {
  const can = useCan();
  const titleId = useId();
  const settings = useSettings();
  const debouncedRevision = useDebouncedValue(revision, PREVIEW_DEBOUNCE_MS);
  const preview = useQuery({
    queryKey: [...qk.preview(groupId), debouncedRevision],
    queryFn: ({ signal }) => api.preview(groupId, signal),
    placeholderData: keepPreviousData,
    refetchInterval: PREVIEW_REFRESH_MS,
    staleTime: 0,
  });

  return (
    <section className="card stack preview-panel" aria-labelledby={titleId}>
      <div className="section-head">
        <h2 id={titleId} className="section-title">
          {ru.preview.title}
        </h2>
        <button
          type="button"
          className="btn btn--ghost btn--small"
          onClick={() => void preview.refetch()}
          disabled={preview.isFetching}
        >
          {ru.preview.refresh}
        </button>
      </div>
      <p className="muted small">{ru.preview.hint}</p>
      {preview.isPending || settings.isPending ? (
        <Loading label={ru.preview.loading} />
      ) : preview.isError ? (
        <QueryError error={preview.error} onRetry={() => void preview.refetch()} />
      ) : !settings.data ? (
        <p className="muted">{ru.preview.noSettings}</p>
      ) : (
        <>
          <PhonePreview
            feed={preview.data.feed}
            placement={placement}
            mediaOrigins={preview.data.mediaOrigins}
            ctaAllowlist={settings.data.ctaAllowlist}
            getProducts={can('catalog:read') ? fetchProducts : undefined}
          />
          {preview.data.warnings.length > 0 ? (
            <div className="alert alert--warning">
              <p className="alert__text">{ru.preview.warnings}</p>
              <ul className="alert__list">
                {preview.data.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
