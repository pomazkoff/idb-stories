import {
  cancelPendingSnapshot,
  diffFields,
  readAllowlist,
  writeAudit,
  type AuditContext,
  securityContext,
} from '@idb-stories/core';
import { Prisma, type Slide, type StoryGroup } from '@idb-stories/db';
import {
  CTA_REJECT_MESSAGES,
  LIMITS,
  Uuid,
  checkCta,
  type AdminGroup,
  type Cta,
  type CtaAllowlist,
  type GroupCreateInput,
  type GroupListQuery,
  type GroupUpdateInput,
  type SlideInput,
} from '@idb-stories/schema';
import type { AppDeps } from '../context.js';
import { badRequest, conflict, notFound } from '../http/errors.js';
import type { Actor } from '../http/routes.js';
import { loadUserRefs, toAdminGroup, toSummary } from './mappers.js';

type Tx = Prisma.TransactionClient;
type GroupWithSlides = StoryGroup & { slides: Slide[] };

const snapshotSelect = {
  where: { state: { in: ['approved', 'published'] as ('approved' | 'published')[] } },
  select: { state: true, version: true, startAt: true, endAt: true },
} satisfies Prisma.StoryGroup$snapshotsArgs;

/** Поля группы, которые попадают в diff аудита. */
function groupView(g: StoryGroup) {
  return {
    title: g.title,
    placement: g.placement,
    priority: g.priority,
    startAt: g.startAt,
    endAt: g.endAt,
    platforms: g.platforms,
    minAppVersionIos: g.minAppVersionIos,
    minAppVersionAndroid: g.minAppVersionAndroid,
    segmentIds: g.segmentIds,
    coverAssetId: g.coverAssetId,
  };
}

function slideView(
  s: Pick<
    Slide,
    'id' | 'position' | 'type' | 'durationMs' | 'mediaAssetId' | 'elements' | 'cta' | 'productSkus'
  >,
) {
  return {
    id: s.id,
    position: s.position,
    type: s.type,
    durationMs: s.durationMs,
    mediaAssetId: s.mediaAssetId,
    elements: s.elements,
    cta: s.cta,
    productSkus: s.productSkus,
  };
}

export async function lockGroup(tx: Tx, id: string): Promise<GroupWithSlides | null> {
  await tx.$queryRaw`SELECT id FROM story_group WHERE id = ${id}::uuid FOR UPDATE`;
  return tx.storyGroup.findUnique({
    where: { id },
    include: { slides: { orderBy: { position: 'asc' } } },
  });
}

export class GroupsService {
  constructor(private readonly deps: AppDeps) {}

  async get(id: string, actor: Actor): Promise<AdminGroup> {
    const g = await this.deps.prisma.storyGroup.findUnique({
      where: { id },
      include: { slides: true, snapshots: snapshotSelect },
    });
    if (!g) throw notFound('Группа не найдена');
    const refs = await loadUserRefs(this.deps.prisma, [
      g.createdById,
      g.updatedById,
      g.lastEditedById,
      g.submittedById,
      g.reviewedById,
    ]);
    return toAdminGroup(g, refs, actor, this.deps.now());
  }

