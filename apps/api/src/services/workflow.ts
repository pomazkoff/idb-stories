import {
  buildFeedGroup,
  diffSourceViews,
  publishSnapshot,
  readAllowlist,
  toSourceView,
  unpublishGroup,
  variantFiles,
  MediaVariants,
  writeAudit,
  type AuditContext,
  type BuildAsset,
  type GroupSourceView,
  securityContext,
} from '@idb-stories/core';
import type { Prisma } from '@idb-stories/db';
import {
  CTA_REJECT_MESSAGES,
  FEED_SCHEMA_VERSION,
  checkCta,
  type AdminGroup,
  type Cta,
  type CtaAllowlist,
  type GroupDiff,
  type GroupPreview,
} from '@idb-stories/schema';
import type { AppDeps } from '../context.js';
import { conflict, forbidden, notFound } from '../http/errors.js';
import type { Actor } from '../http/routes.js';
import { lockGroup, type GroupsService } from './groups.js';
import { FOUR_EYES_MESSAGE, loadUserRefs } from './mappers.js';

type Tx = Prisma.TransactionClient;
type LockedGroup = NonNullable<Awaited<ReturnType<typeof lockGroup>>>;

/** Подписанные URL черновых медиа живут 15 минут (раздел 7.4). */
export const DRAFT_MEDIA_URL_TTL_SEC = 15 * 60;

function assertRevision(g: LockedGroup, revision: number) {
  if (g.revision !== revision) {
    throw conflict(
      'Группа изменилась — обновите страницу и проверьте ещё раз',
      'revision_mismatch',
      {
        currentRevision: g.revision,
      },
    );
  }
}

async function loadAssets(
  db: Pick<Tx, 'mediaAsset'>,
  g: LockedGroup,
): Promise<Map<string, BuildAsset>> {
  const ids = [g.coverAssetId, ...g.slides.map((s) => s.mediaAssetId)].filter(
    (x): x is string => !!x,
  );
  const assets = await db.mediaAsset.findMany({ where: { id: { in: ids } } });
  return new Map(assets.map((a) => [a.id, a]));
}

/** Слайды, чьи CTA не проходят текущий allowlist. */
function ctaProblems(g: LockedGroup, allowlist: CtaAllowlist): string[] {
  return g.slides.flatMap((s, i) => {
    const cta = s.cta as Cta | null;
    if (!cta) return [];
    const res = checkCta(cta.type, cta.value, allowlist);
    return res.ok ? [] : [`Слайд ${i + 1}: ${CTA_REJECT_MESSAGES[res.reason]}`];
  });
}

/**
 * Жизненный цикл группы (раздел 4.2): draft → in_review → approved → published → archived,
 * in_review → rejected (→ draft при правке). Правило четырёх глаз (10.3) проверяется здесь,
 * на сервере, под блокировкой строки группы.
 */
export class WorkflowService {
  constructor(
    private readonly deps: AppDeps,
    private readonly groups: GroupsService,
  ) {}

  async submit(
    id: string,
    revision: number,
    actor: Actor,
    audit: AuditContext,
  ): Promise<AdminGroup> {
    const now = this.deps.now();
    await this.deps.prisma.$transaction(async (tx) => {
      const g = await this.locked(tx, id);
      if (g.status !== 'draft' && g.status !== 'rejected') {
        throw conflict('Отправить можно только черновик', 'invalid_state');
      }
      assertRevision(g, revision);
      const problems = await this.readiness(tx, g);
      if (g.endAt <= now) problems.push('Период показа уже закончился');
      if (problems.length > 0)
        throw conflict('Группа не готова к согласованию', 'not_ready', { problems });
      await tx.storyGroup.update({
        where: { id },
        data: {
          status: 'in_review',
          submittedAt: now,
          submittedById: actor.id,
          reviewComment: null,
        },
      });
      await writeAudit(tx, audit, {
        action: 'group.submitted',
        entityType: 'group',
        entityId: id,
        diff: { revision },
      });
    });
    return this.groups.get(id, actor);
  }

