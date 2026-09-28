import { z } from 'zod';
import {
  GroupStatus,
  IsoDateTime,
  LIMITS,
  MediaKind,
  MediaPurpose,
  MediaStatus,
  Placement,
  Platform,
  Role,
  SlideType,
  Uuid,
  UploadContentType,
  ALLOWED_UPLOAD_CONTENT_TYPES,
  multiLineText,
} from './common.js';
import { Cta, MinAppVersion, SlideElement } from './content.js';
import { FeedResponse } from './feed.js';
import { PERMISSION_NAMES } from './permissions.js';

/** Admin API использует camelCase (внутренний контракт), публичный API — snake_case. */

export const ErrorResponse = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    }),
    requestId: z.string().optional(),
  })
  .meta({ id: 'ErrorResponse' });
export type ErrorResponse = z.infer<typeof ErrorResponse>;

export const UserRef = z.object({ id: Uuid, name: z.string() }).nullable().meta({ id: 'UserRef' });

export const IdParams = z.object({ id: Uuid });
export const GroupSlideParams = z.object({ id: Uuid, slideId: Uuid });

// ---------------------------------------------------------------------------
// Группы и слайды
// ---------------------------------------------------------------------------

export const AdminSlide = z
  .object({
    id: Uuid,
    position: z.int().min(0),
    type: SlideType,
    durationMs: z.int(),
    mediaAssetId: Uuid.nullable(),
    productSkus: z.array(z.string()),
    elements: z.array(SlideElement),
    cta: Cta.nullable(),
  })
  .meta({ id: 'AdminSlide' });
export type AdminSlide = z.infer<typeof AdminSlide>;

/** Бейджи списка: «идёт сейчас», «запланировано», «истекло» (раздел 6.2). */
export const ScheduleState = z.enum(['live', 'scheduled', 'expired', 'not_published']);
export type ScheduleState = z.infer<typeof ScheduleState>;

export const GroupActions = z
  .object({
    canEdit: z.boolean(),
    canSubmit: z.boolean(),
    canApprove: z.boolean(),
    canReject: z.boolean(),
    canPublish: z.boolean(),
    canUnpublish: z.boolean(),
    /** Почему нельзя согласовать (например, правило четырёх глаз). */
    approveBlockedReason: z.string().nullable(),
  })
  .meta({ id: 'GroupActions' });

export const AdminGroupSummary = z
  .object({
    id: Uuid,
    title: z.string(),
    placement: Placement,
    priority: z.int(),
    startAt: IsoDateTime,
    endAt: IsoDateTime,
    platforms: z.array(Platform),
    status: GroupStatus,
    revision: z.int(),
    liveVersion: z.int().nullable(),
    pendingVersion: z.int().nullable(),
    schedule: ScheduleState,
    slidesCount: z.int(),
    coverAssetId: Uuid.nullable(),
    updatedAt: IsoDateTime,
    updatedBy: UserRef,
  })
  .meta({ id: 'AdminGroupSummary' });
export type AdminGroupSummary = z.infer<typeof AdminGroupSummary>;

export const AdminGroup = AdminGroupSummary.extend({
  minAppVersion: MinAppVersion,
  segmentIds: z.array(z.string()),
  createdAt: IsoDateTime,
  createdBy: UserRef,
  lastEditedBy: UserRef,
  submittedAt: IsoDateTime.nullable(),
  submittedBy: UserRef,
  reviewedAt: IsoDateTime.nullable(),
  reviewedBy: UserRef,
  reviewComment: z.string().nullable(),
  slides: z.array(AdminSlide),
  actions: GroupActions,
}).meta({ id: 'AdminGroup' });
export type AdminGroup = z.infer<typeof AdminGroup>;

export const GroupListQuery = z.object({
  status: GroupStatus.optional(),
  placement: Placement.optional(),
  schedule: ScheduleState.optional(),
  /** Пересечение периода показа с [from, to). */
  from: IsoDateTime.optional(),
  to: IsoDateTime.optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});
export type GroupListQuery = z.infer<typeof GroupListQuery>;

export const GroupList = z
  .object({ items: z.array(AdminGroupSummary), nextCursor: z.string().nullable() })
  .meta({ id: 'GroupList' });

export const ReorderSlidesInput = z
  .object({
    revision: z.int().min(1),
    slideIds: z
      .array(Uuid)
      .min(1)
      .max(LIMITS.slidesPerGroupMax)
      .refine((a) => new Set(a).size === a.length, { error: 'ID слайдов не должны повторяться' }),
  })
  .strict();

export const RevisionInput = z.object({ revision: z.int().min(1) }).strict();

export const RejectInput = z
  .object({ revision: z.int().min(1), comment: multiLineText(1000) })
  .strict();

export const UnpublishInput = z.object({ reason: multiLineText(500).optional() }).strict();

