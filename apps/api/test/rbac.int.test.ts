import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLES, hasPermission, type Role } from '@idb-stories/schema';
import { adminContracts, type RouteContract } from '@idb-stories/schema/contracts';
import {
  createReadyAsset,
  createTestApi,
  groupInput,
  type Session,
  type TestApi,
} from './helpers.js';
import {
  actors,
  approved,
  inReview,
  published,
  readyDraft,
  scheduled,
  type Actors,
} from './fixtures.js';

/**
 * Раздел 10.11: каждая пара роль × эндпоинт admin API возвращает ожидаемый 2xx или 403.
 * Проверки только на фронте недостаточно (раздел 6.1) — здесь бьём прямо в API.
 * Новый эндпоинт без записи в CASES уронит тест «покрыты все контракты».
 */

interface Request {
  url: string;
  body?: unknown;
}
type Case = (api: TestApi, a: Actors, self: Session) => Promise<Request>;

const g = (id: string, rest = '') => `/admin/v1/groups/${id}${rest}`;

const CASES: Record<string, Case> = {
  authLogout: async () => ({ url: '/admin/v1/auth/logout' }),
  authMe: async () => ({ url: '/admin/v1/auth/me' }),
  listGroups: async () => ({ url: '/admin/v1/groups?limit=5' }),
  createGroup: async () => ({ url: '/admin/v1/groups', body: groupInput() }),
  getGroup: async (api, a) => ({ url: g((await readyDraft(api, a)).id) }),
  updateGroup: async (api, a) => {
    const grp = await readyDraft(api, a);
    return { url: g(grp.id), body: { revision: grp.revision, title: 'Переименовано' } };
  },
  deleteGroup: async (api, a) => ({ url: g((await readyDraft(api, a)).id) }),
  duplicateGroup: async (api, a) => ({ url: g((await readyDraft(api, a)).id, '/duplicate') }),
  createSlide: async (api, a) => {
    const grp = await readyDraft(api, a);
    const media = await createReadyAsset(api, {
      kind: 'image',
      purpose: 'slide',
      uploadedBy: a.editor2.userId,
    });
    return {
      url: g(grp.id, '/slides'),
      body: { type: 'image', mediaAssetId: media, durationMs: 4000 },
    };
  },
  reorderSlides: async (api, a) => {
    const grp = await readyDraft(api, a);
    return {
      url: g(grp.id, '/slides/order'),
      body: { revision: grp.revision, slideIds: grp.slides.map((s) => s.id) },
    };
  },
  updateSlide: async (api, a) => {
    const grp = await readyDraft(api, a);
    const slide = grp.slides[0]!;
    return {
      url: g(grp.id, `/slides/${slide.id}`),
      body: { type: 'image', mediaAssetId: slide.mediaAssetId, durationMs: 7000 },
    };
  },
  deleteSlide: async (api, a) => {
    const grp = await readyDraft(api, a);
    return { url: g(grp.id, `/slides/${grp.slides[0]!.id}`) };
  },
  submitGroup: async (api, a) => {
    const grp = await readyDraft(api, a);
    return { url: g(grp.id, '/submit'), body: { revision: grp.revision } };
  },
  approveGroup: async (api, a) => {
    const grp = await inReview(api, a);
    return { url: g(grp.id, '/approve'), body: { revision: grp.revision } };
  },
  rejectGroup: async (api, a) => {
    const grp = await inReview(api, a);
    return {
      url: g(grp.id, '/reject'),
      body: { revision: grp.revision, comment: 'Поправьте текст' },
    };
  },
  publishGroup: async (api, a) => ({ url: g((await scheduled(api, a)).id, '/publish') }),
  unpublishGroup: async (api, a) => ({
    url: g((await published(api, a)).id, '/unpublish'),
    body: {},
  }),
  getGroupDiff: async (api, a) => ({ url: g((await approved(api, a)).id, '/diff') }),
  getGroupPreview: async (api, a) => ({ url: g((await readyDraft(api, a)).id, '/preview') }),
  listGroupVersions: async (api, a) => ({ url: g((await approved(api, a)).id, '/versions') }),
  createUploadUrl: async () => ({
    url: '/admin/v1/media/upload-url',
    body: { kind: 'image', purpose: 'slide', contentType: 'image/jpeg', size: 1000 },
  }),
  completeUpload: async (api, _a, self) => {
    const res = await api.admin(self, 'POST', '/admin/v1/media/upload-url', {
      kind: 'image',
      purpose: 'slide',
      contentType: 'image/jpeg',
      size: 3,
    });
    if (res.statusCode !== 201) {
      // у роли нет права загружать — берём чужую загрузку: доступ всё равно должен быть закрыт
      const other = await api.db.owner.mediaAsset.findFirstOrThrow();
      return { url: `/admin/v1/media/${other.id}/complete` };
    }
    const { asset } = res.json<{ asset: { id: string } }>();
    await api.storage.put(
      api.config.s3.buckets.quarantine,
      `uploads/${asset.id}`,
      Buffer.from('abc'),
      {
        contentType: 'image/jpeg',
      },
    );
    return { url: `/admin/v1/media/${asset.id}/complete` };
  },
  getMedia: async (api, a) => ({
    url: `/admin/v1/media/${await createReadyAsset(api, { kind: 'image', purpose: 'slide', uploadedBy: a.editor2.userId })}`,
  }),
  listSegments: async () => ({ url: '/admin/v1/segments' }),
  getCatalogProducts: async () => ({ url: '/admin/v1/catalog/products?skus=SKU001,SKU002' }),
  getGroupStats: async (api, a) => ({
    url: `/admin/v1/stats/groups/${(await readyDraft(api, a)).id}?from=2026-01-01&to=2026-12-31`,
  }),
  listAuditLog: async () => ({ url: '/admin/v1/audit-log?limit=10' }),
  listUsers: async () => ({ url: '/admin/v1/users' }),
  setUserRoles: async (api) => ({
    url: `/admin/v1/users/${await api.userId('mock-newcomer')}/roles`,
    body: { roles: [] },
  }),
  setUserStatus: async (api) => ({
    url: `/admin/v1/users/${await api.userId('mock-newcomer')}/status`,
    body: { disabled: false },
  }),
  getSettings: async () => ({ url: '/admin/v1/settings' }),
  updateAllowlist: async () => ({
    url: '/admin/v1/settings/allowlist',
    body: { deeplinkSchemes: ['idb'], urlDomains: ['iledebeaute.ru'] },
  }),
  setFeedEnabled: async () => ({
    url: '/admin/v1/settings/feed-enabled',
    body: { enabled: true, confirmation: 'ВКЛЮЧИТЬ' },
  }),
};

