import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@idb-stories/db';
import type {
  AdminGroup,
  CtaAllowlist,
  FeedResponse,
  GroupDiff,
  GroupPreview,
} from '@idb-stories/schema';
import {
  createReadyAsset,
  createTestApi,
  groupInput,
  type Session,
  type TestApi,
} from './helpers.js';
import { actors, approved, inReview, readyDraft, scheduled, type Actors } from './fixtures.js';

interface ApiError {
  code: string;
  message: string;
  details?: { problems?: string[] };
}

const errorOf = (res: LightMyRequestResponse) => res.json<{ error: ApiError }>().error;

/** Медиа в произвольном состоянии (как будто воркер ещё не закончил или записал мусор). */
async function rawImageAsset(
  api: TestApi,
  opts: {
    purpose: 'cover' | 'slide';
    status: 'uploaded' | 'processing' | 'ready';
    uploadedBy: string;
    variants?: Prisma.InputJsonObject;
  },
): Promise<string> {
  const asset = await api.db.owner.mediaAsset.create({
    data: {
      kind: 'image',
      purpose: opts.purpose,
      status: opts.status,
      declaredContentType: 'image/jpeg',
      declaredSize: 1000,
      originalKey: `uploads/${randomUUID()}`,
      uploadedById: opts.uploadedBy,
      ...(opts.variants ? { variants: opts.variants } : {}),
    },
  });
  return asset.id;
}

