import { z } from 'zod';

/**
 * Результаты медиа-пайплайна (раздел 7). Файлы лежат в bucket media под непредсказуемым
 * префиксом storageKey; при публикации копируются в bucket public под тем же ключом.
 */
export const StoredFile = z.object({
  key: z.string().min(1),
  size: z.int().nonnegative(),
  mime: z.enum(['image/webp', 'image/jpeg', 'video/mp4']),
});
export type StoredFile = z.infer<typeof StoredFile>;

export const IMAGE_VARIANTS = {
  slide: [
    { name: '1080x1920', w: 1080, h: 1920 },
    { name: '720x1280', w: 720, h: 1280 },
  ],
  cover: [{ name: '256x256', w: 256, h: 256 }],
} as const;

export const VIDEO_VARIANTS = [
  { name: '1080p', w: 1080, h: 1920, bitrateKbps: 2500 },
  { name: '720p', w: 720, h: 1280, bitrateKbps: 1200 },
] as const;

export const ImageVariant = z.object({
  name: z.string(),
  w: z.int().positive(),
  h: z.int().positive(),
  /** WebP и JPEG-фолбэк */
  files: z.array(StoredFile).min(1),
});

export const VideoVariant = z.object({
  name: z.string(),
  w: z.int().positive(),
  h: z.int().positive(),
  bitrateKbps: z.int().positive(),
  file: StoredFile,
});

export const MediaVariants = z.object({
  images: z.array(ImageVariant).default([]),
  videos: z.array(VideoVariant).default([]),
  poster: ImageVariant.nullable().default(null),
});
export type MediaVariants = z.infer<typeof MediaVariants>;

/** Все файлы результата — для копирования в public при публикации и подписи превью. */
export function variantFiles(variants: MediaVariants): StoredFile[] {
  return [
    ...variants.images.flatMap((v) => v.files),
    ...variants.videos.map((v) => v.file),
    ...(variants.poster?.files ?? []),
  ];
}

export const PUBLIC_MEDIA_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export function quarantineKey(assetId: string): string {
  return `uploads/${assetId}`;
}