  async list(q: GroupListQuery) {
    const now = this.deps.now();
    const and: Prisma.StoryGroupWhereInput[] = [];
    if (q.status) and.push({ status: q.status });
    if (q.placement) and.push({ placement: q.placement });
    if (q.q) and.push({ title: { contains: q.q, mode: 'insensitive' } });
    if (q.from) and.push({ endAt: { gt: new Date(q.from) } });
    if (q.to) and.push({ startAt: { lt: new Date(q.to) } });
    switch (q.schedule) {
      case 'live':
        and.push({
          snapshots: { some: { state: 'published', startAt: { lte: now }, endAt: { gt: now } } },
        });
        break;
      case 'scheduled':
        and.push({
          OR: [
            { snapshots: { some: { state: 'published', startAt: { gt: now } } } },
            { snapshots: { some: { state: 'approved', endAt: { gt: now } } } },
          ],
        });
        break;
      case 'expired':
        and.push({ endAt: { lte: now } });
        break;
      case 'not_published':
        and.push({
          snapshots: { none: { state: { in: ['published', 'approved'] } } },
          endAt: { gt: now },
        });
        break;
      default:
        break;
    }
    if (q.cursor && !Uuid.safeParse(q.cursor).success) throw badRequest('Некорректный курсор');
    const rows = await this.deps.prisma.storyGroup.findMany({
      where: { AND: and },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: { _count: { select: { slides: true } }, snapshots: snapshotSelect },
    });
    const page = rows.slice(0, q.limit);
    const refs = await loadUserRefs(
      this.deps.prisma,
      page.map((g) => g.updatedById),
    );
    return {
      items: page.map((g) => toSummary(g, refs, now)),
      nextCursor: rows.length > q.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async create(input: GroupCreateInput, actor: Actor, audit: AuditContext): Promise<AdminGroup> {
    const id = await this.deps.prisma.$transaction(async (tx) => {
      await this.validateRefs(tx, input.coverAssetId, input.segmentIds);
      const g = await tx.storyGroup.create({
        data: {
          title: input.title,
          placement: input.placement,
          priority: input.priority,
          startAt: new Date(input.startAt),
          endAt: new Date(input.endAt),
          platforms: input.platforms,
          minAppVersionIos: input.minAppVersion.ios,
          minAppVersionAndroid: input.minAppVersion.android,
          segmentIds: input.segmentIds,
          coverAssetId: input.coverAssetId,
          lastEditedById: actor.id,
          editorsSinceApproval: [actor.id],
          createdById: actor.id,
          updatedById: actor.id,
        },
      });
      await writeAudit(tx, audit, {
        action: 'group.created',
        entityType: 'group',
        entityId: g.id,
        diff: { before: null, after: groupView(g) },
      });
      return g.id;
    });
    return this.get(id, actor);
  }

  update(
    id: string,
    input: GroupUpdateInput,
    actor: Actor,
    audit: AuditContext,
  ): Promise<AdminGroup> {
    const { revision, ...changes } = input;
    return this.mutate(id, actor, audit, 'group.updated', async (tx, g) => {
      if (g.revision !== revision) {
        throw conflict(
          'Группа изменена другим пользователем — обновите страницу',
          'revision_mismatch',
          {
            currentRevision: g.revision,
          },
        );
      }
      const startAt = changes.startAt ? new Date(changes.startAt) : g.startAt;
      const endAt = changes.endAt ? new Date(changes.endAt) : g.endAt;
      if (endAt <= startAt) throw badRequest('Окончание должно быть позже начала');
      await this.validateRefs(tx, changes.coverAssetId ?? null, changes.segmentIds ?? []);
      const data: Prisma.StoryGroupUpdateInput = {
        ...(changes.title !== undefined ? { title: changes.title } : {}),
        ...(changes.placement !== undefined ? { placement: changes.placement } : {}),
        ...(changes.priority !== undefined ? { priority: changes.priority } : {}),
        ...(changes.startAt !== undefined ? { startAt } : {}),
        ...(changes.endAt !== undefined ? { endAt } : {}),
        ...(changes.platforms !== undefined ? { platforms: changes.platforms } : {}),
        ...(changes.minAppVersion !== undefined
          ? {
              minAppVersionIos: changes.minAppVersion.ios,
              minAppVersionAndroid: changes.minAppVersion.android,
            }
          : {}),
        ...(changes.segmentIds !== undefined ? { segmentIds: changes.segmentIds } : {}),
        ...(changes.coverAssetId !== undefined
          ? changes.coverAssetId === null
            ? { cover: { disconnect: true } }
            : { cover: { connect: { id: changes.coverAssetId } } }
          : {}),
      };
      const after = {
        ...groupView(g),
        ...{
          title: changes.title ?? g.title,
          placement: changes.placement ?? g.placement,
          priority: changes.priority ?? g.priority,
          startAt,
          endAt,
          platforms: changes.platforms ?? g.platforms,
          minAppVersionIos: changes.minAppVersion ? changes.minAppVersion.ios : g.minAppVersionIos,
          minAppVersionAndroid: changes.minAppVersion
            ? changes.minAppVersion.android
            : g.minAppVersionAndroid,
          segmentIds: changes.segmentIds ?? g.segmentIds,
          coverAssetId: changes.coverAssetId !== undefined ? changes.coverAssetId : g.coverAssetId,
        },
      };
      return { data, diff: diffFields(groupView(g), after) };
    });
  }

  async remove(id: string, audit: AuditContext): Promise<void> {
    await this.deps.prisma.$transaction(async (tx) => {
      const g = await lockGroup(tx, id);
      if (!g) throw notFound('Группа не найдена');
      const versions = await tx.publishedSnapshot.count({ where: { groupId: id } });
      if (versions > 0) {
        throw conflict(
          'Группа уже согласовывалась — её можно только снять с публикации',
          'has_versions',
        );
      }
      await tx.storyGroup.delete({ where: { id } });
      await writeAudit(tx, audit, {
        action: 'group.deleted',
        entityType: 'group',
        entityId: id,
        diff: { before: { ...groupView(g), slides: g.slides.map(slideView) }, after: null },
      });
    });
  }

  async duplicate(id: string, actor: Actor, audit: AuditContext): Promise<AdminGroup> {
    const newId = await this.deps.prisma.$transaction(async (tx) => {
      const src = await tx.storyGroup.findUnique({
        where: { id },
        include: { slides: { orderBy: { position: 'asc' } } },
      });
      if (!src) throw notFound('Группа не найдена');
      const suffix = ' (копия)';
      const g = await tx.storyGroup.create({
        data: {
          ...groupView(src),
          title: `${src.title.slice(0, LIMITS.groupTitleMax - suffix.length)}${suffix}`,
          lastEditedById: actor.id,
          editorsSinceApproval: [actor.id],
          createdById: actor.id,
          updatedById: actor.id,
          slides: {
            create: src.slides.map((s) => ({
              position: s.position,
              type: s.type,
              durationMs: s.durationMs,
              mediaAssetId: s.mediaAssetId,
              elements: s.elements as Prisma.InputJsonValue,
              cta: s.cta ?? Prisma.DbNull,
              productSkus: s.productSkus,
            })),
          },
        },
      });
      await writeAudit(tx, audit, {
        action: 'group.duplicated',
        entityType: 'group',
        entityId: g.id,
        diff: { sourceGroupId: id, after: groupView(g) },
      });
      return g.id;
    });
    return this.get(newId, actor);
  }

  addSlide(id: string, input: SlideInput, actor: Actor, audit: AuditContext): Promise<AdminGroup> {
    return this.mutate(id, actor, audit, 'slide.created', async (tx, g) => {
      if (g.slides.length >= LIMITS.slidesPerGroupMax) {
        throw conflict(`В группе не больше ${LIMITS.slidesPerGroupMax} слайдов`, 'too_many_slides');
      }
      const data = await this.validateSlide(tx, input, audit, id);
      const position = g.slides.length === 0 ? 0 : Math.max(...g.slides.map((s) => s.position)) + 1;
      const slide = await tx.slide.create({ data: { ...data, position, groupId: id } });
      return { diff: { slideId: slide.id, before: null, after: slideView(slide) } };
    });
  }

  replaceSlide(
    id: string,
    slideId: string,
    input: SlideInput,
    actor: Actor,
    audit: AuditContext,
  ): Promise<AdminGroup> {
    return this.mutate(id, actor, audit, 'slide.updated', async (tx, g) => {
      const existing = g.slides.find((s) => s.id === slideId);
      if (!existing) throw notFound('Слайд не найден');
      const data = await this.validateSlide(tx, input, audit, id);
      const slide = await tx.slide.update({
        where: { id: slideId },
        data: { ...data, cta: data.cta ?? Prisma.DbNull },
      });
      return { diff: { slideId, ...diffFields(slideView(existing), slideView(slide)) } };
    });
  }

  deleteSlide(id: string, slideId: string, actor: Actor, audit: AuditContext): Promise<AdminGroup> {
    return this.mutate(id, actor, audit, 'slide.deleted', async (tx, g) => {
      const existing = g.slides.find((s) => s.id === slideId);
      if (!existing) throw notFound('Слайд не найден');
      await tx.slide.delete({ where: { id: slideId } });
      const rest = g.slides.filter((s) => s.id !== slideId);
      await Promise.all(
        rest.flatMap((s, i) =>
          s.position === i ? [] : [tx.slide.update({ where: { id: s.id }, data: { position: i } })],
        ),
      );
      return { diff: { slideId, before: slideView(existing), after: null } };
    });
  }

  reorderSlides(
    id: string,
    revision: number,
    slideIds: string[],
    actor: Actor,
    audit: AuditContext,
  ): Promise<AdminGroup> {
    return this.mutate(id, actor, audit, 'slide.reordered', async (tx, g) => {
      if (g.revision !== revision) {
        throw conflict(
          'Группа изменена другим пользователем — обновите страницу',
          'revision_mismatch',
          {
            currentRevision: g.revision,
          },
        );
      }
      const current = new Set(g.slides.map((s) => s.id));
      if (slideIds.length !== current.size || !slideIds.every((sid) => current.has(sid))) {
        throw badRequest('Список слайдов не совпадает с текущим');
      }
      await Promise.all(
        slideIds.map((sid, position) =>
          tx.slide.update({ where: { id: sid }, data: { position } }),
        ),
      );
      return { diff: { before: g.slides.map((s) => s.id), after: slideIds } };
    });
  }

  /**
   * Любая правка: revision+1, статус → draft (раздел 4.2, 10.3), автор правки попадает
   * в editorsSinceApproval, ожидающий публикации снимок отменяется. Всё — в одной транзакции с аудитом.
   */
  private async mutate(
    id: string,
    actor: Actor,
    audit: AuditContext,
    action: string,
    fn: (
      tx: Tx,
      g: GroupWithSlides,
    ) => Promise<{ data?: Prisma.StoryGroupUpdateInput; diff: unknown }>,
  ): Promise<AdminGroup> {
    const now = this.deps.now();
    await this.deps.prisma.$transaction(async (tx) => {
      const g = await lockGroup(tx, id);
      if (!g) throw notFound('Группа не найдена');
      const { data = {}, diff } = await fn(tx, g);
      const cancelledPendingVersion = await cancelPendingSnapshot(tx, id, now);
      await tx.storyGroup.update({
        where: { id },
        data: {
          ...data,
          status: 'draft',
          revision: { increment: 1 },
          lastEditedById: actor.id,
          updatedById: actor.id,
          ...(g.editorsSinceApproval.includes(actor.id)
            ? {}
            : { editorsSinceApproval: { push: actor.id } }),
        },
      });
      await writeAudit(tx, audit, {
        action,
        entityType: 'group',
        entityId: id,
        diff: {
          ...(diff as object),
          revision: g.revision + 1,
          ...(g.status !== 'draft' ? { statusBefore: g.status } : {}),
          ...(cancelledPendingVersion ? { cancelledPendingVersion } : {}),
        },
      });
    });
    return this.get(id, actor);
  }

  private async validateRefs(
    tx: Tx,
    coverAssetId: string | null,
    segmentIds: readonly string[],
  ): Promise<void> {
    if (coverAssetId) {
      const cover = await tx.mediaAsset.findUnique({ where: { id: coverAssetId } });
      if (!cover || cover.kind !== 'image' || cover.purpose !== 'cover') {
        throw badRequest(
          'Обложка: выберите изображение, загруженное как обложка',
          undefined,
          'invalid_cover',
        );
      }
      if (cover.status === 'rejected')
        throw badRequest('Обложка отклонена проверкой', undefined, 'media_rejected');
    }
    if (segmentIds.length > 0) {
      const found = await tx.segment.count({ where: { id: { in: [...segmentIds] } } });
      if (found !== new Set(segmentIds).size)
        throw badRequest('Неизвестный сегмент', undefined, 'unknown_segment');
    }
  }

  /** Проверка слайда: медиа нужного типа и CTA по allowlist (при сохранении, раздел 10.4). */
  async validateSlide(
    tx: Tx,
    input: SlideInput,
    audit: AuditContext,
    groupId: string,
    allowlist?: CtaAllowlist,
  ): Promise<{
    type: SlideInput['type'];
    durationMs: number;
    mediaAssetId: string | null;
    elements: Prisma.InputJsonValue;
    cta: Prisma.InputJsonValue | undefined;
    productSkus: string[];
  }> {
    let durationMs: number;
    let mediaAssetId: string | null = null;
    if (input.type === 'image' || input.type === 'video') {
      const asset = await tx.mediaAsset.findUnique({ where: { id: input.mediaAssetId } });
      if (!asset) throw badRequest('Медиа не найдено', undefined, 'media_not_found');
      if (asset.kind !== input.type || asset.purpose !== 'slide') {
        throw badRequest('Тип медиа не подходит для слайда', undefined, 'media_kind_mismatch');
      }
      if (asset.status === 'rejected')
        throw badRequest('Файл отклонён проверкой', undefined, 'media_rejected');
      mediaAssetId = asset.id;
      durationMs =
        input.type === 'image'
          ? input.durationMs
          : (asset.durationMs ?? LIMITS.slideDurationDefaultMs);
    } else {
      durationMs = input.durationMs;
    }

    let cta: Cta | null = input.cta;
    if (cta) {
      const list = allowlist ?? (await readAllowlist(tx));
      const res = checkCta(cta.type, cta.value, list);
      if (!res.ok) {
        this.deps.security.emit('cta.rejected', {
          ...securityContext(audit),
          details: {
            stage: 'save',
            groupId,
            type: cta.type,
            reason: res.reason,
            value: cta.value.slice(0, 300),
          },
        });
        throw badRequest(
          CTA_REJECT_MESSAGES[res.reason],
          { reason: res.reason },
          'cta_not_allowed',
        );
      }
      cta = { ...cta, value: res.normalized };
    }

    return {
      type: input.type,
      durationMs,
      mediaAssetId,
      elements: input.elements as Prisma.InputJsonValue,
      cta: cta ?? undefined,
      productSkus: input.type === 'product' ? input.productSkus : [],
    };
  }
}