  async approve(
    id: string,
    revision: number,
    actor: Actor,
    audit: AuditContext,
  ): Promise<AdminGroup> {
    const now = this.deps.now();
    const snapshot = await this.deps.prisma.$transaction(async (tx) => {
      const g = await this.locked(tx, id);
      if (g.status !== 'in_review')
        throw conflict('Согласовать можно только группу на согласовании', 'invalid_state');
      assertRevision(g, revision);
      if (g.endAt <= now) {
        // Период показа закончился, пока группа ждала согласования: снимок никогда бы не показался.
        throw conflict('Группа не готова к публикации', 'not_ready', {
          problems: ['Период показа уже закончился'],
        });
      }
      // Правило четырёх глаз: никто из правивших эту версию не может её согласовать.
      if (g.editorsSinceApproval.includes(actor.id) || g.lastEditedById === actor.id) {
        this.deps.security.emit('four_eyes.violation', {
          ...securityContext(audit),
          details: { groupId: id, revision },
        });
        throw forbidden(FOUR_EYES_MESSAGE, 'four_eyes');
      }
      const allowlist = await readAllowlist(tx);
      const ctaIssues = ctaProblems(g, allowlist);
      if (ctaIssues.length > 0) {
        this.deps.security.emit('cta.rejected', {
          ...securityContext(audit),
          details: { stage: 'approve', groupId: id },
        });
        throw conflict('CTA не проходят allowlist', 'cta_not_allowed', { problems: ctaIssues });
      }
      const last = await tx.publishedSnapshot.aggregate({
        where: { groupId: id },
        _max: { version: true },
      });
      const version = (last._max.version ?? 0) + 1;
      const cdn = this.deps.config.public.cdnBaseUrl;
      const built = buildFeedGroup(g, await loadAssets(tx, g), version, (key) => `${cdn}/${key}`);
      if (!built.group || built.problems.length > 0) {
        throw conflict('Группа не готова к публикации', 'not_ready', { problems: built.problems });
      }
      await tx.publishedSnapshot.updateMany({
        where: { groupId: id, state: 'approved' },
        data: { state: 'superseded', supersededAt: now },
      });
      const snap = await tx.publishedSnapshot.create({
        data: {
          groupId: id,
          version,
          payload: built.group,
          source: toSourceView(g) as unknown as Prisma.InputJsonValue,
          placement: g.placement,
          priority: g.priority,
          startAt: g.startAt,
          endAt: g.endAt,
          platforms: g.platforms,
          minAppVersionIos: g.minAppVersionIos,
          minAppVersionAndroid: g.minAppVersionAndroid,
          segmentIds: g.segmentIds,
          mediaAssetIds: built.mediaAssetIds,
          sourceRevision: g.revision,
          approvedById: actor.id,
          approvedAt: now,
        },
      });
      await tx.storyGroup.update({
        where: { id },
        data: {
          status: 'approved',
          reviewedAt: now,
          reviewedById: actor.id,
          reviewComment: null,
          editorsSinceApproval: [],
        },
      });
      await writeAudit(tx, audit, {
        action: 'group.approved',
        entityType: 'group',
        entityId: id,
        diff: { version, revision },
      });
      return snap;
    });

    // approved → published сразу, если start_at уже наступил (раздел 4.2).
    if (snapshot.startAt <= now && now < snapshot.endAt) {
      const res = await publishSnapshot(this.deps.publishing, snapshot.id, audit, 'approve', now);
      if (!res.ok && res.reason === 'cta_not_allowed') {
        // Согласование уже сохранено (снимок approved); не опубликовано из-за сузившегося allowlist.
        throw conflict(
          'Версия согласована, но не опубликована: CTA вне allowlist',
          'cta_not_allowed',
          {
            slides: res.slides,
          },
        );
      }
    }
    return this.groups.get(id, actor);
  }

  async reject(
    id: string,
    revision: number,
    comment: string,
    actor: Actor,
    audit: AuditContext,
  ): Promise<AdminGroup> {
    const now = this.deps.now();
    await this.deps.prisma.$transaction(async (tx) => {
      const g = await this.locked(tx, id);
      if (g.status !== 'in_review')
        throw conflict('Отклонить можно только группу на согласовании', 'invalid_state');
      assertRevision(g, revision);
      await tx.storyGroup.update({
        where: { id },
        data: {
          status: 'rejected',
          reviewedAt: now,
          reviewedById: actor.id,
          reviewComment: comment,
        },
      });
      await writeAudit(tx, audit, {
        action: 'group.rejected',
        entityType: 'group',
        entityId: id,
        diff: { revision, comment },
      });
    });
    return this.groups.get(id, actor);
  }

  /** Ручная публикация согласованной версии, не дожидаясь планировщика. */
  async publish(id: string, actor: Actor, audit: AuditContext): Promise<AdminGroup> {
    const pending = await this.deps.prisma.publishedSnapshot.findFirst({
      where: { groupId: id, state: 'approved' },
    });
    if (!pending) {
      if (!(await this.deps.prisma.storyGroup.count({ where: { id } })))
        throw notFound('Группа не найдена');
      throw conflict('Нет согласованной версии для публикации', 'invalid_state');
    }
    const now = this.deps.now();
    if (pending.endAt <= now)
      throw conflict('Период показа согласованной версии закончился', 'invalid_state');
    const res = await publishSnapshot(this.deps.publishing, pending.id, audit, 'manual', now);
    if (!res.ok) {
      throw res.reason === 'cta_not_allowed'
        ? conflict('Публикация заблокирована: CTA вне allowlist', 'cta_not_allowed', {
            slides: res.slides,
          })
        : conflict('Версия уже опубликована или отменена', 'invalid_state');
    }
    return this.groups.get(id, actor);
  }

