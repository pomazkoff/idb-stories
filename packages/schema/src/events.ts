import { z } from 'zod';
import { LIMITS, Placement, Platform, Sku, Uuid } from './common.js';
import { CtaTypeSchema } from './content.js';

/**
 * Аналитические события (раздел 9, docs/analytics-events.md).
 * Идентификатор пользователя в события НЕ передаётся: неизвестные поля отбрасываются схемой.
 */

export const EVENT_NAMES = [
  'stories_feed_shown',
  'story_group_open',
  'story_slide_view',
  'story_slide_complete',
  'story_cta_click',
  'story_product_click',
  'story_add_to_cart',
  'story_close',
  'story_media_error',
] as const;
export type EventName = (typeof EVENT_NAMES)[number];

const base = {
  event_id: z.uuid({ version: 'v4' }),
  ts: z.iso.datetime({ offset: true }),
  session_id: z.string().min(1).max(128),
  platform: Platform,
  app_version: z.string().max(32),
  placement: Placement,
};

const group = {
  group_id: Uuid,
  group_version: z.int().min(1),
};

const slide = {
  slide_id: Uuid,
  slide_index: z
    .int()
    .min(0)
    .max(LIMITS.slidesPerGroupMax - 1),
  // Строка, а не enum: клиент может сообщить о типе, который сервер уже не знает.
  slide_type: z.string().min(1).max(32),
};

export const StoriesFeedShown = z
  .object({
    ...base,
    event: z.literal('stories_feed_shown'),
    groups_count: z.int().min(0).max(LIMITS.groupsPerFeedMax),
    // Расширение раздела 9: какие кружки попали во вьюпорт — нужно для «Показов кружка».
    group_ids: z.array(Uuid).max(LIMITS.groupsPerFeedMax).optional(),
  })
  .meta({ id: 'StoriesFeedShown' });

export const StoryGroupOpen = z
  .object({
    ...base,
    ...group,
    event: z.literal('story_group_open'),
    source: z.enum(['tap', 'swipe', 'auto']),
  })
  .meta({ id: 'StoryGroupOpen' });

export const StorySlideView = z
  .object({ ...base, ...group, ...slide, event: z.literal('story_slide_view') })
  .meta({ id: 'StorySlideView' });

export const StorySlideComplete = z
  .object({ ...base, ...group, ...slide, event: z.literal('story_slide_complete') })
  .meta({ id: 'StorySlideComplete' });

export const StoryCtaClick = z
  .object({
    ...base,
    ...group,
    ...slide,
    event: z.literal('story_cta_click'),
    cta_type: CtaTypeSchema,
    cta_value: z.string().min(1).max(2048),
  })
  .meta({ id: 'StoryCtaClick' });

export const StoryProductClick = z
  .object({ ...base, ...group, ...slide, event: z.literal('story_product_click'), sku: Sku })
  .meta({ id: 'StoryProductClick' });

export const StoryAddToCart = z
  .object({ ...base, ...group, ...slide, event: z.literal('story_add_to_cart'), sku: Sku })
  .meta({ id: 'StoryAddToCart' });

export const StoryClose = z
  .object({
    ...base,
    ...group,
    event: z.literal('story_close'),
    reason: z.enum(['swipe', 'button', 'end']),
    watched_slides: z.int().min(0).max(LIMITS.slidesPerGroupMax),
  })
  .meta({ id: 'StoryClose' });

export const StoryMediaError = z
  .object({
    ...base,
    ...group,
    ...slide,
    event: z.literal('story_media_error'),
    error_code: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),
  })
  .meta({ id: 'StoryMediaError' });

export const StoryEvent = z
  .discriminatedUnion('event', [
    StoriesFeedShown,
    StoryGroupOpen,
    StorySlideView,
    StorySlideComplete,
    StoryCtaClick,
    StoryProductClick,
    StoryAddToCart,
    StoryClose,
    StoryMediaError,
  ])
  .meta({ id: 'StoryEvent' });
export type StoryEvent = z.infer<typeof StoryEvent>;

/** Тело запроса: события валидируются по одному, невалидные отбрасываются и считаются. */
export const EventsBatch = z
  .object({ events: z.array(z.unknown()).min(1).max(LIMITS.eventsPerBatchMax) })
  .meta({ id: 'EventsBatch' });

export const EventsAccepted = z
  .object({ accepted: z.int().min(0), rejected: z.int().min(0) })
  .meta({ id: 'EventsAccepted' });
export type EventsAccepted = z.infer<typeof EventsAccepted>;
