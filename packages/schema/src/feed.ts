import { z } from 'zod';
import { AppVersion, IsoDateTime, LIMITS, Placement, Platform, Uuid } from './common.js';
import { CtaTypeSchema, TEXT_POSITIONS, TEXT_STYLES } from './content.js';

/**
 * Публичный контракт ленты (раздел 5.1). Формат snake_case — его же читают нативные плееры.
 * Совместимость: новые поля можно добавлять, клиенты игнорируют неизвестные поля,
 * неизвестные `type` слайдов и `kind` элементов пропускают (раздел 8).
 */
export const FEED_SCHEMA_VERSION = 1;

export const FeedMediaRef = z
  .object({ url: z.url(), w: z.int().positive(), h: z.int().positive() })
  .meta({ id: 'FeedMediaRef' });

export const FeedImageVariant = FeedMediaRef.extend({
  mime: z.enum(['image/webp', 'image/jpeg']),
}).meta({ id: 'FeedImageVariant' });

export const FeedVideoVariant = FeedMediaRef.extend({
  mime: z.literal('video/mp4'),
  bitrate_kbps: z.int().positive(),
}).meta({ id: 'FeedVideoVariant' });

export const FeedTextElement = z
  .object({
    kind: z.literal('text'),
    text: z.string(),
    style: z.enum(TEXT_STYLES),
    position: z.enum(TEXT_POSITIONS),
  })
  .meta({ id: 'FeedTextElement' });

export const FeedElement = z
  .discriminatedUnion('kind', [FeedTextElement])
  .meta({ id: 'FeedElement' });

export const FeedCta = z
  .object({ type: CtaTypeSchema, value: z.string(), label: z.string() })
  .meta({ id: 'FeedCta' });

const slideCommon = {
  id: Uuid,
  duration_ms: z.int().positive(),
  elements: z.array(FeedElement),
  cta: FeedCta.nullable(),
};

export const FeedImageSlide = z
  .object({
    ...slideCommon,
    type: z.literal('image'),
    media: z.object({ variants: z.array(FeedImageVariant).min(1) }),
  })
  .meta({ id: 'FeedImageSlide' });

export const FeedVideoSlide = z
  .object({
    ...slideCommon,
    type: z.literal('video'),
    media: z.object({ poster: FeedMediaRef, variants: z.array(FeedVideoVariant).min(1) }),
  })
  .meta({ id: 'FeedVideoSlide' });

export const FeedProductSlide = z
  .object({
    ...slideCommon,
    type: z.literal('product'),
    product_skus: z.array(z.string()).min(1).max(LIMITS.productSkusMax),
  })
  .meta({ id: 'FeedProductSlide' });

export const FeedSlide = z
  .discriminatedUnion('type', [FeedImageSlide, FeedVideoSlide, FeedProductSlide])
  .meta({ id: 'FeedSlide' });
export type FeedSlide = z.infer<typeof FeedSlide>;

export const FeedGroup = z
  .object({
    id: Uuid,
    version: z.int().positive(),
    title: z.string(),
    cover: FeedMediaRef,
    slides: z.array(FeedSlide).min(1).max(LIMITS.slidesPerGroupMax),
  })
  .meta({ id: 'FeedGroup' });
export type FeedGroup = z.infer<typeof FeedGroup>;

export const FeedResponse = z
  .object({
    schema_version: z.literal(FEED_SCHEMA_VERSION),
    generated_at: IsoDateTime,
    ttl_sec: z.int().min(1).max(LIMITS.feedTtlMaxSec),
    groups: z.array(FeedGroup).max(LIMITS.groupsPerFeedMax),
  })
  .meta({ id: 'FeedResponse' });
export type FeedResponse = z.infer<typeof FeedResponse>;

export const FeedQuery = z.object({ placement: Placement });

/** Заголовки запроса ленты. X-App-Version обязателен для iOS и Android — проверяется в обработчике. */
export const FeedHeaders = z.object({
  'x-platform': Platform,
  'x-app-version': AppVersion.optional(),
  authorization: z.string().max(8192).optional(),
});