  async unpublish(
    id: string,
    reason: string | null,
    actor: Actor,
    audit: AuditContext,
  ): Promise<AdminGroup> {
    const active = await this.deps.prisma.publishedSnapshot.count({
      where: { groupId: id, state: { in: ['published', 'approved'] } },
    });
    if (active === 0) {
      if (!(await this.deps.prisma.storyGroup.count({ where: { id } })))
        throw notFound('Группа не найдена');
      throw conflict('Группа не опубликована', 'invalid_state');
    }
    await unpublishGroup(this.deps.publishing, id, audit, reason, this.deps.now());
    return this.groups.get(id, actor);
  }

  async diff(id: string): Promise<GroupDiff> {
    const g = await this.deps.prisma.storyGroup.findUnique({
      where: { id },
      include: { slides: { orderBy: { position: 'asc' } } },
    });
    if (!g) throw notFound('Группа не найдена');
    const base = await this.deps.prisma.publishedSnapshot.findFirst({
      where: { groupId: id, publishedAt: { not: null } },
      orderBy: { version: 'desc' },
      select: { version: true, source: true },
    });
    return {
      baseVersion: base?.version ?? null,
      revision: g.revision,
      changes: diffSourceViews(
        (base?.source as unknown as GroupSourceView | undefined) ?? null,
        toSourceView(g),
      ),
    };
  }

  /** Превью рабочей копии: медиа — только подписанные URL с TTL 15 минут (раздел 7.4, T5). */
  async preview(id: string): Promise<GroupPreview> {
    const g = await this.deps.prisma.storyGroup.findUnique({
      where: { id },
      include: { slides: { orderBy: { position: 'asc' } } },
    });
    if (!g) throw notFound('Группа не найдена');
    const assets = await loadAssets(this.deps.prisma, g);
    const keys = [...assets.values()].flatMap((a) => {
      const v = MediaVariants.safeParse(a.variants);
      return a.status === 'ready' && v.success ? variantFiles(v.data).map((f) => f.key) : [];
    });
    const { media } = this.deps.config.s3.buckets;
    const signed = new Map(
      await Promise.all(
        keys.map(
          async (k) =>
            [k, await this.deps.storage.presignGet(media, k, DRAFT_MEDIA_URL_TTL_SEC)] as const,
        ),
      ),
    );
    const built = buildFeedGroup(g, assets, g.revision, (key) => signed.get(key) ?? '', {
      coverFallback: true,
    });
    const now = this.deps.now();
    const origins = new Set<string>();
    for (const url of signed.values()) origins.add(new URL(url).origin);
    return {
      feed: {
        schema_version: FEED_SCHEMA_VERSION,
        generated_at: now.toISOString(),
        ttl_sec: 60,
        groups: built.group ? [built.group] : [],
      },
      mediaOrigins: [...origins],
      warnings: built.problems,
    };
  }

  async versions(id: string) {
    const snaps = await this.deps.prisma.publishedSnapshot.findMany({
      where: { groupId: id },
      orderBy: { version: 'desc' },
      select: {
        version: true,
        state: true,
        approvedAt: true,
        approvedById: true,
        publishedAt: true,
        archivedAt: true,
        startAt: true,
        endAt: true,
      },
    });
    if (snaps.length === 0 && !(await this.deps.prisma.storyGroup.count({ where: { id } }))) {
      throw notFound('Группа не найдена');
    }
    const refs = await loadUserRefs(
      this.deps.prisma,
      snaps.map((s) => s.approvedById),
    );
    return {
      items: snaps.map((s) => ({
        version: s.version,
        state: s.state,
        approvedAt: s.approvedAt.toISOString(),
        approvedBy: refs.get(s.approvedById) ?? { id: s.approvedById, name: '—' },
        publishedAt: s.publishedAt?.toISOString() ?? null,
        archivedAt: s.archivedAt?.toISOString() ?? null,
        startAt: s.startAt.toISOString(),
        endAt: s.endAt.toISOString(),
      })),
    };
  }

  private async locked(tx: Tx, id: string): Promise<LockedGroup> {
    const g = await lockGroup(tx, id);
    if (!g) throw notFound('Группа не найдена');
    return g;
  }

  private async readiness(tx: Tx, g: LockedGroup): Promise<string[]> {
    const built = buildFeedGroup(
      g,
      await loadAssets(tx, g),
      1,
      (key) => `https://check.invalid/${key}`,
    );
    return [...built.problems, ...ctaProblems(g, await readAllowlist(tx))];
  }
}