describe('согласование и публикация: граничные случаи', () => {
  let api: TestApi;
  let a: Actors;
  let publisher: Session;
  let admin: Session;
  const missing = randomUUID();

  beforeAll(async () => {
    api = await createTestApi();
    a = await actors(api);
    publisher = await api.login('mock-publisher');
    admin = await api.login('mock-admin');
  });
  afterAll(async () => {
    await api.close();
  });

  const post = (s: Session, id: string, action: string, body?: unknown) =>
    api.admin(s, 'POST', `/admin/v1/groups/${id}/${action}`, body);
  const read = (id: string, what: 'diff' | 'preview' | 'versions') =>
    api.admin(publisher, 'GET', `/admin/v1/groups/${id}/${what}`);
  const snapshots = (groupId: string) =>
    api.db.owner.publishedSnapshot.findMany({ where: { groupId }, orderBy: { version: 'asc' } });
  const statusOf = async (id: string) =>
    (await api.db.owner.storyGroup.findUniqueOrThrow({ where: { id } })).status;
  const addSlide = async (groupId: string, body: Record<string, unknown>) => {
    const res = await api.admin(a.editor2, 'POST', `/admin/v1/groups/${groupId}/slides`, body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json<AdminGroup>();
  };
  const submit = async (g: AdminGroup) => {
    const res = await post(a.editor2, g.id, 'submit', { revision: g.revision });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<AdminGroup>();
  };
  /** Сдвигает часы сервиса на время колбэка (группы создаются по реальному времени). */
  const at = async (time: number, fn: () => Promise<void>) => {
    const saved = api.clock.now;
    api.clock.now = new Date(time);
    try {
      await fn();
    } finally {
      api.clock.now = saved;
    }
  };

  describe('отправка на согласование', () => {
    it('повторная отправка и отправка опубликованной группы — 409 invalid_state', async () => {
      const review = await inReview(api, a);
      const again = await post(a.editor2, review.id, 'submit', { revision: review.revision });
      expect(again.statusCode).toBe(409);
      expect(errorOf(again).code).toBe('invalid_state');

      const live = await approved(api, a);
      expect(live.status).toBe('published');
      const res = await post(a.editor2, live.id, 'submit', { revision: live.revision });
      expect(res.statusCode).toBe(409);
      expect(errorOf(res).code).toBe('invalid_state');

      expect(await statusOf(review.id)).toBe('in_review');
      expect(await statusOf(live.id)).toBe('published');
    });

    it('отклонённую группу можно отправить повторно — комментарий рецензента сбрасывается', async () => {
      const review = await inReview(api, a);
      const rej = await post(publisher, review.id, 'reject', {
        revision: review.revision,
        comment: 'Поправьте текст',
      });
      expect(rej.json<AdminGroup>()).toMatchObject({
        status: 'rejected',
        reviewComment: 'Поправьте текст',
      });
      const res = await post(a.editor2, review.id, 'submit', { revision: review.revision });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<AdminGroup>()).toMatchObject({ status: 'in_review', reviewComment: null });
    });

    it('после окончания периода показа отправить нельзя: 409 not_ready с причиной', async () => {
      const t0 = Date.now();
      const endAt = t0 + 60_000;
      const draft = await readyDraft(api, a, {
        startAt: new Date(t0 - 3600_000).toISOString(),
        endAt: new Date(endAt).toISOString(),
      });
      // ровно в момент end_at показ уже закончился — и тем более позже
      for (const time of [endAt, endAt + 60_000]) {
        await at(time, async () => {
          const res = await post(a.editor2, draft.id, 'submit', { revision: draft.revision });
          expect(res.statusCode).toBe(409);
          const err = errorOf(res);
          expect(err.code).toBe('not_ready');
          expect(err.details?.problems).toEqual(['Период показа уже закончился']);
        });
      }
      expect(await statusOf(draft.id)).toBe('draft');
    });

    it('отправка, согласование и отклонение несуществующей группы — 404', async () => {
      const responses = [
        await post(a.editor2, missing, 'submit', { revision: 1 }),
        await post(publisher, missing, 'approve', { revision: 1 }),
        await post(publisher, missing, 'reject', { revision: 1, comment: 'Нет такой' }),
      ];
      for (const res of responses) {
        expect(res.statusCode).toBe(404);
        expect(errorOf(res).code).toBe('not_found');
      }
    });
  });

  describe('согласование', () => {
    it('согласовать и отклонить можно только группу на согласовании', async () => {
      const draft = await readyDraft(api, a);
      const appr = await post(publisher, draft.id, 'approve', { revision: draft.revision });
      expect(appr.statusCode).toBe(409);
      expect(errorOf(appr).code).toBe('invalid_state');
      const rej = await post(publisher, draft.id, 'reject', {
        revision: draft.revision,
        comment: 'Рано',
      });
      expect(rej.statusCode).toBe(409);
      expect(errorOf(rej).code).toBe('invalid_state');
      expect(await snapshots(draft.id)).toEqual([]);
      expect(await statusOf(draft.id)).toBe('draft');
    });

    it('период показа закончился, пока группа ждала согласования — 409 not_ready, снимка нет', async () => {
      const t0 = Date.now();
      const endAt = t0 + 60_000;
      const review = await inReview(api, a, {
        startAt: new Date(t0 - 3600_000).toISOString(),
        endAt: new Date(endAt).toISOString(),
      });
      for (const time of [endAt, endAt + 60_000]) {
        await at(time, async () => {
          const res = await post(publisher, review.id, 'approve', { revision: review.revision });
          expect(res.statusCode).toBe(409);
          expect(errorOf(res)).toMatchObject({
            code: 'not_ready',
            details: { problems: ['Период показа уже закончился'] },
          });
        });
      }
      expect(await snapshots(review.id)).toEqual([]);
      expect(await statusOf(review.id)).toBe('in_review');
      expect(
        await api.db.owner.auditLog.count({
          where: { action: 'group.approved', entityId: review.id },
        }),
      ).toBe(0);

      // контроль: пока период не закончился, та же версия согласуется и сразу публикуется
      const ok = await post(publisher, review.id, 'approve', { revision: review.revision });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json<AdminGroup>()).toMatchObject({ status: 'published', liveVersion: 1 });
    });

    it('правило четырёх глаз держится на последнем авторе, даже если список правивших пуст', async () => {
      const review = await inReview(api, a);
      await api.db.owner.storyGroup.update({
        where: { id: review.id },
        data: { lastEditedById: a.lead.userId, editorsSinceApproval: [] },
      });
      const before = api.adapters.siem.events.length;
      const res = await post(a.lead, review.id, 'approve', { revision: review.revision });
      expect(res.statusCode).toBe(403);
      expect(errorOf(res).code).toBe('four_eyes');
      expect(api.adapters.siem.events.slice(before)).toContainEqual(
        expect.objectContaining({
          type: 'four_eyes.violation',
          actorId: a.lead.userId,
          details: { groupId: review.id, revision: review.revision },
        }),
      );
      expect(await snapshots(review.id)).toEqual([]);
      expect(await statusOf(review.id)).toBe('in_review');
    });

    it('если allowlist сузили после отправки — 409 cta_not_allowed и событие cta.rejected (stage approve)', async () => {
      const draft = await readyDraft(api, a);
      const withUrl = await addSlide(draft.id, {
        type: 'image',
        mediaAssetId: draft.slides[0]!.mediaAssetId,
        cta: { type: 'url', value: 'https://iledebeaute.ru/sale', label: 'Купить' },
      });
      const review = await submit(withUrl);

      const settings = await api.admin(admin, 'GET', '/admin/v1/settings');
      const saved = settings.json<{ ctaAllowlist: CtaAllowlist }>().ctaAllowlist;
      const narrowed = await api.admin(admin, 'PUT', '/admin/v1/settings/allowlist', {
        deeplinkSchemes: ['idb'],
        urlDomains: ['example.org'],
      });
      expect(narrowed.statusCode, narrowed.body).toBe(200);
      try {
        const before = api.adapters.siem.events.length;
        const res = await post(publisher, draft.id, 'approve', { revision: review.revision });
        expect(res.statusCode).toBe(409);
        const err = errorOf(res);
        expect(err.code).toBe('cta_not_allowed');
        expect(err.details?.problems).toEqual(['Слайд 2: Домен не входит в allowlist']);
        expect(api.adapters.siem.events.slice(before)).toContainEqual(
          expect.objectContaining({
            type: 'cta.rejected',
            actorId: publisher.userId,
            details: { stage: 'approve', groupId: draft.id },
          }),
        );
        expect(await snapshots(draft.id)).toEqual([]);
        expect(await statusOf(draft.id)).toBe('in_review');
      } finally {
        const restored = await api.admin(admin, 'PUT', '/admin/v1/settings/allowlist', saved);
        expect(restored.statusCode, restored.body).toBe(200);
      }
    });

    it('если медиа отклонили после отправки — 409 not_ready, причины перечислены', async () => {
      const draft = await readyDraft(api, a);
      const second = await createReadyAsset(api, {
        kind: 'image',
        purpose: 'slide',
        uploadedBy: a.editor2.userId,
      });
      const review = await submit(
        await addSlide(draft.id, { type: 'image', mediaAssetId: second, durationMs: 5000 }),
      );

      // один слайд отклонён: группа собирается, но не полностью
      await api.db.owner.mediaAsset.update({
        where: { id: second },
        data: { status: 'rejected', rejectReason: 'polyglot' },
      });
      const partial = await post(publisher, draft.id, 'approve', { revision: review.revision });
      expect(partial.statusCode).toBe(409);
      expect(errorOf(partial)).toMatchObject({
        code: 'not_ready',
        details: { problems: ['Слайд 2: файл отклонён проверкой'] },
      });

      // отклонена и обложка: группа не собирается вовсе
      await api.db.owner.mediaAsset.update({
        where: { id: draft.coverAssetId! },
        data: { status: 'rejected' },
      });
      const broken = await post(publisher, draft.id, 'approve', { revision: review.revision });
      expect(broken.statusCode).toBe(409);
      expect(errorOf(broken)).toMatchObject({
        code: 'not_ready',
        details: {
          problems: ['Обложка: файл отклонён проверкой', 'Слайд 2: файл отклонён проверкой'],
        },
      });

      expect(await snapshots(draft.id)).toEqual([]);
      expect(await statusOf(draft.id)).toBe('in_review');
    });
  });

  describe('ручная публикация и снятие', () => {
    it('без согласованной версии — 409 invalid_state, несуществующая группа — 404', async () => {
      const draft = await readyDraft(api, a);
      const res = await post(publisher, draft.id, 'publish');
      expect(res.statusCode).toBe(409);
      expect(errorOf(res).code).toBe('invalid_state');

      // уже опубликованная группа: ожидающей версии нет
      const live = await approved(api, a);
      const again = await post(publisher, live.id, 'publish');
      expect(again.statusCode).toBe(409);
      expect(errorOf(again).code).toBe('invalid_state');

      const none = await post(publisher, missing, 'publish');
      expect(none.statusCode).toBe(404);
      expect(errorOf(none).code).toBe('not_found');
      expect(await snapshots(draft.id)).toEqual([]);
    });

    it('период показа согласованной версии закончился — 409, версия остаётся ожидающей', async () => {
      const t0 = Date.now();
      const endAt = t0 + 120_000;
      const grp = await approved(api, a, {
        startAt: new Date(t0 + 60_000).toISOString(),
        endAt: new Date(endAt).toISOString(),
      });
      expect(grp.status).toBe('approved');
      for (const time of [endAt, endAt + 60_000]) {
        await at(time, async () => {
          const res = await post(publisher, grp.id, 'publish');
          expect(res.statusCode).toBe(409);
          expect(errorOf(res)).toMatchObject({
            code: 'invalid_state',
            message: 'Период показа согласованной версии закончился',
          });
        });
      }
      const snaps = await snapshots(grp.id);
      expect(snaps.map((s) => ({ state: s.state, publishedAt: s.publishedAt }))).toEqual([
        { state: 'approved', publishedAt: null },
      ]);
      expect(await statusOf(grp.id)).toBe('approved');

      const versions = await read(grp.id, 'versions');
      expect(versions.statusCode).toBe(200);
      expect(versions.json()).toEqual({
        items: [
          expect.objectContaining({
            version: 1,
            state: 'approved',
            approvedBy: { id: a.lead.userId, name: expect.any(String) },
            publishedAt: null,
            archivedAt: null,
          }),
        ],
      });
    });

    it('две одновременные ручные публикации: успешна ровно одна, вторая — 409 invalid_state', async () => {
      const grp = await scheduled(api, a);
      expect(grp.status).toBe('approved');
      // Первая публикация ждёт на копировании медиа, пока вторая не пройдёт все проверки:
      // обе доходят до транзакции со снимком в состоянии approved, гонку разрешает БД.
      const original = api.storage.copy.bind(api.storage);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let firstBatch: 'none' | 'open' | 'closed' = 'none';
      let bothAtCopy = false;
      api.storage.copy = async (...args) => {
        if (firstBatch === 'none') {
          // все файлы одной публикации копируются одной синхронной пачкой
          firstBatch = 'open';
          queueMicrotask(() => {
            firstBatch = 'closed';
          });
        } else if (firstBatch === 'closed') {
          bothAtCopy = true;
          release();
        }
        await gate;
        return original(...args);
      };
      let results;
      try {
        // если какой-то запрос завершится, не дойдя до копирования, шлюз открывается,
        // и тест падает на проверке bothAtCopy, а не зависает до таймаута
        results = await Promise.all([
          post(publisher, grp.id, 'publish').finally(release),
          post(publisher, grp.id, 'publish').finally(release),
        ]);
      } finally {
        api.storage.copy = original;
      }
      // гонка действительно состоялась: обе публикации прошли проверки снимка
      expect(bothAtCopy).toBe(true);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      const winner = results.find((r) => r.statusCode === 200)!;
      const loser = results.find((r) => r.statusCode === 409)!;
      expect(winner.json<AdminGroup>()).toMatchObject({ status: 'published', liveVersion: 1 });
      expect(errorOf(loser)).toMatchObject({
        code: 'invalid_state',
        message: 'Версия уже опубликована или отменена',
      });

      expect((await snapshots(grp.id)).map((s) => s.state)).toEqual(['published']);
      expect(
        await api.db.owner.auditLog.count({
          where: { action: 'group.published', entityId: grp.id },
        }),
      ).toBe(1);
      expect(
        api.adapters.siem.events.filter(
          (e) => e.type === 'group.published' && e.details?.groupId === grp.id,
        ),
      ).toHaveLength(1);
    });

    it('снять можно только опубликованную группу: черновик — 409, несуществующая — 404', async () => {
      const draft = await readyDraft(api, a);
      const res = await post(publisher, draft.id, 'unpublish', {});
      expect(res.statusCode).toBe(409);
      expect(errorOf(res).code).toBe('invalid_state');
      const none = await post(publisher, missing, 'unpublish', {});
      expect(none.statusCode).toBe(404);
      expect(errorOf(none).code).toBe('not_found');
      expect(
        await api.db.owner.auditLog.count({
          where: { action: 'group.unpublished', entityId: draft.id },
        }),
      ).toBe(0);
      expect(await statusOf(draft.id)).toBe('draft');
    });
  });

  describe('diff, превью и версии', () => {
    it('для несуществующей группы — 404', async () => {
      for (const what of ['diff', 'preview', 'versions'] as const) {
        const res = await read(missing, what);
        expect(res.statusCode, what).toBe(404);
        expect(errorOf(res).code).toBe('not_found');
      }
    });

    it('версии группы без снимков — пустой список', async () => {
      const draft = await readyDraft(api, a);
      const res = await read(draft.id, 'versions');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ items: [] });
    });

    it('история версий: заменённая и снятая версии с авторами согласования', async () => {
      const v1 = await approved(api, a, { title: 'Версия 1' });
      expect(v1.status).toBe('published');
      const edited = await api.admin(a.editor2, 'PATCH', `/admin/v1/groups/${v1.id}`, {
        revision: v1.revision,
        title: 'Версия 2',
      });
      const review = await submit(edited.json<AdminGroup>());
      const v2 = await post(publisher, v1.id, 'approve', { revision: review.revision });
      expect(v2.json<AdminGroup>()).toMatchObject({ status: 'published', liveVersion: 2 });
      expect(
        (await post(publisher, v1.id, 'unpublish', { reason: 'конец акции' })).statusCode,
      ).toBe(200);

      const res = await read(v1.id, 'versions');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        items: [
          expect.objectContaining({
            version: 2,
            state: 'archived',
            approvedBy: { id: publisher.userId, name: expect.any(String) },
            publishedAt: expect.any(String),
            archivedAt: expect.any(String),
          }),
          expect.objectContaining({
            version: 1,
            state: 'superseded',
            approvedBy: { id: a.lead.userId, name: expect.any(String) },
            publishedAt: expect.any(String),
            archivedAt: null,
          }),
        ],
      });
    });

    it('diff никогда не публиковавшейся группы: baseVersion null, слайды — добавленные', async () => {
      const draft = await readyDraft(api, a);
      const slide = draft.slides[0]!;
      const res = await read(draft.id, 'diff');
      expect(res.statusCode).toBe(200);
      const diff = res.json<GroupDiff>();
      expect(diff.baseVersion).toBeNull();
      expect(diff.revision).toBe(draft.revision);
      expect(diff.changes).toContainEqual({ path: 'title', before: null, after: 'Новинки осени' });
      const slideChanges = diff.changes.filter((c) => c.path.startsWith('slides['));
      expect(slideChanges).toEqual([
        {
          path: `slides[${slide.id}]`,
          before: null,
          after: expect.objectContaining({
            id: slide.id,
            type: 'image',
            mediaAssetId: slide.mediaAssetId,
          }),
        },
      ]);
    });

    it('превью с необработанным медиа: предупреждения и обложка из первого слайда', async () => {
      const uploadedBy = a.editor2.userId;
      const cover = await rawImageAsset(api, {
        purpose: 'cover',
        status: 'processing',
        uploadedBy,
      });
      const corrupted = await rawImageAsset(api, {
        purpose: 'slide',
        status: 'ready',
        uploadedBy,
        variants: { images: 'не массив' },
      });
      const image = await createReadyAsset(api, { kind: 'image', purpose: 'slide', uploadedBy });
      const created = await api.admin(
        a.editor2,
        'POST',
        '/admin/v1/groups',
        groupInput({ coverAssetId: cover }),
      );
      expect(created.statusCode, created.body).toBe(201);
      const grp = created.json<AdminGroup>();
      await addSlide(grp.id, { type: 'image', mediaAssetId: image, durationMs: 5000 });
      const full = await addSlide(grp.id, {
        type: 'image',
        mediaAssetId: corrupted,
        durationMs: 5000,
      });

      const res = await read(grp.id, 'preview');
      expect(res.statusCode, res.body).toBe(200);
      const preview = res.json<GroupPreview>();
      expect(preview.warnings).toEqual([
        'Обложка: файл ещё обрабатывается',
        'Слайд 2: повреждены данные медиа',
      ]);
      expect(preview.feed.groups).toHaveLength(1);
      const group = preview.feed.groups[0]!;
      expect(group.version).toBe(full.revision);
      expect(group.slides.map((s) => s.id)).toEqual([full.slides[0]!.id]);
      const first = group.slides[0]!;
      if (first.type !== 'image') throw new Error('ожидался слайд-картинка');
      const smallest = first.media.variants.at(-1)!;
      expect(group.cover).toEqual({ url: smallest.url, w: 720, h: 1280 });
      // черновые медиа — только подписанные URL с TTL 15 минут
      expect(group.cover.url).toContain('X-Amz-Expires=900');
      expect(preview.mediaOrigins).toEqual(['http://s3.test']);
    });

    it('превью пустого черновика: группы нет, только предупреждения', async () => {
      const created = await api.admin(a.editor2, 'POST', '/admin/v1/groups', groupInput());
      expect(created.statusCode, created.body).toBe(201);
      const res = await read(created.json<AdminGroup>().id, 'preview');
      expect(res.statusCode).toBe(200);
      const preview = res.json<GroupPreview>();
      expect(preview.feed.groups).toEqual([]);
      expect(preview.mediaOrigins).toEqual([]);
      expect(preview.warnings).toEqual(['Обложка: не выбрано медиа', 'В группе нет слайдов']);
    });
  });
});