export const GroupVersion = z
  .object({
    version: z.int(),
    state: z.enum(['approved', 'published', 'superseded', 'archived']),
    approvedAt: IsoDateTime,
    approvedBy: UserRef,
    publishedAt: IsoDateTime.nullable(),
    archivedAt: IsoDateTime.nullable(),
    startAt: IsoDateTime,
    endAt: IsoDateTime,
  })
  .meta({ id: 'GroupVersion' });

export const GroupVersions = z.object({ items: z.array(GroupVersion) });

export const DiffChange = z.object({
  path: z.string(),
  before: z.unknown(),
  after: z.unknown(),
});

export const GroupDiff = z
  .object({
    /** Версия опубликованного снимка, с которой сравниваем (null — публикаций ещё не было). */
    baseVersion: z.int().nullable(),
    revision: z.int(),
    changes: z.array(DiffChange),
  })
  .meta({ id: 'GroupDiff' });
export type GroupDiff = z.infer<typeof GroupDiff>;

/** Превью рабочей копии в формате ленты. Медиа — подписанные URL с TTL 15 минут. */
export const GroupPreview = z
  .object({
    feed: FeedResponse,
    mediaOrigins: z.array(z.string()),
    warnings: z.array(z.string()),
  })
  .meta({ id: 'GroupPreview' });
export type GroupPreview = z.infer<typeof GroupPreview>;

// ---------------------------------------------------------------------------
// Медиа
// ---------------------------------------------------------------------------

export const UploadUrlInput = z
  .object({
    kind: MediaKind,
    purpose: MediaPurpose,
    contentType: UploadContentType,
    size: z.int().positive(),
    fileName: z.string().max(255).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const allowed: readonly string[] = ALLOWED_UPLOAD_CONTENT_TYPES[v.kind];
    if (!allowed.includes(v.contentType)) {
      ctx.addIssue({ code: 'custom', path: ['contentType'], message: 'Тип файла не подходит' });
    }
    const max = v.kind === 'image' ? LIMITS.imageMaxBytes : LIMITS.videoMaxBytes;
    if (v.size > max) {
      ctx.addIssue({
        code: 'custom',
        path: ['size'],
        message: `Файл больше ${Math.round(max / 1024 / 1024)} МБ`,
      });
    }
    if (v.purpose === 'cover' && v.kind !== 'image') {
      ctx.addIssue({ code: 'custom', path: ['kind'], message: 'Обложка — только изображение' });
    }
  })
  .meta({ id: 'UploadUrlInput' });
export type UploadUrlInput = z.infer<typeof UploadUrlInput>;

export const MediaPreview = z.object({
  url: z.string(),
  w: z.int(),
  h: z.int(),
  mime: z.string(),
});

export const AdminMediaAsset = z
  .object({
    id: Uuid,
    kind: MediaKind,
    purpose: MediaPurpose,
    status: MediaStatus,
    rejectReason: z.string().nullable(),
    width: z.int().nullable(),
    height: z.int().nullable(),
    durationMs: z.int().nullable(),
    size: z.int().nullable(),
    createdAt: IsoDateTime,
    /** Подписанные URL (TTL 15 минут), только для status=ready. */
    previews: z.array(MediaPreview),
    poster: MediaPreview.nullable(),
  })
  .meta({ id: 'AdminMediaAsset' });
export type AdminMediaAsset = z.infer<typeof AdminMediaAsset>;

export const UploadUrlResponse = z
  .object({
    asset: AdminMediaAsset,
    upload: z.object({
      url: z.string(),
      method: z.literal('PUT'),
      headers: z.record(z.string(), z.string()),
      expiresAt: IsoDateTime,
    }),
  })
  .meta({ id: 'UploadUrlResponse' });

// ---------------------------------------------------------------------------
// Справочники
// ---------------------------------------------------------------------------

export const SegmentDto = z.object({ id: z.string(), name: z.string() }).meta({ id: 'Segment' });
export const SegmentList = z.object({ items: z.array(SegmentDto) });

export const CatalogProductDto = z
  .object({
    sku: z.string(),
    name: z.string(),
    priceRub: z.number(),
    inStock: z.boolean(),
    imageUrl: z.string().nullable(),
  })
  .meta({ id: 'CatalogProduct' });
export type CatalogProductDto = z.infer<typeof CatalogProductDto>;

export const CatalogQuery = z.object({
  skus: z
    .string()
    .max(1000)
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    )
    .pipe(
      z
        .array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/))
        .min(1)
        .max(50),
    ),
});
export const CatalogProducts = z.object({ items: z.array(CatalogProductDto) });

// ---------------------------------------------------------------------------
// Пользователи, сессия
// ---------------------------------------------------------------------------

