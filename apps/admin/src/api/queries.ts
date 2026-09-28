import { QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { isApiError } from './client.js';
import { api } from './endpoints.js';
import type { AdminGroup, AdminMediaAsset } from './types.js';

export const qk = {
  me: ['me'] as const,
  groups: ['groups'] as const,
  group: (id: string) => ['group', id] as const,
  preview: (id: string) => ['preview', id] as const,
  diff: (id: string) => ['diff', id] as const,
  media: (id: string) => ['media', id] as const,
  settings: ['settings'] as const,
  segments: ['segments'] as const,
  stats: (id: string, from: string, to: string) => ['stats', id, from, to] as const,
  audit: ['audit'] as const,
  users: ['users'] as const,
};

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Повторяем только сетевые сбои и 5xx; 4xx — ответ по существу.
        retry: (failureCount, error) =>
          failureCount < 2 && isApiError(error) && (error.status === 0 || error.status >= 500),
        refetchOnWindowFocus: false,
        staleTime: 15_000,
      },
      mutations: { retry: false },
    },
  });
}

/** Каждая мутация группы возвращает её целиком с новой ревизией — заменяем кеш. */
export function storeGroup(client: QueryClient, group: AdminGroup): void {
  client.setQueryData(qk.group(group.id), group);
  void client.invalidateQueries({ queryKey: qk.groups });
  void client.invalidateQueries({ queryKey: qk.diff(group.id) });
}

export function latestRevision(client: QueryClient, groupId: string, fallback: number): number {
  return client.getQueryData<AdminGroup>(qk.group(groupId))?.revision ?? fallback;
}

export function useSettings(enabled = true) {
  return useQuery({ queryKey: qk.settings, queryFn: ({ signal }) => api.settings(signal), enabled, staleTime: 60_000 });
}

export function useSegments(enabled = true) {
  return useQuery({
    queryKey: qk.segments,
    queryFn: ({ signal }) => api.segments(signal),
    enabled,
    staleTime: 5 * 60_000,
  });
}

const POLL_MS = 1500;
/** Подписанные URL превью живут 15 минут — перечитываем заранее. */
const SIGNED_URL_REFRESH_MS = 10 * 60_000;

const isFinal = (asset: AdminMediaAsset | undefined) => asset?.status === 'ready' || asset?.status === 'rejected';

/**
 * Статус медиа: опрос каждые ~1,5 с до ready/rejected. Когда файл становится готов,
 * превью групп перечитывается — в нём появляется медиа.
 */
export function useMediaAsset(mediaId: string | null) {
  const client = useQueryClient();
  return useQuery({
    queryKey: qk.media(mediaId ?? 'none'),
    enabled: mediaId !== null,
    queryFn: async ({ signal }) => {
      const id = mediaId ?? '';
      const previous = client.getQueryData<AdminMediaAsset>(qk.media(id));
      const asset = await api.getMedia(id, signal);
      if (asset.status === 'ready' && previous && previous.status !== 'ready') {
        void client.invalidateQueries({ queryKey: ['preview'] });
      }
      return asset;
    },
    refetchInterval: (query) => {
      const data = query.state.data;
      if (query.state.status === 'error') return false;
      if (!isFinal(data)) return POLL_MS;
      return data?.status === 'ready' ? SIGNED_URL_REFRESH_MS : false;
    },
    // Опрос продолжается и в фоновой вкладке: редактор часто уходит, пока обрабатывается видео.
    refetchIntervalInBackground: true,
    staleTime: (query) => (isFinal(query.state.data) ? SIGNED_URL_REFRESH_MS : 0),
  });
}