describe('блокировка пользователя администратором завершает его сессии', () => {
  let api: TestApi;
  let admin: Session;

  beforeAll(async () => {
    api = await createTestApi();
    admin = await api.login('mock-admin');
  });
  afterAll(async () => {
    await api.close();
  });

  const sid = (s: Session) => s.cookie.split('=')[1]!;
  const setDisabled = (userId: string, disabled: boolean) =>
    api.admin(admin, 'PUT', `/admin/v1/users/${userId}/status`, { disabled });

  it('все сессии удаляются сразу: 401, событие user.status_changed и запись аудита', async () => {
    const first = await api.login('mock-analyst');
    const second = await api.login('mock-analyst');
    for (const s of [first, second]) {
      expect((await api.admin(s, 'GET', '/admin/v1/auth/me')).statusCode).toBe(200);
      expect(await api.sessions.get(sid(s))).not.toBeNull();
    }

    const before = api.adapters.siem.events.length;
    const res = await setDisabled(first.userId, true);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ id: first.userId, disabled: true });

    // сессии удалены из Redis до следующего запроса пользователя, а не лениво при проверке
    expect(await api.sessions.get(sid(first))).toBeNull();
    expect(await api.sessions.get(sid(second))).toBeNull();
    expect(await api.deps.sessionRedis.exists(api.deps.keys.userSessions(first.userId))).toBe(0);

    for (const s of [first, second]) {
      expect((await api.admin(s, 'GET', '/admin/v1/auth/me')).statusCode).toBe(401);
    }
    expect(api.adapters.siem.events.slice(before)).toContainEqual(
      expect.objectContaining({
        type: 'user.status_changed',
        actorId: admin.userId,
        details: { userId: first.userId, disabled: true },
      }),
    );
    const audit = await api.db.owner.auditLog.findFirstOrThrow({
      where: { action: 'user.status_changed', entityId: first.userId },
    });
    expect(audit).toMatchObject({
      actorId: admin.userId,
      diff: { before: { disabled: false }, after: { disabled: true } },
    });
    // сессия администратора не затронута
    expect((await api.admin(admin, 'GET', '/admin/v1/auth/me')).statusCode).toBe(200);
  });

  it('после разблокировки старая сессия не оживает — нужен новый вход', async () => {
    const old = await api.login('mock-editor');
    expect((await setDisabled(old.userId, true)).statusCode).toBe(200);
    const before = api.adapters.siem.events.length;
    const unblocked = await setDisabled(old.userId, false);
    expect(unblocked.statusCode, unblocked.body).toBe(200);
    expect(unblocked.json()).toMatchObject({ disabled: false });
    expect(api.adapters.siem.events.slice(before)).toContainEqual(
      expect.objectContaining({
        type: 'user.status_changed',
        details: { userId: old.userId, disabled: false },
      }),
    );

    const res = await api.admin(old, 'GET', '/admin/v1/auth/me');
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).message).toBe('Сессия истекла, войдите снова');
    const fresh = await api.login('mock-editor');
    expect((await api.admin(fresh, 'GET', '/admin/v1/auth/me')).statusCode).toBe(200);
  });

  it('идентификатор сессии неверного формата — 401 без обращения к Redis', async () => {
    const [name, value] = admin.cookie.split('=') as [string, string];
    const lookups = vi.spyOn(api.deps.sessionRedis, 'get');
    try {
      for (const bad of ['short', `${value}x`, `${value.slice(0, 42)}.`]) {
        expect(await api.sessions.get(bad)).toBeNull();
        const res = await api.adminApp.inject({
          method: 'GET',
          url: '/admin/v1/auth/me',
          headers: { cookie: `${name}=${bad}` },
        });
        expect(res.statusCode, bad).toBe(401);
        expect(errorOf(res).code).toBe('unauthorized');
      }
      // формат проверяется до поиска в Redis: мусор из cookie не превращается в запросы
      expect(lookups).not.toHaveBeenCalled();
      expect((await api.admin(admin, 'GET', '/admin/v1/auth/me')).statusCode).toBe(200);
      expect(lookups).toHaveBeenCalled();
    } finally {
      lookups.mockRestore();
    }
  });
});