export const AdminUserDto = z
  .object({
    id: Uuid,
    email: z.string(),
    name: z.string(),
    roles: z.array(Role),
    disabled: z.boolean(),
    lastLoginAt: IsoDateTime.nullable(),
    createdAt: IsoDateTime,
  })
  .meta({ id: 'AdminUser' });
export type AdminUserDto = z.infer<typeof AdminUserDto>;

export const AdminUserList = z.object({ items: z.array(AdminUserDto) });

export const UserRolesInput = z
  .object({
    roles: z
      .array(Role)
      .max(4)
      .refine((a) => new Set(a).size === a.length, { error: 'Роли не должны повторяться' }),
  })
  .strict();

export const UserStatusInput = z.object({ disabled: z.boolean() }).strict();

export const Me = z
  .object({
    user: AdminUserDto,
    permissions: z.array(z.enum(PERMISSION_NAMES as [string, ...string[]])),
    csrfToken: z.string(),
    sessionExpiresAt: IsoDateTime,
  })
  .meta({ id: 'Me' });
export type Me = z.infer<typeof Me>;

export const LoginQuery = z.object({ returnTo: z.string().max(500).optional() });
export const CallbackQuery = z.object({
  code: z.string().max(2048).optional(),
  state: z.string().max(512).optional(),
  error: z.string().max(200).optional(),
});

// ---------------------------------------------------------------------------
// Настройки
// ---------------------------------------------------------------------------

export const CtaAllowlistDto = z
  .object({
    deeplinkSchemes: z.array(z.string().max(32)).max(20),
    urlDomains: z.array(z.string().max(253)).max(100),
  })
  .strict()
  .meta({ id: 'CtaAllowlist' });

export const SettingsDto = z
  .object({ feedEnabled: z.boolean(), ctaAllowlist: CtaAllowlistDto })
  .meta({ id: 'Settings' });
export type SettingsDto = z.infer<typeof SettingsDto>;

export const KILL_SWITCH_CONFIRMATION = { disable: 'ОТКЛЮЧИТЬ', enable: 'ВКЛЮЧИТЬ' } as const;

export const FeedEnabledInput = z
  .object({ enabled: z.boolean(), confirmation: z.string().max(50) })
  .strict()
  .refine(
    (v) =>
      v.confirmation.trim() ===
      (v.enabled ? KILL_SWITCH_CONFIRMATION.enable : KILL_SWITCH_CONFIRMATION.disable),
    { error: 'Подтвердите действие, введя слово полностью', path: ['confirmation'] },
  );

// ---------------------------------------------------------------------------
// Аудит
// ---------------------------------------------------------------------------

export const AuditEntryDto = z
  .object({
    id: z.string(),
    ts: IsoDateTime,
    actor: UserRef,
    action: z.string(),
    entityType: z.string(),
    entityId: z.string().nullable(),
    diff: z.unknown(),
    ip: z.string().nullable(),
    userAgent: z.string().nullable(),
    requestId: z.string().nullable(),
  })
  .meta({ id: 'AuditEntry' });

export const AuditQuery = z.object({
  actorId: Uuid.optional(),
  action: z.string().max(100).optional(),
  entityType: z.string().max(50).optional(),
  entityId: z.string().max(100).optional(),
  from: IsoDateTime.optional(),
  to: IsoDateTime.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(50).optional(),
});
export type AuditQuery = z.infer<typeof AuditQuery>;

export const AuditList = z.object({
  items: z.array(AuditEntryDto),
  nextCursor: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Статистика
// ---------------------------------------------------------------------------

export const IsoDate = z.iso.date();

export const StatsQuery = z
  .object({ from: IsoDate, to: IsoDate })
  .refine((v) => v.from <= v.to, { error: 'Период задан неверно', path: ['to'] });

const Counters = {
  impressions: z.int(),
  opens: z.int(),
  slideViews: z.int(),
  slideCompletes: z.int(),
  ctaClicks: z.int(),
  productClicks: z.int(),
  addToCart: z.int(),
  closes: z.int(),
  mediaErrors: z.int(),
};

export const GroupStats = z
  .object({
    groupId: Uuid,
    from: IsoDate,
    to: IsoDate,
    totals: z.object({ ...Counters, openRate: z.number().nullable(), ctr: z.number().nullable() }),
    slides: z.array(
      z.object({
        slideId: z.string(),
        position: z.int().nullable(),
        type: z.string().nullable(),
        views: z.int(),
        completes: z.int(),
        ctaClicks: z.int(),
        productClicks: z.int(),
        addToCart: z.int(),
        mediaErrors: z.int(),
        /** Доля открывших группу, досмотревших до этого слайда. */
        reach: z.number().nullable(),
        completionRate: z.number().nullable(),
        ctr: z.number().nullable(),
      }),
    ),
    daily: z.array(z.object({ date: IsoDate, ...Counters })),
  })
  .meta({ id: 'GroupStats' });
export type GroupStats = z.infer<typeof GroupStats>;
