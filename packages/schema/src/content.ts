import { z } from 'zod';
import { CTA_VALUE_MAX_LENGTH } from './allowlist.js';
import {
  IsoDateTime,
  LIMITS,
  Placement,
  Platform,
  SegmentId,
  SemVer,
  Sku,
  Uuid,
  multiLineText,
  singleLineText,
} from './common.js';

// ---------------------------------------------------------------------------
// Элементы слайда (JSONB `elements`). Дискриминатор `kind` — расширяемый:
// опросы и квизы следующей версии добавляются новым вариантом union.
// ---------------------------------------------------------------------------

export const TEXT_STYLES = ['title', 'body', 'caption'] as const;
export const TEXT_POSITIONS = ['top', 'center', 'bottom'] as const;

export const TextElement = z
  .object({
    kind: z.literal('text'),
    text: multiLineText(LIMITS.textElementMax),
    style: z.enum(TEXT_STYLES),
    position: z.enum(TEXT_POSITIONS),
  })
  .strict()
  .meta({ id: 'TextElement' });
export type TextElement = z.infer<typeof TextElement>;

export const SlideElement = z
  .discriminatedUnion('kind', [TextElement])
  .meta({ id: 'SlideElement' });
export type SlideElement = z.infer<typeof SlideElement>;

export const SlideElements = z.array(SlideElement).max(LIMITS.elementsPerSlideMax);

// ---------------------------------------------------------------------------
// CTA. Значение дополнительно проверяется по allowlist на сервере (раздел 10.4).
// ---------------------------------------------------------------------------

export const CTA_TYPES = ['deeplink', 'product', 'category', 'url'] as const;
export const CtaTypeSchema = z.enum(CTA_TYPES);

export const Cta = z
  .object({
    type: CtaTypeSchema,
    value: z.string().trim().min(1).max(CTA_VALUE_MAX_LENGTH),
    label: singleLineText(LIMITS.ctaLabelMax),
  })
  .strict()
  .meta({ id: 'Cta' });
export type Cta = z.infer<typeof Cta>;

// ---------------------------------------------------------------------------
// Слайды (ввод в админке)
// ---------------------------------------------------------------------------

const Duration = z
  .int()
  .min(LIMITS.slideDurationMinMs)
  .max(LIMITS.slideDurationMaxMs)
  .default(LIMITS.slideDurationDefaultMs);

const slideCommon = {
  elements: SlideElements.default([]),
  cta: Cta.nullable().default(null),
};

export const ImageSlideInput = z
  .object({ type: z.literal('image'), mediaAssetId: Uuid, durationMs: Duration, ...slideCommon })
  .strict();

export const VideoSlideInput = z
  .object({ type: z.literal('video'), mediaAssetId: Uuid, ...slideCommon })
  .strict();

export const ProductSlideInput = z
  .object({
    type: z.literal('product'),
    productSkus: z
      .array(Sku)
      .min(LIMITS.productSkusMin)
      .max(LIMITS.productSkusMax)
      .refine((a) => new Set(a).size === a.length, { error: 'SKU не должны повторяться' }),
    durationMs: Duration,
    ...slideCommon,
  })
  .strict();

export const SlideInput = z
  .discriminatedUnion('type', [ImageSlideInput, VideoSlideInput, ProductSlideInput])
  .meta({ id: 'SlideInput' });
export type SlideInput = z.infer<typeof SlideInput>;

// ---------------------------------------------------------------------------
// Группа (ввод в админке)
// ---------------------------------------------------------------------------

export const MinAppVersion = z
  .object({ ios: SemVer.nullable().default(null), android: SemVer.nullable().default(null) })
  .strict();

const uniqueArray = <T extends z.ZodType>(item: T, min: number, max: number) =>
  z
    .array(item)
    .min(min)
    .max(max)
    .refine((a) => new Set(a).size === a.length, { error: 'Значения не должны повторяться' });

// Поля без значений по умолчанию: основа и для создания, и для частичного обновления
// (в zod 4 default внутри optional всё равно применяется, поэтому PATCH строится отдельно).
const groupFieldShape = {
  title: singleLineText(LIMITS.groupTitleMax),
  placement: Placement,
  priority: z.int().min(-1000).max(1000),
  startAt: IsoDateTime,
  endAt: IsoDateTime,
  platforms: uniqueArray(Platform, 1, 3),
  minAppVersion: MinAppVersion,
  segmentIds: uniqueArray(SegmentId, 0, LIMITS.segmentsPerGroupMax),
  coverAssetId: Uuid.nullable(),
};

const endAfterStart = (v: { startAt?: string | undefined; endAt?: string | undefined }) =>
  v.startAt === undefined || v.endAt === undefined || Date.parse(v.endAt) > Date.parse(v.startAt);

export const GroupCreateInput = z
  .object({
    ...groupFieldShape,
    priority: groupFieldShape.priority.default(0),
    minAppVersion: MinAppVersion.default({ ios: null, android: null }),
    segmentIds: groupFieldShape.segmentIds.default([]),
    coverAssetId: groupFieldShape.coverAssetId.default(null),
  })
  .strict()
  .refine(endAfterStart, { error: 'Окончание должно быть позже начала', path: ['endAt'] })
  .meta({ id: 'GroupCreateInput' });
export type GroupCreateInput = z.infer<typeof GroupCreateInput>;

/**
 * Частичное обновление. `revision` — оптимистическая блокировка: правка применяется,
 * только если группа не менялась с момента чтения.
 */
export const GroupUpdateInput = z
  .object(groupFieldShape)
  .partial()
  .extend({ revision: z.int().min(1) })
  .strict()
  .refine(endAfterStart, { error: 'Окончание должно быть позже начала', path: ['endAt'] })
  .meta({ id: 'GroupUpdateInput' });
export type GroupUpdateInput = z.infer<typeof GroupUpdateInput>;