describe('сегменты покупателя, когда кеш-соединение Redis оборвалось', () => {
  let api: TestApi;
  let targeted: AdminGroup;

  // Кеш рвём у работающего сервиса, а не поднимаем сервис на недоступном порту: если закрыть
  // сервис, пока его соединение очередей BullMQ ещё переподключается, init() очередей
  // отклоняется уже без слушателей — два unhandled rejection (ECONNREFUSED) валят весь прогон.
  beforeAll(async () => {
    api = await createTestApi();
    targeted = await approved(api, await actors(api), {
      placement: 'home',
      segmentIds: ['seg_loyal_gold'],
      title: 'Только для Gold',
    });
  });
  afterAll(async () => {
    await api.close();
  });

  const feed = (headers: Record<string, string> = {}) =>
    api.publicApp.inject({
      method: 'GET',
      url: '/v1/feed?placement=home',
      headers: { 'x-platform': 'web', ...headers },
    });

  it('чтение кеша падает — сегменты берутся из адаптера, ответ 200 и приватный', async () => {
    expect(targeted.status).toBe('published');
    let calls = 0;
    const original = api.adapters.segments.getUserSegments.bind(api.adapters.segments);
    api.adapters.segments.getUserSegments = (id) => {
      calls += 1;
      return original(id);
    };
    try {
      const token = await api.adapters.customerAuth.issue('user-gold-1');
      const personal = async () => {
        const res = await feed({ authorization: `Bearer ${token}` });
        expect(res.statusCode, res.body).toBe(200);
        expect(res.headers['cache-control']).toBe('private, no-store');
        expect(res.json<FeedResponse>().groups.map((g) => g.id)).toEqual([targeted.id]);
      };

      // контроль: пока Redis жив, второй запрос берёт сегменты из кеша
      await personal();
      await personal();
      expect(calls).toBe(1);

      const ended = once(api.deps.redis, 'end');
      api.deps.redis.disconnect();
      await ended;
      await expect(api.deps.redis.get('probe')).rejects.toThrow();

      // кеш недоступен: каждый запрос идёт в адаптер, таргетинг по-прежнему работает
      await personal();
      await personal();
      expect(calls).toBe(3);
    } finally {
      api.adapters.segments.getUserSegments = original;
    }

    const anon = await feed();
    expect(anon.statusCode).toBe(200);
    expect(anon.headers['cache-control']).toMatch(/^public, max-age=\d+$/);
    expect(anon.json<FeedResponse>().groups).toEqual([]);
  });
});
