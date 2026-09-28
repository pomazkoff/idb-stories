import type { CdnPurgeAdapter, ObjectStorage } from '@idb-stories/adapters';
import type { Prisma, PrismaClient } from '@idb-stories/db';
import { checkCta, type FeedGroup } from '@idb-stories/schema';
import { writeAudit, type AuditContext } from './audit.js';
import { bumpFeedGeneration } from './feed/service.js';
import type { Logger } from './logger.js';
import { MediaVariants, PUBLIC_MEDIA_CACHE_CONTROL, variantFiles } from './media.js';
import { adapterErrorsTotal, publicationsTotal } from './metrics.js';
import type { Redis, RedisKeys } from './redis.js';
import type { SecurityLog } from './security.js';
import { readAllowlist } from './settings.js';
import { isBusinessHours } from './time.js';

export interface PublishingDeps {
  prisma: PrismaClient;
  storage: ObjectStorage;
  buckets: { media: string; public: string };
  redis: Redis;
  keys: RedisKeys;
  cdnPurge: CdnPurgeAdapter;
  security: SecurityLog;
  logger: Logger;
}

export type PublishTrigger = 'manual' | 'approve' | 'schedule';

/** Путь ленты в CDN, который сбрасывается при любом изменении состава ленты. */
export const FEED_PURGE_PATHS = ['/v1/feed'];

/**
 * Инвалидация после изменения состава ленты: новое поколение кеша в Redis и purge CDN.
 * Даже если purge не удался, ответы в CDN живут не дольше ttl_sec ≤ 60 с (раздел 10.8).
 */
export async function invalidateFeed(deps: PublishingDeps, reason: string): Promise<void> {
  await bumpFeedGeneration(deps.redis, deps.keys, deps.logger);
  try {
    await deps.cdnPurge.purge({ paths: FEED_PURGE_PATHS, reason });
  } catch (err) {
    adapterErrorsTotal.inc({ adapter: 'cdn-purge' });
    deps.logger.error({ err, reason }, 'CDN purge не выполнен');
  }
}

async function copyToPublic(deps: PublishingDeps, mediaAssetIds: string[]): Promise<void> {
  if (mediaAssetIds.length === 0) return;
  const assets = await deps.prisma.mediaAsset.findMany({ where: { id: { in: mediaAssetIds } } });
  if (assets.length !== mediaAssetIds.length) throw new Error('Медиа снимка не найдены');
  const files = assets.flatMap((a) => variantFiles(MediaVariants.parse(a.variants)));
  // Копирование идемпотентно: повторная публикация перезапишет те же ключи тем же содержимым.
  for (let i = 0; i < files.length; i += 8) {
    await Promise.all(
      files
        .slice(i, i + 8)
        .map((f) =>
          deps.storage.copy(
            { bucket: deps.buckets.media, key: f.key },
            { bucket: deps.buckets.public, key: f.key },
            { contentType: f.mime, cacheControl: PUBLIC_MEDIA_CACHE_CONTROL },
          ),
        ),
    );
  }
}

export type PublishResult =
  | { ok: true }
  | { ok: false; reason: 'not_approved' }
  | { ok: false; reason: 'cta_not_allowed'; slides: string[] };

/** Слайды снимка, чьи CTA не проходят текущий allowlist (его могли сузить после согласования). */
export function ctaViolations(
  payload: FeedGroup,
  allowlist: Awaited<ReturnType<typeof readAllowlist>>,
): string[] {
  return payload.slides
    .filter((s) => s.cta && !checkCta(s.cta.type, s.cta.value, allowlist).ok)
    .map((s) => s.id);
}

/**
 * approved → published. Медиа попадают в публичный CDN-путь только здесь (угроза T5).
 * Перед публикацией CTA ещё раз проверяются по allowlist (раздел 10.4).
 */
export async function publishSnapshot(
  deps: PublishingDeps,
  snapshotId: string,
  ctx: AuditContext,
  trigger: PublishTrigger,
  now: Date = new Date(),
): Promise<PublishResult> {
  const snap = await deps.prisma.publishedSnapshot.findUnique({ where: { id: snapshotId } });
  if (!snap || snap.state !== 'approved') return { ok: false, reason: 'not_approved' };

  const violations = ctaViolations(
    snap.payload as unknown as FeedGroup,
    await readAllowlist(deps.prisma),
  );
  if (violations.length > 0) {
    deps.security.emit('cta.rejected', {
      actorId: ctx.actorId,
      ip: ctx.ip ?? null,
      requestId: ctx.requestId ?? null,
      details: {
        stage: 'publish',
        groupId: snap.groupId,
        version: snap.version,
        slides: violations,
      },
    });
    return { ok: false, reason: 'cta_not_allowed', slides: violations };
  }

  await copyToPublic(deps, snap.mediaAssetIds);

  const published = await deps.prisma
    .$transaction(async (tx) => {
      await tx.publishedSnapshot.updateMany({
        where: { groupId: snap.groupId, state: 'published' },
        data: { state: 'superseded', supersededAt: now },
      });
      const res = await tx.publishedSnapshot.updateMany({
        where: { id: snap.id, state: 'approved' },
        data: { state: 'published', publishedAt: now, publishedById: ctx.actorId },
      });
      if (res.count === 0) throw new SnapshotRaceError();
      // Рабочая копия переходит в published, только если её не правили после согласования.
      await tx.storyGroup.updateMany({
        where: { id: snap.groupId, status: 'approved', revision: snap.sourceRevision },
        data: { status: 'published' },
      });
      await writeAudit(tx, ctx, {
        action: 'group.published',
        entityType: 'group',
        entityId: snap.groupId,
        diff: { version: snap.version, trigger },
      });
      return true;
    })
    .catch((err: unknown) => {
      if (err instanceof SnapshotRaceError) return false;
      throw err;
    });
  if (!published) return { ok: false, reason: 'not_approved' };

  await invalidateFeed(deps, `publish ${snap.groupId} v${snap.version}`);
  publicationsTotal.inc({
    action: 'publish',
    trigger,
    business_hours: isBusinessHours(now) ? 'yes' : 'no',
  });
  deps.security.emit('group.published', {
    actorId: ctx.actorId,
    ip: ctx.ip ?? null,
    requestId: ctx.requestId ?? null,
    details: { groupId: snap.groupId, version: snap.version, trigger },
  });
  return { ok: true };
}

