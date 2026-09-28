import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FEED_PURGE_PATHS,
  MediaVariants,
  SYSTEM_CONTEXT,
  adapterErrorsTotal,
  invalidateFeed,
  publicationsTotal,
  publishSnapshot,
  runSchedulerTick,
  unpublishGroup,
  variantFiles,
  type AuditContext,
} from '@idb-stories/core';
import type { Prisma } from '@idb-stories/db';
import type { AdminGroup } from '@idb-stories/schema';
import { createReadyAsset, createTestApi, type Session, type TestApi } from './helpers.js';
import { actors, approved, readyDraft, scheduled, type Actors } from './fixtures.js';

const DAY = 86_400_000;
/** Среда, 12:00 по Москве — рабочее время. */
const BUSINESS_TIME = new Date('2026-09-30T09:00:00Z');
/** Суббота, 03:00 по Москве — вне рабочего времени. */
const NIGHT_TIME = new Date('2026-10-03T00:00:00Z');

interface LogEntry {
  level: string;
  msg: string;
  err?: { message?: string };
  [key: string]: unknown;
}

/** Записи лога, появившиеся после отметки `from` (индекс в api.logs). */
function logsSince(api: TestApi, from: number): LogEntry[] {
  return api.logs
    .slice(from)
    .flatMap((chunk) => chunk.split('\n').filter((l) => l.trim() !== ''))
    .map((l) => JSON.parse(l) as LogEntry);
}

const errorsSince = (api: TestApi, from: number, msg: string) =>
  logsSince(api, from).filter((e) => e.level === 'error' && e.msg === msg);

async function feedGeneration(api: TestApi): Promise<number> {
  return Number((await api.deps.redis.get(api.deps.keys.feedGeneration)) ?? '0');
}

async function counterValue(
  counter: typeof publicationsTotal | typeof adapterErrorsTotal,
  labels: Record<string, string>,
): Promise<number> {
  const { values } = await counter.get();
  return values
    .filter((v) => {
      const actual = v.labels as Record<string, string | number | undefined>;
      return Object.entries(labels).every(([k, val]) => actual[k] === val);
    })
    .reduce((sum, v) => sum + v.value, 0);
}

async function pendingSnapshot(api: TestApi, groupId: string) {
  return api.db.owner.publishedSnapshot.findFirstOrThrow({
    where: { groupId, state: 'approved' },
  });
}

async function auditFor(api: TestApi, groupId: string, action: string) {
  return api.db.owner.auditLog.findMany({
    where: { entityType: 'group', entityId: groupId, action },
    orderBy: { id: 'asc' },
  });
}

/** Ключи в публичном bucket, относящиеся к медиа-ассету. */
async function publicKeysOf(api: TestApi, assetId: string): Promise<string[]> {
  const asset = await api.db.owner.mediaAsset.findUniqueOrThrow({ where: { id: assetId } });
  const prefix = `${api.config.s3.buckets.public}/${asset.storageKey}/`;
  return [...api.storage.objects.keys()].filter((k) => k.startsWith(prefix));
}

/** Все файлы вариантов медиа снимка (ключ и MIME). */
async function snapshotFiles(api: TestApi, mediaAssetIds: string[]) {
  const assets = await api.db.owner.mediaAsset.findMany({ where: { id: { in: mediaAssetIds } } });
  expect(assets).toHaveLength(mediaAssetIds.length);
  return assets.flatMap((a) => variantFiles(MediaVariants.parse(a.variants)));
}

/** Сколько файлов копируется в публичный bucket при публикации снимка. */
async function filesToCopy(api: TestApi, mediaAssetIds: string[]): Promise<number> {
  return (await snapshotFiles(api, mediaAssetIds)).length;
}

/**
 * Каждый файл каждого медиа снимка лежит в публичном bucket под тем же ключом,
 * с исходным MIME и долгим immutable-кешем. Возвращает число файлов.
 */
async function expectAllInPublic(api: TestApi, mediaAssetIds: string[]): Promise<number> {
  const files = await snapshotFiles(api, mediaAssetIds);
  for (const f of files) {
    expect(
      api.storage.objects.get(`${api.config.s3.buckets.public}/${f.key}`),
      `файл ${f.key} не скопирован в public`,
    ).toMatchObject({ contentType: f.mime, cacheControl: 'public, max-age=31536000, immutable' });
  }
  return files.length;
}

/**
 * Задерживает копирование в публичный bucket, пока не придут все ожидаемые вызовы:
 * так оба конкурента гарантированно проходят проверку состояния до транзакции.
 */
function holdCopiesUntil(api: TestApi, expectedCalls: number) {
  const original = api.storage.copy.bind(api.storage);
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return vi.spyOn(api.storage, 'copy').mockImplementation(async (src, dst, opts) => {
    arrived += 1;
    if (arrived === expectedCalls) release();
    await gate;
    return original(src, dst, opts);
  });
}

async function ok<T>(p: Promise<{ statusCode: number; body: string; json: () => unknown }>) {
  const res = await p;
  expect([200, 201], res.body).toContain(res.statusCode);
  return res.json() as T;
}

