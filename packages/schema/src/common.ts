import { z } from 'zod';

// ---------------------------------------------------------------------------
// Перечисления. Списки уточняются (раздел 15, вопрос №7) — расширяются здесь.
// ---------------------------------------------------------------------------

export const PLACEMENTS = ['home', 'catalog', 'product', 'cart'] as const;
export const Placement = z.enum(PLACEMENTS);
export type Placement = z.infer<typeof Placement>;

export const PLATFORMS = ['ios', 'android', 'web'] as const;
export const Platform = z.enum(PLATFORMS);
export type Platform = z.infer<typeof Platform>;

export const MOBILE_PLATFORMS = ['ios', 'android'] as const satisfies readonly Platform[];

export const GROUP_STATUSES = [
  'draft',
  'in_review',
  'approved',
  'published',
  'archived',
  'rejected',
] as const;
export const GroupStatus = z.enum(GROUP_STATUSES);
export type GroupStatus = z.infer<typeof GroupStatus>;

export const SLIDE_TYPES = ['image', 'video', 'product'] as const;
export const SlideType = z.enum(SLIDE_TYPES);
export type SlideType = z.infer<typeof SlideType>;

export const ROLES = ['editor', 'publisher', 'analyst', 'admin'] as const;
export const Role = z.enum(ROLES);
export type Role = z.infer<typeof Role>;

export const MEDIA_KINDS = ['image', 'video'] as const;
export const MediaKind = z.enum(MEDIA_KINDS);
export type MediaKind = z.infer<typeof MediaKind>;

export const MEDIA_PURPOSES = ['slide', 'cover'] as const;
export const MediaPurpose = z.enum(MEDIA_PURPOSES);
export type MediaPurpose = z.infer<typeof MediaPurpose>;

export const MEDIA_STATUSES = ['uploaded', 'processing', 'ready', 'rejected'] as const;
export const MediaStatus = z.enum(MEDIA_STATUSES);
export type MediaStatus = z.infer<typeof MediaStatus>;

// ---------------------------------------------------------------------------
// Примитивы
// ---------------------------------------------------------------------------

export const Uuid = z.uuid();

export const IsoDateTime = z.iso.datetime({ offset: true });

/** Версия приложения в min_app_version: строго MAJOR.MINOR.PATCH. */
export const SemVer = z
  .string()
  .regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/, { error: 'Версия в формате 5.12.0' });

/** Версия приложения из заголовка X-App-Version: 5, 5.12 или 5.12.0. */
export const AppVersion = z.string().regex(/^\d{1,4}(\.\d{1,4}){0,2}$/);

export const Sku = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, { error: 'Некорректный SKU' });
export const CategoryId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, { error: 'Некорректный ID категории' });

/** Непрозрачный ID сегмента из систем ИДБ. */
export const SegmentId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);

// ---------------------------------------------------------------------------
// Plain text (T3): никакой разметки не интерпретируется, но управляющие символы
// и bidi-override запрещены, чтобы нельзя было визуально подменить текст.
// ---------------------------------------------------------------------------

// C0/C1 control chars (кроме \n для многострочного текста), bidi overrides/isolates, BOM.
/* eslint-disable no-control-regex -- управляющие символы запрещены намеренно */
const SINGLE_LINE_TEXT_RE = /^[^\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\uFEFF]*$/;
const MULTI_LINE_TEXT_RE =
  /^[^\u0000-\u0009\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\uFEFF]*$/;
/* eslint-enable no-control-regex */

export function singleLineText(max: number) {
  return z
    .string()
    .trim()
    .overwrite((s) => s.normalize('NFC'))
    .min(1, { error: 'Поле не может быть пустым' })
    .max(max, { error: `Не длиннее ${max} символов` })
    .regex(SINGLE_LINE_TEXT_RE, { error: 'Текст содержит недопустимые символы' });
}

export function multiLineText(max: number) {
  return z
    .string()
    .trim()
    .overwrite((s) => s.normalize('NFC').replace(/\r\n?/g, '\n'))
    .min(1, { error: 'Поле не может быть пустым' })
    .max(max, { error: `Не длиннее ${max} символов` })
    .regex(MULTI_LINE_TEXT_RE, { error: 'Текст содержит недопустимые символы' });
}

// ---------------------------------------------------------------------------
// Лимиты предметной области (раздел 4.1, 5.1, 7)
// ---------------------------------------------------------------------------

export const LIMITS = {
  groupTitleMax: 40,
  ctaLabelMax: 24,
  textElementMax: 140,
  elementsPerSlideMax: 3,
  slidesPerGroupMax: 10,
  groupsPerFeedMax: 20,
  productSkusMin: 1,
  productSkusMax: 6,
  slideDurationMinMs: 3000,
  slideDurationMaxMs: 15000,
  slideDurationDefaultMs: 6000,
  videoDurationMaxMs: 60_000,
  segmentsPerGroupMax: 50,
  eventsPerBatchMax: 50,
  eventsBodyMaxBytes: 64 * 1024,
  imageMaxBytes: 15 * 1024 * 1024,
  videoMaxBytes: 200 * 1024 * 1024,
  feedTtlMaxSec: 60,
} as const;

export const ALLOWED_UPLOAD_CONTENT_TYPES = {
  image: ['image/jpeg', 'image/png', 'image/webp'],
  video: ['video/mp4', 'video/quicktime'],
} as const satisfies Record<MediaKind, readonly string[]>;

export const UploadContentType = z.enum([
  ...ALLOWED_UPLOAD_CONTENT_TYPES.image,
  ...ALLOWED_UPLOAD_CONTENT_TYPES.video,
]);
export type UploadContentType = z.infer<typeof UploadContentType>;

/** Сравнение версий вида 5.12.0 / 5.12 / 5. Недостающие части считаются нулями. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Для браузера под строгим CSP без 'unsafe-eval' (раздел 10.6): zod не будет проверять и использовать
 * `new Function` для ускоренных парсеров. Вызвать до первой валидации.
 */
export function disableZodJit(): void {
  z.config({ jitless: true });
}
