import type {
  AdminUser,
  MediaAsset,
  Prisma,
  PublishedSnapshot,
  Slide,
  StoryGroup,
  UserRole,
} from '@idb-stories/db';
import { MediaVariants } from '@idb-stories/core';
import {
  hasPermission,
  type AdminGroup,
  type AdminGroupSummary,
  type AdminMediaAsset,
  type AdminSlide,
  type AdminUserDto,
  type ScheduleState,
} from '@idb-stories/schema';
import type { Actor } from '../http/routes.js';

export type UserRefs = Map<string, { id: string; name: string }>;

export async function loadUserRefs(
  db: Pick<Prisma.TransactionClient, 'adminUser'>,
  ids: (string | null | undefined)[],
): Promise<UserRefs> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (unique.length === 0) return new Map();
  const users = await db.adminUser.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true },
  });
  return new Map(users.map((u) => [u.id, u]));
}

const ref = (refs: UserRefs, id: string | null | undefined) =>
  id ? (refs.get(id) ?? { id, name: '—' }) : null;

type SnapshotInfo = Pick<PublishedSnapshot, 'state' | 'version' | 'startAt' | 'endAt'>;

export function scheduleState(
  group: Pick<StoryGroup, 'endAt'>,
  snapshots: SnapshotInfo[],
  now: Date,
): ScheduleState {
  const live = snapshots.find((s) => s.state === 'published');
  const pending = snapshots.find((s) => s.state === 'approved');
  if (live && live.startAt <= now && now < live.endAt) return 'live';
  if ((live && live.startAt > now) || (pending && pending.endAt > now)) return 'scheduled';
  if (group.endAt <= now || (live && live.endAt <= now)) return 'expired';
  return 'not_published';
}

export function toSummary(
  g: StoryGroup & { _count?: { slides: number }; slides?: Slide[]; snapshots: SnapshotInfo[] },
  refs: UserRefs,
  now: Date,
): AdminGroupSummary {
  return {
    id: g.id,
    title: g.title,
    placement: g.placement,
    priority: g.priority,
    startAt: g.startAt.toISOString(),
    endAt: g.endAt.toISOString(),
    platforms: g.platforms,
    status: g.status,
    revision: g.revision,
    liveVersion: g.snapshots.find((s) => s.state === 'published')?.version ?? null,
    pendingVersion: g.snapshots.find((s) => s.state === 'approved')?.version ?? null,
    schedule: scheduleState(g, g.snapshots, now),
    slidesCount: g._count?.slides ?? g.slides?.length ?? 0,
    coverAssetId: g.coverAssetId,
    updatedAt: g.updatedAt.toISOString(),
    updatedBy: ref(refs, g.updatedById),
  };
}

export function toAdminSlide(s: Slide): AdminSlide {
  return {
    id: s.id,
    position: s.position,
    type: s.type,
    durationMs: s.durationMs,
    mediaAssetId: s.mediaAssetId,
    productSkus: s.productSkus,
    elements: s.elements as AdminSlide['elements'],
    cta: (s.cta ?? null) as AdminSlide['cta'],
  };
}

export const FOUR_EYES_MESSAGE =
  'Вы правили эту версию — согласовать её должен другой публикатор (правило четырёх глаз)';

export function groupActions(
  g: Pick<StoryGroup, 'status' | 'editorsSinceApproval' | 'lastEditedById'>,
  snapshots: SnapshotInfo[],
  actor: Actor,
): AdminGroup['actions'] {
  const can = (p: Parameters<typeof hasPermission>[1]) => hasPermission(actor.roles, p);
  const inReview = g.status === 'in_review';
  const ownEdit = g.editorsSinceApproval.includes(actor.id) || g.lastEditedById === actor.id;
  const hasLiveOrPending = snapshots.some((s) => s.state === 'published' || s.state === 'approved');
  return {
    canEdit: can('groups:write'),
    canSubmit: can('groups:submit') && (g.status === 'draft' || g.status === 'rejected'),
    canApprove: can('groups:review') && inReview && !ownEdit,
    canReject: can('groups:review') && inReview,
    canPublish: can('groups:publish') && snapshots.some((s) => s.state === 'approved'),
    canUnpublish: can('groups:unpublish') && hasLiveOrPending,
    approveBlockedReason: can('groups:review') && inReview && ownEdit ? FOUR_EYES_MESSAGE : null,
  };
}

export function toAdminGroup(
  g: StoryGroup & { slides: Slide[]; snapshots: SnapshotInfo[] },
  refs: UserRefs,
  actor: Actor,
  now: Date,
): AdminGroup {
  return {
    ...toSummary(g, refs, now),
    minAppVersion: { ios: g.minAppVersionIos, android: g.minAppVersionAndroid },
    segmentIds: g.segmentIds,
    createdAt: g.createdAt.toISOString(),
    createdBy: ref(refs, g.createdById),
    lastEditedBy: ref(refs, g.lastEditedById),
    submittedAt: g.submittedAt?.toISOString() ?? null,
    submittedBy: ref(refs, g.submittedById),
    reviewedAt: g.reviewedAt?.toISOString() ?? null,
    reviewedBy: ref(refs, g.reviewedById),
    reviewComment: g.reviewComment,
    slides: [...g.slides].sort((a, b) => a.position - b.position).map(toAdminSlide),
    actions: groupActions(g, g.snapshots, actor),
  };
}

export function toUserDto(u: AdminUser & { roles: UserRole[] }): AdminUserDto {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    roles: u.roles.map((r) => r.role).sort(),
    disabled: u.disabled,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
  };
}

export async function toMediaDto(
  a: MediaAsset,
  sign: (key: string) => Promise<string>,
): Promise<AdminMediaAsset> {
  let previews: AdminMediaAsset['previews'] = [];
  let poster: AdminMediaAsset['poster'] = null;
  if (a.status === 'ready') {
    const parsed = MediaVariants.safeParse(a.variants);
    if (parsed.success) {
      const v = parsed.data;
      const imageFiles = v.images.flatMap((i) =>
        i.files.filter((f) => f.mime === 'image/webp').map((f) => ({ f, w: i.w, h: i.h })),
      );
      const videoFiles = v.videos.map((x) => ({ f: x.file, w: x.w, h: x.h }));
      previews = await Promise.all(
        [...imageFiles, ...videoFiles].map(async ({ f, w, h }) => ({
          url: await sign(f.key),
          w,
          h,
          mime: f.mime,
        })),
      );
      const p = v.poster?.files.find((f) => f.mime === 'image/webp');
      if (v.poster && p)
        poster = { url: await sign(p.key), w: v.poster.w, h: v.poster.h, mime: p.mime };
    }
  }
  return {
    id: a.id,
    kind: a.kind,
    purpose: a.purpose,
    status: a.status,
    rejectReason: a.rejectReason,
    width: a.width,
    height: a.height,
    durationMs: a.durationMs,
    size: a.size,
    createdAt: a.createdAt.toISOString(),
    previews,
    poster,
  };
}