/**
 * Согласованная группа со стартом через сутки и тремя слайдами:
 * CTA-категория (из фикстуры), CTA-ссылка на домен ИДБ и слайд без CTA.
 */
async function scheduledWithUrlCta(api: TestApi, a: Actors) {
  const now = Date.now();
  const draft = await readyDraft(api, a, {
    startAt: new Date(now + DAY).toISOString(),
    endAt: new Date(now + 7 * DAY).toISOString(),
  });
  const urlImage = await createReadyAsset(api, {
    kind: 'image',
    purpose: 'slide',
    uploadedBy: a.editor2.userId,
  });
  const plainImage = await createReadyAsset(api, {
    kind: 'image',
    purpose: 'slide',
    uploadedBy: a.editor2.userId,
  });
  await ok<AdminGroup>(
    api.admin(a.editor2, 'POST', `/admin/v1/groups/${draft.id}/slides`, {
      type: 'image',
      mediaAssetId: urlImage,
      cta: { type: 'url', value: 'https://promo.iledebeaute.ru/sale', label: 'Купить' },
    }),
  );
  const g = await ok<AdminGroup>(
    api.admin(a.editor2, 'POST', `/admin/v1/groups/${draft.id}/slides`, {
      type: 'image',
      mediaAssetId: plainImage,
    }),
  );
  const submitted = await ok<AdminGroup>(
    api.admin(a.editor2, 'POST', `/admin/v1/groups/${g.id}/submit`, { revision: g.revision }),
  );
  const approvedGroup = await ok<AdminGroup>(
    api.admin(a.lead, 'POST', `/admin/v1/groups/${g.id}/approve`, {
      revision: submitted.revision,
    }),
  );
  expect(approvedGroup.status).toBe('approved');
  const urlSlide = approvedGroup.slides.find((s) => s.cta?.type === 'url');
  expect(urlSlide).toBeDefined();
  return { group: approvedGroup, urlSlideId: urlSlide!.id, urlImage, plainImage };
}

/** Сужает allowlist доменов через API администратора (как это сделал бы ИБ). */
async function setUrlDomains(api: TestApi, admin: Session, urlDomains: string[]) {
  const res = await api.admin(admin, 'PUT', '/admin/v1/settings/allowlist', {
    deeplinkSchemes: ['idb'],
    urlDomains,
  });
  expect(res.statusCode, res.body).toBe(200);
}

