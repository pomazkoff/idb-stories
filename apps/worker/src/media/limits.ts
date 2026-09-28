import { LIMITS, type MediaPurpose } from '@idb-stories/schema';

/** Параметры проверки (раздел 7). TODO(spec): минимальный размер обложки не задан в ТЗ — 256×256. */
export const MEDIA_LIMITS = {
  imageMaxBytes: LIMITS.imageMaxBytes,
  videoMaxBytes: LIMITS.videoMaxBytes,
  imageMaxSide: 4096,
  slideMin: { width: 720, height: 1280 },
  coverMin: { width: 256, height: 256 },
  videoMaxDurationMs: LIMITS.videoDurationMaxMs,
  videoMaxFps: 60,
  /** «≤ 4K»: не больше 3840×2160 пикселей и не больше 4096 по стороне. */
  videoMaxPixels: 3840 * 2160,
  videoMaxSide: 4096,
  videoCodecs: ['h264', 'hevc'],
  audioCodecs: ['aac', 'mp3'],
} as const;

export function minSizeFor(purpose: MediaPurpose) {
  return purpose === 'cover' ? MEDIA_LIMITS.coverMin : MEDIA_LIMITS.slideMin;
}