const SUBJECTS: Record<Role | 'none', string> = {
  editor: 'mock-editor',
  publisher: 'mock-publisher',
  analyst: 'mock-analyst',
  admin: 'mock-admin',
  none: 'mock-newcomer',
};

const sessionContracts = adminContracts.filter(
  (c) => c.auth === 'session',
) as readonly RouteContract[];

describe('матрица прав: роль × эндпоинт admin API', () => {
  let api: TestApi;
  let a: Actors;
  const sessions = {} as Record<Role | 'none', Session>;

  beforeAll(async () => {
    api = await createTestApi();
    a = await actors(api);
    for (const [role, subject] of Object.entries(SUBJECTS))
      sessions[role as Role | 'none'] = await api.login(subject);
  });
  afterAll(async () => {
    await api.close();
  });

  it('покрыты все контракты admin API с сессией', () => {
    expect(sessionContracts.map((c) => c.id).sort()).toEqual(Object.keys(CASES).sort());
  });

  it('каждое право матрицы кому-то выдано и есть в контрактах', () => {
    const used = new Set(sessionContracts.map((c) => c.permission).filter(Boolean));
    for (const p of Object.keys(PERMISSIONS)) expect(used.has(p as never)).toBe(true);
  });

  for (const contract of sessionContracts) {
    describe(`${contract.method} ${contract.path}`, () => {
      for (const role of [...ROLES, 'none'] as const) {
        const allowed =
          !contract.permission || (role !== 'none' && hasPermission([role], contract.permission));
        it(`${role} → ${allowed ? '2xx' : '403'}`, async () => {
          const self = sessions[role];
          const req = await CASES[contract.id]!(api, a, self);
          const auditBefore = await api.db.owner.auditLog.count();
          const res = await api.admin(self, contract.method, req.url, req.body);
          if (allowed) {
            expect(res.statusCode, res.body).toBeGreaterThanOrEqual(200);
            expect(res.statusCode, res.body).toBeLessThan(300);
          } else {
            expect(res.statusCode, res.body).toBe(403);
            expect(res.json().error.code).toBe('forbidden');
            // запрет не оставляет побочных эффектов
            expect(await api.db.owner.auditLog.count()).toBe(auditBefore);
          }
          if (contract.id === 'authLogout' && res.statusCode === 204) {
            sessions[role] = await api.login(SUBJECTS[role]);
          }
        });
      }
    });
  }

  it('каждый отказ в доступе пишется как событие безопасности', () => {
    expect(
      api.adapters.siem.events.filter((e) => e.type === 'access.denied').length,
    ).toBeGreaterThan(50);
  });
});