describe('публикация снимков: publishSnapshot, unpublishGroup, invalidateFeed', () => {
  let api: TestApi;
  let a: Actors;
  let admin: Session;
  let ctx: AuditContext;

  beforeAll(async () => {
    api = await createTestApi();
    a = await actors(api);
    admin = await api.login('mock-admin');
    ctx = { actorId: a.lead.userId, ip: '10.1.2.3', requestId: 'req-publishing' };
  });
  afterAll(async () => {
    await api.close();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('invalidateFeed: сбой CDN purge не ломает операцию — поколение кеша растёт, ошибка в логе', async () => {
    const mark = api.logs.length;
    const genBefore = await feedGeneration(api);
    const errorsBefore = await counterValue(adapterErrorsTotal, { adapter: 'cdn-purge' });
    const purge = vi
      .spyOn(api.adapters.cdnPurge, 'purge')
      .mockRejectedValue(new Error('CDN недоступен'));

    await expect(invalidateFeed(api.deps.publishing, 'тест сбоя CDN')).resolves.toBeUndefined();

    expect(purge).toHaveBeenCalledWith({ paths: FEED_PURGE_PATHS, reason: 'тест сбоя CDN' });
    expect(await feedGeneration(api)).toBe(genBefore + 1);
    const logged = errorsSince(api, mark, 'CDN purge не выполнен');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      reason: 'тест сбоя CDN',
      err: { message: 'CDN недоступен' },
    });
    expect(await counterValue(adapterErrorsTotal, { adapter: 'cdn-purge' })).toBe(errorsBefore + 1);
  });

  it('публикация проходит и при недоступном CDN purge: снимок опубликован, поколение кеша выросло', async () => {
    const g = await scheduled(api, a);
    const snap = await pendingSnapshot(api, g.id);
    const mark = api.logs.length;
    const genBefore = await feedGeneration(api);
    vi.spyOn(api.adapters.cdnPurge, 'purge').mockRejectedValue(new Error('CDN недоступен'));

    const res = await publishSnapshot(api.deps.publishing, snap.id, ctx, 'manual', BUSINESS_TIME);

    expect(res).toEqual({ ok: true });
    const after = await api.db.owner.publishedSnapshot.findUniqueOrThrow({
      where: { id: snap.id },
    });
    expect(after.state).toBe('published');
    expect(await feedGeneration(api)).toBe(genBefore + 1);
    expect(errorsSince(api, mark, 'CDN purge не выполнен')[0]).toMatchObject({
      reason: `publish ${g.id} v1`,
    });
  });

  it('несуществующий снимок не публикуется: not_approved', async () => {
    const res = await publishSnapshot(api.deps.publishing, randomUUID(), ctx, 'manual');
    expect(res).toEqual({ ok: false, reason: 'not_approved' });
  });

  it('повторная публикация уже опубликованного снимка: not_approved, без побочных эффектов', async () => {
    const g = await scheduled(api, a);
    const snap = await pendingSnapshot(api, g.id);
    expect(await publishSnapshot(api.deps.publishing, snap.id, ctx, 'manual')).toEqual({
      ok: true,
    });
    const published = await api.db.owner.publishedSnapshot.findUniqueOrThrow({
      where: { id: snap.id },
    });
    const purgeCalls = api.adapters.cdnPurge.calls.length;
    const genBefore = await feedGeneration(api);
    const copy = vi.spyOn(api.storage, 'copy');

    const again = await publishSnapshot(api.deps.publishing, snap.id, ctx, 'manual');

    expect(again).toEqual({ ok: false, reason: 'not_approved' });
    // медиа повторно не копируются: проверка состояния идёт до любых действий
    expect(copy).not.toHaveBeenCalled();
    const after = await api.db.owner.publishedSnapshot.findUniqueOrThrow({
      where: { id: snap.id },
    });
    expect(after.state).toBe('published');
    expect(after.publishedAt).toEqual(published.publishedAt);
    expect(await auditFor(api, g.id, 'group.published')).toHaveLength(1);
    expect(api.adapters.cdnPurge.calls.length).toBe(purgeCalls);
    expect(await feedGeneration(api)).toBe(genBefore);
  });

  it('гонка: две параллельные публикации одного снимка — успешна ровно одна', async () => {
    const g = await scheduled(api, a);
    const snap = await pendingSnapshot(api, g.id);
    const files = await filesToCopy(api, snap.mediaAssetIds);
    expect(files).toBeGreaterThan(0);
    holdCopiesUntil(api, 2 * files);
    const eventsBefore = api.adapters.siem.events.length;

    const results = await Promise.all([
      publishSnapshot(api.deps.publishing, snap.id, ctx, 'manual'),
      publishSnapshot(api.deps.publishing, snap.id, ctx, 'schedule'),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'not_approved' }]);
    const after = await api.db.owner.publishedSnapshot.findUniqueOrThrow({
      where: { id: snap.id },
    });
    expect(after.state).toBe('published');
    expect(after.supersededAt).toBeNull();
    expect(await auditFor(api, g.id, 'group.published')).toHaveLength(1);
    const published = api.adapters.siem.events
      .slice(eventsBefore)
      .filter((e) => e.type === 'group.published' && e.details?.groupId === g.id);
    expect(published).toHaveLength(1);
    const group = await api.db.owner.storyGroup.findUniqueOrThrow({ where: { id: g.id } });
    expect(group.status).toBe('published');
  });

  it('ошибка БД внутри транзакции публикации пробрасывается, снимок остаётся согласованным', async () => {
    const g = await scheduled(api, a);
    const snap = await pendingSnapshot(api, g.id);
    const genBefore = await feedGeneration(api);

    // actor_id — колонка uuid: некорректное значение роняет запрос внутри транзакции
    await expect(
      publishSnapshot(api.deps.publishing, snap.id, { actorId: 'не-uuid' }, 'manual'),
    ).rejects.toThrow(/uuid/i);

    const after = await api.db.owner.publishedSnapshot.findUniqueOrThrow({
      where: { id: snap.id },
    });
    expect(after.state).toBe('approved');
    expect(after.publishedAt).toBeNull();
    expect((await api.db.owner.storyGroup.findUniqueOrThrow({ where: { id: g.id } })).status).toBe(
      'approved',
    );
    expect(await auditFor(api, g.id, 'group.published')).toHaveLength(0);
    expect(await feedGeneration(api)).toBe(genBefore);
  });

  it('суженный allowlist блокирует публикацию: cta_not_allowed, событие cta.rejected, медиа не в public', async () => {
    const { group, urlSlideId, urlImage, plainImage } = await scheduledWithUrlCta(api, a);
    const snap = await pendingSnapshot(api, group.id);
    const eventsBefore = api.adapters.siem.events.length;
    const genBefore = await feedGeneration(api);
    await setUrlDomains(api, admin, ['example-partner.ru']);
    try {
      const res = await publishSnapshot(api.deps.publishing, snap.id, ctx, 'manual');

      expect(res).toEqual({ ok: false, reason: 'cta_not_allowed', slides: [urlSlideId] });
      const rejected = api.adapters.siem.events
        .slice(eventsBefore)
        .filter((e) => e.type === 'cta.rejected');
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({
        actorId: a.lead.userId,
        ip: '10.1.2.3',
        requestId: 'req-publishing',
        details: { stage: 'publish', groupId: group.id, version: 1, slides: [urlSlideId] },
      });
      // медиа не скопированы в публичный bucket (угроза T5)
      for (const assetId of [group.coverAssetId!, urlImage, plainImage]) {
        expect(await publicKeysOf(api, assetId)).toEqual([]);
      }
      const after = await api.db.owner.publishedSnapshot.findUniqueOrThrow({
        where: { id: snap.id },
      });
      expect(after.state).toBe('approved');
      expect(await auditFor(api, group.id, 'group.published')).toHaveLength(0);
      expect(await feedGeneration(api)).toBe(genBefore);
    } finally {
      await setUrlDomains(api, admin, ['iledebeaute.ru']);
    }

    // после возврата домена та же версия публикуется, и в public попадают все файлы снимка —
    // обложка и три слайда дают 14 файлов, больше одной пачки параллельного копирования
    expect(await publishSnapshot(api.deps.publishing, snap.id, ctx, 'manual')).toEqual({
      ok: true,
    });
    expect(await expectAllInPublic(api, snap.mediaAssetIds)).toBe(14);
  });

  it('публикация переводит рабочую копию в published и пишет аудит, метрику и событие', async () => {
    const g = await scheduled(api, a);
    const snap = await pendingSnapshot(api, g.id);
    const eventsBefore = api.adapters.siem.events.length;
    const purgeBefore = api.adapters.cdnPurge.calls.length;
    const labels = { action: 'publish', trigger: 'manual', business_hours: 'yes' };
    const metricBefore = await counterValue(publicationsTotal, labels);

    const res = await publishSnapshot(api.deps.publishing, snap.id, ctx, 'manual', BUSINESS_TIME);

    expect(res).toEqual({ ok: true });
    const after = await api.db.owner.publishedSnapshot.findUniqueOrThrow({
      where: { id: snap.id },
    });
    expect(after).toMatchObject({
      state: 'published',
      publishedAt: BUSINESS_TIME,
      publishedById: a.lead.userId,
    });
    const group = await api.db.owner.storyGroup.findUniqueOrThrow({ where: { id: g.id } });
    expect(group.status).toBe('published');
    const audit = await auditFor(api, g.id, 'group.published');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: a.lead.userId,
      ip: '10.1.2.3',
      requestId: 'req-publishing',
      diff: { version: 1, trigger: 'manual' },
    });
    expect(api.adapters.cdnPurge.calls.slice(purgeBefore)).toEqual([
      { paths: FEED_PURGE_PATHS, reason: `publish ${g.id} v1` },
    ]);
    expect(
      api.adapters.siem.events
        .slice(eventsBefore)
        .filter((e) => e.type === 'group.published')
        .map((e) => e.details),
    ).toEqual([{ groupId: g.id, version: 1, trigger: 'manual' }]);
    expect(await counterValue(publicationsTotal, labels)).toBe(metricBefore + 1);
    // все файлы снимка (обложка и слайд) — в публичном bucket с исходным MIME и долгим кешем
    expect(snap.mediaAssetIds).toEqual(expect.arrayContaining([g.coverAssetId!]));
    expect(await expectAllInPublic(api, snap.mediaAssetIds)).toBe(6);
  });

  it('публикация вне рабочего времени помечается в метрике', async () => {
    const g = await scheduled(api, a);
    const snap = await pendingSnapshot(api, g.id);
    const labels = { action: 'publish', trigger: 'schedule', business_hours: 'no' };
    const before = await counterValue(publicationsTotal, labels);

    expect(
      await publishSnapshot(api.deps.publishing, snap.id, SYSTEM_CONTEXT, 'schedule', NIGHT_TIME),
    ).toEqual({ ok: true });

    expect(await counterValue(publicationsTotal, labels)).toBe(before + 1);
    const after = await api.db.owner.publishedSnapshot.findUniqueOrThrow({
      where: { id: snap.id },
    });
    expect(after.publishedById).toBeNull();
  });

  it('новая версия вытесняет опубликованную: прежняя становится superseded', async () => {
    const g = await approved(api, a, { placement: 'cart' });
    expect(g.status).toBe('published');
    const edited = await ok<AdminGroup>(
      api.admin(a.editor2, 'PATCH', `/admin/v1/groups/${g.id}`, {
        revision: g.revision,
        title: 'Версия 2',
        startAt: new Date(Date.now() + DAY).toISOString(),
      }),
    );
    const submitted = await ok<AdminGroup>(
      api.admin(a.editor2, 'POST', `/admin/v1/groups/${g.id}/submit`, {
        revision: edited.revision,
      }),
    );
    await ok<AdminGroup>(
      api.admin(a.lead, 'POST', `/admin/v1/groups/${g.id}/approve`, {
        revision: submitted.revision,
      }),
    );
    const v2 = await pendingSnapshot(api, g.id);
    expect(v2.version).toBe(2);

    expect(await publishSnapshot(api.deps.publishing, v2.id, ctx, 'manual', BUSINESS_TIME)).toEqual(
      { ok: true },
    );

    const snaps = await api.db.owner.publishedSnapshot.findMany({
      where: { groupId: g.id },
      orderBy: { version: 'asc' },
    });
    expect(snaps.map((s) => [s.version, s.state])).toEqual([
      [1, 'superseded'],
      [2, 'published'],
    ]);
    expect(snaps[0]!.supersededAt).toEqual(BUSINESS_TIME);
  });

  it('правка через API после согласования отменяет ожидающий снимок: публиковать нечего', async () => {
    const g = await scheduled(api, a);
    const snap = await pendingSnapshot(api, g.id);
    const edited = await ok<AdminGroup>(
      api.admin(a.editor2, 'PATCH', `/admin/v1/groups/${g.id}`, {
        revision: g.revision,
        priority: 42,
      }),
    );
    expect(edited.status).toBe('draft');
    const cancelled = await api.db.owner.publishedSnapshot.findUniqueOrThrow({
      where: { id: snap.id },
    });
    expect(cancelled.state).toBe('superseded');
    expect(cancelled.supersededAt).not.toBeNull();
    const audit = await auditFor(api, g.id, 'group.updated');
    expect(audit.at(-1)?.diff).toMatchObject({
      cancelledPendingVersion: 1,
      statusBefore: 'approved',
    });

    expect(await publishSnapshot(api.deps.publishing, snap.id, ctx, 'manual')).toEqual({
      ok: false,
      reason: 'not_approved',
    });
    expect(await auditFor(api, g.id, 'group.published')).toHaveLength(0);
    // отменённый снимок не выводит медиа в публичный bucket (угроза T5)
    for (const assetId of snap.mediaAssetIds) {
      expect(await publicKeysOf(api, assetId)).toEqual([]);
    }
  });

  it('правка после согласования: снимок публикуется, а рабочая копия остаётся черновиком', async () => {
    // Через API правка отменяет ожидающий снимок (cancelPendingSnapshot), поэтому
    // состояние «снимок approved, рабочая копия уже изменена» готовим напрямую в БД —
    // так выглядит правка, закоммиченная между выборкой снимка и транзакцией публикации.
    const g = await scheduled(api, a);
    const snap = await pendingSnapshot(api, g.id);
    await api.db.owner.storyGroup.update({
      where: { id: g.id },
      data: { title: 'Правка после ОК', status: 'draft', revision: { increment: 1 } },
    });

    expect(await publishSnapshot(api.deps.publishing, snap.id, ctx, 'manual')).toEqual({
      ok: true,
    });

    const after = await api.db.owner.publishedSnapshot.findUniqueOrThrow({
      where: { id: snap.id },
    });
    expect(after.state).toBe('published');
    const group = await api.db.owner.storyGroup.findUniqueOrThrow({ where: { id: g.id } });
    expect(group).toMatchObject({
      status: 'draft',
      title: 'Правка после ОК',
      revision: g.revision + 1,
    });
    const view = await ok<AdminGroup>(api.admin(a.lead, 'GET', `/admin/v1/groups/${g.id}`));
    expect(view).toMatchObject({ status: 'draft', liveVersion: 1 });
  });

  it('рабочая копия ушла на другую ревизию: публикация снимка не выдаёт её за опубликованную', async () => {
    // Статус тот же (approved), но ревизия уже не та, с которой снят снимок: переводить
    // рабочую копию в published нельзя — она больше не совпадает с тем, что в ленте.
    const g = await scheduled(api, a);
    const snap = await pendingSnapshot(api, g.id);
    expect(snap.sourceRevision).toBe(g.revision);
    await api.db.owner.storyGroup.update({
      where: { id: g.id },
      data: { revision: { increment: 1 } },
    });

    expect(await publishSnapshot(api.deps.publishing, snap.id, ctx, 'manual')).toEqual({
      ok: true,
    });

    const after = await api.db.owner.publishedSnapshot.findUniqueOrThrow({
      where: { id: snap.id },
    });
    expect(after.state).toBe('published');
    const group = await api.db.owner.storyGroup.findUniqueOrThrow({ where: { id: g.id } });
    expect(group).toMatchObject({ status: 'approved', revision: g.revision + 1 });
  });

  it('медиа снимка пропало из БД: публикация падает, ничего не копируется и не меняется', async () => {
    const g = await scheduled(api, a);
    const snap = await pendingSnapshot(api, g.id);
    const slideAssetId = g.slides[0]!.mediaAssetId!;
    await api.db.owner.mediaAsset.delete({ where: { id: g.coverAssetId! } });

    await expect(publishSnapshot(api.deps.publishing, snap.id, ctx, 'manual')).rejects.toThrow(
      'Медиа снимка не найдены',
    );

    expect(await publicKeysOf(api, slideAssetId)).toEqual([]);
    const after = await api.db.owner.publishedSnapshot.findUniqueOrThrow({
      where: { id: snap.id },
    });
    expect(after.state).toBe('approved');
    expect(await auditFor(api, g.id, 'group.published')).toHaveLength(0);
  });

  it('снимок без медиа публикуется без копирования в публичный bucket', async () => {
    // Через API такой снимок не создать (обложка обязательна) — вставляем напрямую.
    const draft = await readyDraft(api, a);
    const template = await pendingSnapshot(api, (await scheduled(api, a)).id);
    const copySpy = vi.spyOn(api.storage, 'copy');
    const snap = await api.db.owner.publishedSnapshot.create({
      data: {
        groupId: draft.id,
        version: 1,
        payload: { ...(template.payload as Prisma.JsonObject), id: draft.id, slides: [] },
        source: template.source as Prisma.InputJsonValue,
        placement: template.placement,
        priority: template.priority,
        startAt: template.startAt,
        endAt: template.endAt,
        platforms: template.platforms,
        segmentIds: [],
        mediaAssetIds: [],
        sourceRevision: draft.revision,
        approvedById: a.lead.userId,
        approvedAt: new Date(),
      },
    });

    expect(await publishSnapshot(api.deps.publishing, snap.id, ctx, 'manual')).toEqual({
      ok: true,
    });

    expect(copySpy).not.toHaveBeenCalled();
    const after = await api.db.owner.publishedSnapshot.findUniqueOrThrow({
      where: { id: snap.id },
    });
    expect(after.state).toBe('published');
    // рабочая копия — черновик (не approved), её статус публикация не трогает
    const group = await api.db.owner.storyGroup.findUniqueOrThrow({ where: { id: draft.id } });
    expect(group.status).toBe('draft');
  });

  it('unpublishGroup архивирует и опубликованный, и ожидающий снимок одним действием', async () => {
    const g = await approved(api, a, { placement: 'catalog' });
    expect(g.status).toBe('published');
    const edited = await ok<AdminGroup>(
      api.admin(a.editor2, 'PATCH', `/admin/v1/groups/${g.id}`, {
        revision: g.revision,
        startAt: new Date(Date.now() + DAY).toISOString(),
      }),
    );
    const submitted = await ok<AdminGroup>(
      api.admin(a.editor2, 'POST', `/admin/v1/groups/${g.id}/submit`, {
        revision: edited.revision,
      }),
    );
    const withPending = await ok<AdminGroup>(
      api.admin(a.lead, 'POST', `/admin/v1/groups/${g.id}/approve`, {
        revision: submitted.revision,
      }),
    );
    expect(withPending).toMatchObject({ status: 'approved', liveVersion: 1 });
    const eventsBefore = api.adapters.siem.events.length;
    const purgeBefore = api.adapters.cdnPurge.calls.length;
    const genBefore = await feedGeneration(api);
    const labels = { action: 'unpublish', trigger: 'manual', business_hours: 'no' };
    const metricBefore = await counterValue(publicationsTotal, labels);

    const res = await unpublishGroup(api.deps.publishing, g.id, ctx, 'жалоба', NIGHT_TIME);

    expect([...res.archivedVersions].sort()).toEqual([1, 2]);
    const snaps = await api.db.owner.publishedSnapshot.findMany({
      where: { groupId: g.id },
      orderBy: { version: 'asc' },
    });
    expect(snaps.map((s) => [s.version, s.state, s.archivedById])).toEqual([
      [1, 'archived', a.lead.userId],
      [2, 'archived', a.lead.userId],
    ]);
    expect(snaps.every((s) => s.archivedAt?.getTime() === NIGHT_TIME.getTime())).toBe(true);
    const group = await api.db.owner.storyGroup.findUniqueOrThrow({ where: { id: g.id } });
    expect(group.status).toBe('archived');
    const audit = await auditFor(api, g.id, 'group.unpublished');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorId).toBe(a.lead.userId);
    const diff = audit[0]!.diff as { archivedVersions: number[]; reason: string };
    expect(diff.reason).toBe('жалоба');
    expect([...diff.archivedVersions].sort()).toEqual([1, 2]);
    const unpublished = api.adapters.siem.events
      .slice(eventsBefore)
      .filter((e) => e.type === 'group.unpublished');
    expect(unpublished).toHaveLength(1);
    expect(unpublished[0]).toMatchObject({
      actorId: a.lead.userId,
      ip: '10.1.2.3',
      details: { groupId: g.id, reason: 'жалоба' },
    });
    expect(api.adapters.cdnPurge.calls.slice(purgeBefore)).toEqual([
      { paths: FEED_PURGE_PATHS, reason: `unpublish ${g.id}` },
    ]);
    expect(await feedGeneration(api)).toBe(genBefore + 1);
    expect(await counterValue(publicationsTotal, labels)).toBe(metricBefore + 1);

    // повторное снятие ничего не архивирует, но фиксируется в аудите
    const again = await unpublishGroup(api.deps.publishing, g.id, ctx, null, BUSINESS_TIME);
    expect(again.archivedVersions).toEqual([]);
    const audit2 = await auditFor(api, g.id, 'group.unpublished');
    expect(audit2).toHaveLength(2);
    expect(audit2[1]!.diff).toEqual({ archivedVersions: [], reason: null });
  });

  it('снятие с публикации не трогает рабочую копию, которую уже правят', async () => {
    const g = await approved(api, a, { placement: 'product' });
    expect(g.status).toBe('published');
    await ok<AdminGroup>(
      api.admin(a.editor2, 'PATCH', `/admin/v1/groups/${g.id}`, {
        revision: g.revision,
        title: 'Черновик v2',
      }),
    );

    const res = await unpublishGroup(api.deps.publishing, g.id, ctx, null);

    expect(res.archivedVersions).toEqual([1]);
    const group = await api.db.owner.storyGroup.findUniqueOrThrow({ where: { id: g.id } });
    expect(group).toMatchObject({ status: 'draft', title: 'Черновик v2' });
    const snap = await api.db.owner.publishedSnapshot.findFirstOrThrow({
      where: { groupId: g.id },
    });
    expect(snap.state).toBe('archived');
  });
});

