import { expect } from 'vitest';
import type { AdminGroup } from '@idb-stories/schema';
import { createReadyAsset, groupInput, type Session, type TestApi } from './helpers.js';

/** Сессии «посторонних» пользователей для подготовки данных, чтобы не мешать правилу четырёх глаз. */
export interface Actors {
  editor2: Session;
  lead: Session;
}

export async function actors(api: TestApi): Promise<Actors> {
  return {
    editor2: await api.login('mock-editor-2'),
    lead: await api.login('mock-editor-publisher'),
  };
}

async function ok<T>(
  p: Promise<{ statusCode: number; json: () => unknown; body: string }>,
  status = [200, 201],
): Promise<T> {
  const res = await p;
  if (!status.includes(res.statusCode)) throw new Error(`Фикстура: ${res.statusCode} ${res.body}`);
  return res.json() as T;
}

/** Черновик с обложкой и одним слайдом-картинкой, созданный editor2. */
export async function readyDraft(
  api: TestApi,
  a: Actors,
  overrides: Record<string, unknown> = {},
): Promise<AdminGroup> {
  const cover = await createReadyAsset(api, {
    kind: 'image',
    purpose: 'cover',
    uploadedBy: a.editor2.userId,
  });
  const image = await createReadyAsset(api, {
    kind: 'image',
    purpose: 'slide',
    uploadedBy: a.editor2.userId,
  });
  const g = await ok<AdminGroup>(
    api.admin(
      a.editor2,
      'POST',
      '/admin/v1/groups',
      groupInput({ coverAssetId: cover, ...overrides }),
    ),
  );
  return ok<AdminGroup>(
    api.admin(a.editor2, 'POST', `/admin/v1/groups/${g.id}/slides`, {
      type: 'image',
      mediaAssetId: image,
      durationMs: 5000,
      elements: [{ kind: 'text', text: 'Ароматы сезона', style: 'title', position: 'top' }],
      cta: { type: 'category', value: 'cat_123', label: 'Смотреть' },
    }),
  );
}

export async function inReview(
  api: TestApi,
  a: Actors,
  overrides: Record<string, unknown> = {},
): Promise<AdminGroup> {
  const g = await readyDraft(api, a, overrides);
  return ok<AdminGroup>(
    api.admin(a.editor2, 'POST', `/admin/v1/groups/${g.id}/submit`, { revision: g.revision }),
  );
}

/** Согласована lead (не правил группу). Если start_at уже наступил — сразу опубликована. */
export async function approved(
  api: TestApi,
  a: Actors,
  overrides: Record<string, unknown> = {},
): Promise<AdminGroup> {
  const g = await inReview(api, a, overrides);
  const res = await ok<AdminGroup>(
    api.admin(a.lead, 'POST', `/admin/v1/groups/${g.id}/approve`, { revision: g.revision }),
  );
  expect(res.status === 'approved' || res.status === 'published').toBe(true);
  return res;
}

export const published = (api: TestApi, a: Actors) => approved(api, a);

/** Согласована, но start_at в будущем — ждёт публикации. */
export function scheduled(api: TestApi, a: Actors): Promise<AdminGroup> {
  const now = Date.now();
  return approved(api, a, {
    startAt: new Date(now + 24 * 3600_000).toISOString(),
    endAt: new Date(now + 7 * 24 * 3600_000).toISOString(),
  });
}