class SnapshotRaceError extends Error {}

/**
 * Снятие с публикации: опубликованный и ожидающий снимки → archived. Одно действие (раздел 10.8).
 */
export async function unpublishGroup(
  deps: PublishingDeps,
  groupId: string,
  ctx: AuditContext,
  reason: string | null,
  now: Date = new Date(),
): Promise<{ archivedVersions: number[] }> {
  const archivedVersions = await deps.prisma.$transaction(async (tx) => {
    const snaps = await tx.publishedSnapshot.findMany({
      where: { groupId, state: { in: ['published', 'approved'] } },
      select: { id: true, version: true },
    });
    await tx.publishedSnapshot.updateMany({
      where: { groupId, state: { in: ['published', 'approved'] } },
      data: { state: 'archived', archivedAt: now, archivedById: ctx.actorId },
    });
    await tx.storyGroup.updateMany({
      where: { id: groupId, status: { in: ['published', 'approved'] } },
      data: { status: 'archived' },
    });
    await writeAudit(tx, ctx, {
      action: 'group.unpublished',
      entityType: 'group',
      entityId: groupId,
      diff: { archivedVersions: snaps.map((s) => s.version), reason },
    });
    return snaps.map((s) => s.version);
  });
  await invalidateFeed(deps, `unpublish ${groupId}`);
  publicationsTotal.inc({
    action: 'unpublish',
    trigger: 'manual',
    business_hours: isBusinessHours(now) ? 'yes' : 'no',
  });
  deps.security.emit('group.unpublished', {
    actorId: ctx.actorId,
    ip: ctx.ip ?? null,
    requestId: ctx.requestId ?? null,
    details: { groupId, archivedVersions, reason },
  });
  return { archivedVersions };
}

/** Правка после согласования отменяет ещё не опубликованный снимок (см. DECISIONS.md). */
export async function cancelPendingSnapshot(
  tx: Prisma.TransactionClient,
  groupId: string,
  now: Date,
): Promise<number | null> {
  const pending = await tx.publishedSnapshot.findFirst({
    where: { groupId, state: 'approved' },
    select: { id: true, version: true },
  });
  if (!pending) return null;
  await tx.publishedSnapshot.update({
    where: { id: pending.id },
    data: { state: 'superseded', supersededAt: now },
  });
  return pending.version;
}

/**
 * Тик планировщика: approved → published при наступлении start_at, published → archived после end_at.
 */
export async function runSchedulerTick(
  deps: PublishingDeps,
  ctx: AuditContext,
  now: Date = new Date(),
): Promise<{ published: number; archived: number }> {
  const due = await deps.prisma.publishedSnapshot.findMany({
    where: { state: 'approved', startAt: { lte: now }, endAt: { gt: now } },
    select: { id: true },
    orderBy: { approvedAt: 'asc' },
  });
  let published = 0;
  for (const s of due) {
    try {
      const res = await publishSnapshot(deps, s.id, ctx, 'schedule', now);
      if (res.ok) published += 1;
      else if (res.reason === 'cta_not_allowed') {
        deps.logger.error(
          { snapshotId: s.id, slides: res.slides },
          'Публикация заблокирована: CTA вне allowlist',
        );
      }
    } catch (err) {
      deps.logger.error({ err, snapshotId: s.id }, 'Не удалось опубликовать снимок по расписанию');
    }
  }

  const expired = await deps.prisma.publishedSnapshot.findMany({
    where: { state: { in: ['approved', 'published'] }, endAt: { lte: now } },
    select: { id: true, groupId: true, version: true, state: true, sourceRevision: true },
  });
  for (const s of expired) {
    await deps.prisma.$transaction(async (tx) => {
      await tx.publishedSnapshot.update({
        where: { id: s.id },
        data: { state: 'archived', archivedAt: now },
      });
      await tx.storyGroup.updateMany({
        where: {
          id: s.groupId,
          status: { in: ['published', 'approved'] },
          revision: s.sourceRevision,
        },
        data: { status: 'archived' },
      });
      await writeAudit(tx, ctx, {
        action: 'group.expired',
        entityType: 'group',
        entityId: s.groupId,
        diff: { version: s.version, wasState: s.state },
      });
    });
  }
  if (expired.length > 0) await invalidateFeed(deps, `expired ${expired.length}`);
  return { published, archived: expired.length };
}