describe('планировщик runSchedulerTick', () => {
  let api: TestApi;
  let a: Actors;

  // Отдельная БД на каждый сценарий: тик обрабатывает все снимки в БД, счётчики должны быть точными.
  beforeEach(async () => {
    api = await createTestApi();
    a = await actors(api);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await api.close();
  });

  const tick = (at: Date) => runSchedulerTick(api.deps.publishing, SYSTEM_CONTEXT, at);

  it('нечего публиковать и архивировать: кеш и CDN не трогаются', async () => {
    await scheduled(api, a);
    const genBefore = await feedGeneration(api);
    const purgeBefore = api.adapters.cdnPurge.calls.length;

    expect(await tick(new Date())).toEqual({ published: 0, archived: 0 });

    expect(api.adapters.cdnPurge.calls.length).toBe(purgeBefore);
    expect(await feedGeneration(api)).toBe(genBefore);
  });

  it('снимок с CTA вне суженного allowlist не публикуется: ошибка в логе, счётчик 0', async () => {
    const admin = await api.login('mock-admin');
    const { group, urlSlideId } = await scheduledWithUrlCta(api, a);
    const snap = await pendingSnapshot(api, group.id);
    await setUrlDomains(api, admin, ['example-partner.ru']);
    const mark = api.logs.length;

    const res = await tick(new Date(Date.now() + DAY + 60_000));

    expect(res).toEqual({ published: 0, archived: 0 });
    const logged = errorsSince(api, mark, 'Публикация заблокирована: CTA вне allowlist');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ snapshotId: snap.id, slides: [urlSlideId] });
    expect(
      api.adapters.siem.events.some(
        (e) => e.type === 'cta.rejected' && e.details?.stage === 'publish',
      ),
    ).toBe(true);
    const after = await api.db.owner.publishedSnapshot.findUniqueOrThrow({
      where: { id: snap.id },
    });
    expect(after.state).toBe('approved');
    expect(
      (await api.db.owner.storyGroup.findUniqueOrThrow({ where: { id: group.id } })).status,
    ).toBe('approved');
  });

  it('сбой копирования медиа не валит тик: ошибка в логе, остальные снимки публикуются', async () => {
    // Здоровый снимок согласован между двумя сломанными, поэтому при любом порядке обхода
    // хотя бы один сломанный идёт раньше него: цикл обязан продолжиться после ошибки.
    const approvedAt = (offsetMs: number) => {
      api.clock.now = new Date(Date.now() + offsetMs);
    };
    approvedAt(-120_000);
    const broken1 = await scheduled(api, a);
    approvedAt(-60_000);
    const healthy = await scheduled(api, a);
    approvedAt(0);
    const broken2 = await scheduled(api, a);
    const [b1Snap, healthySnap, b2Snap] = await Promise.all(
      [broken1, healthy, broken2].map((g) => pendingSnapshot(api, g.id)),
    );
    expect(b1Snap!.approvedAt < healthySnap!.approvedAt).toBe(true);
    expect(healthySnap!.approvedAt < b2Snap!.approvedAt).toBe(true);
    const brokenCovers = await api.db.owner.mediaAsset.findMany({
      where: { id: { in: [broken1.coverAssetId!, broken2.coverAssetId!] } },
    });
    const brokenPrefixes = brokenCovers.map((c) => `${c.storageKey}/`);
    const original = api.storage.copy.bind(api.storage);
    vi.spyOn(api.storage, 'copy').mockImplementation((src, dst, opts) =>
      brokenPrefixes.some((p) => src.key.startsWith(p))
        ? Promise.reject(new Error('S3 недоступен'))
        : original(src, dst, opts),
    );
    const mark = api.logs.length;

    const res = await tick(new Date(Date.now() + DAY + 60_000));

    expect(res).toEqual({ published: 1, archived: 0 });
    const logged = errorsSince(api, mark, 'Не удалось опубликовать снимок по расписанию');
    expect(logged.map((e) => e.snapshotId).sort()).toEqual([b1Snap!.id, b2Snap!.id].sort());
    for (const e of logged) expect(e.err?.message).toBe('S3 недоступен');
    const states = await api.db.owner.publishedSnapshot.findMany({
      where: { id: { in: [b1Snap!.id, healthySnap!.id, b2Snap!.id] } },
      select: { id: true, state: true },
    });
    expect(Object.fromEntries(states.map((s) => [s.id, s.state]))).toEqual({
      [b1Snap!.id]: 'approved',
      [healthySnap!.id]: 'published',
      [b2Snap!.id]: 'approved',
    });
    const healthyAudit = await auditFor(api, healthy.id, 'group.published');
    expect(healthyAudit).toHaveLength(1);
    expect(healthyAudit[0]).toMatchObject({
      actorId: null,
      diff: { version: 1, trigger: 'schedule' },
    });
  });

  it('параллельные тики публикуют снимок ровно один раз и не пишут ошибок', async () => {
    const g = await scheduled(api, a);
    const snap = await pendingSnapshot(api, g.id);
    holdCopiesUntil(api, 2 * (await filesToCopy(api, snap.mediaAssetIds)));
    const mark = api.logs.length;
    const at = new Date(Date.now() + DAY + 60_000);

    const [t1, t2] = await Promise.all([tick(at), tick(at)]);

    expect(t1.published + t2.published).toBe(1);
    expect(logsSince(api, mark).filter((e) => e.level === 'error')).toEqual([]);
    expect(await auditFor(api, g.id, 'group.published')).toHaveLength(1);
    const after = await api.db.owner.publishedSnapshot.findUniqueOrThrow({
      where: { id: snap.id },
    });
    expect(after.state).toBe('published');
  });

  it('согласованный, но так и не опубликованный снимок архивируется после end_at', async () => {
    const g = await scheduled(api, a);
    const snap = await pendingSnapshot(api, g.id);
    const genBefore = await feedGeneration(api);
    const at = new Date(Date.now() + 8 * DAY);

    const res = await tick(at);

    expect(res).toEqual({ published: 0, archived: 1 });
    const after = await api.db.owner.publishedSnapshot.findUniqueOrThrow({
      where: { id: snap.id },
    });
    expect(after).toMatchObject({ state: 'archived', archivedAt: at, publishedAt: null });
    expect(after.archivedById).toBeNull();
    const group = await api.db.owner.storyGroup.findUniqueOrThrow({ where: { id: g.id } });
    expect(group.status).toBe('archived');
    const audit = await auditFor(api, g.id, 'group.expired');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: null, diff: { version: 1, wasState: 'approved' } });
    expect(api.adapters.cdnPurge.calls.at(-1)).toEqual({
      paths: FEED_PURGE_PATHS,
      reason: 'expired 1',
    });
    expect(await feedGeneration(api)).toBe(genBefore + 1);
    // повторный тик ничего не делает
    expect(await tick(new Date(at.getTime() + 60_000))).toEqual({ published: 0, archived: 0 });
  });

  it('истёкшая публикация архивируется, а изменённая рабочая копия остаётся черновиком', async () => {
    const g = await approved(api, a, { endAt: new Date(Date.now() + 2 * DAY).toISOString() });
    expect(g.status).toBe('published');
    await ok<AdminGroup>(
      api.admin(a.editor2, 'PATCH', `/admin/v1/groups/${g.id}`, {
        revision: g.revision,
        title: 'Новая редакция',
      }),
    );

    const res = await tick(new Date(Date.now() + 3 * DAY));

    expect(res).toEqual({ published: 0, archived: 1 });
    const snap = await api.db.owner.publishedSnapshot.findFirstOrThrow({
      where: { groupId: g.id },
    });
    expect(snap.state).toBe('archived');
    const group = await api.db.owner.storyGroup.findUniqueOrThrow({ where: { id: g.id } });
    expect(group).toMatchObject({ status: 'draft', title: 'Новая редакция' });
    const audit = await auditFor(api, g.id, 'group.expired');
    expect(audit[0]).toMatchObject({ diff: { version: 1, wasState: 'published' } });
  });

  it('истечение старой версии не архивирует группу, у которой согласована новая версия', async () => {
    const now = Date.now();
    const g = await approved(api, a, { endAt: new Date(now + 2 * DAY).toISOString() });
    expect(g.status).toBe('published');
    // v2 с новым периодом показа согласована, но стартует позже, чем истекает v1
    const edited = await ok<AdminGroup>(
      api.admin(a.editor2, 'PATCH', `/admin/v1/groups/${g.id}`, {
        revision: g.revision,
        startAt: new Date(now + 5 * DAY).toISOString(),
        endAt: new Date(now + 10 * DAY).toISOString(),
      }),
    );
    const submitted = await ok<AdminGroup>(
      api.admin(a.editor2, 'POST', `/admin/v1/groups/${g.id}/submit`, {
        revision: edited.revision,
      }),
    );
    const withPending = await ok<AdminGroup>(
      api.admin(a.lead, 'POST', `/admin/v1/groups/${g.id}/approve`, {
        revision: submitted.revision,
      }),
    );
    expect(withPending).toMatchObject({ status: 'approved', liveVersion: 1 });
    const v2 = await pendingSnapshot(api, g.id);

    expect(await tick(new Date(now + 3 * DAY))).toEqual({ published: 0, archived: 1 });

    const states = await api.db.owner.publishedSnapshot.findMany({
      where: { groupId: g.id },
      orderBy: { version: 'asc' },
    });
    expect(states.map((s) => [s.version, s.state])).toEqual([
      [1, 'archived'],
      [2, 'approved'],
    ]);
    // рабочая копия соответствует v2, а не истёкшей v1: она по-прежнему ждёт публикации
    const waiting = await api.db.owner.storyGroup.findUniqueOrThrow({ where: { id: g.id } });
    expect(waiting.status).toBe('approved');
    expect(await auditFor(api, g.id, 'group.expired')).toMatchObject([
      { diff: { version: 1, wasState: 'published' } },
    ]);

    // в свой start_at v2 выходит, и рабочая копия становится опубликованной
    expect(await tick(new Date(now + 5 * DAY + 60_000))).toEqual({ published: 1, archived: 0 });
    const live = await api.db.owner.publishedSnapshot.findUniqueOrThrow({ where: { id: v2.id } });
    expect(live.state).toBe('published');
    const group = await api.db.owner.storyGroup.findUniqueOrThrow({ where: { id: g.id } });
    expect(group.status).toBe('published');
  });
});
