import type { MediaVariant, Slide } from './model.js';

/**
 * Выбор варианта: самый узкий с шириной ≥ нужной (ширина контейнера × devicePixelRatio),
 * иначе самый широкий. Для изображений предпочитается WebP (поддерживается всеми целевыми
 * браузерами), JPEG — запасной вариант.
 */
export function pickVariant(
  variants: readonly MediaVariant[],
  targetWidth: number,
): MediaVariant | null {
  if (variants.length === 0) return null;
  const webp = variants.filter((v) => v.mime === 'image/webp');
  const pool = webp.length > 0 ? webp : variants;
  const sorted = [...pool].sort((a, b) => a.w - b.w);
  return sorted.find((v) => v.w >= targetWidth) ?? sorted[sorted.length - 1] ?? null;
}

export function targetWidth(el: HTMLElement | null): number {
  const width = el?.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 0) || 0;
  const dpr =
    typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  return Math.ceil(width * dpr);
}

export function slideMediaUrl(slide: Slide, width: number): string | null {
  if (slide.type === 'product') return null;
  return pickVariant(slide.variants, width)?.url ?? null;
}

export type MediaState = 'loading' | 'loaded' | 'error';

/** Медиа-элемент слайда вместе с состоянием загрузки (загрузка может завершиться до показа). */
export class MediaHandle {
  state: MediaState = 'loading';
  private listeners: ((state: MediaState) => void)[] = [];

  constructor(
    readonly el: HTMLImageElement | HTMLVideoElement,
    readonly url: string,
  ) {
    const settle = (state: MediaState) => {
      if (this.state !== 'loading') return;
      this.state = state;
      const ls = this.listeners;
      this.listeners = [];
      for (const l of ls) l(state);
    };
    if (el instanceof HTMLImageElement) {
      el.addEventListener('load', () => settle('loaded'), { once: true });
      el.addEventListener('error', () => settle('error'), { once: true });
    } else {
      el.addEventListener('loadeddata', () => settle('loaded'), { once: true });
      el.addEventListener('error', () => settle('error'), { once: true });
    }
  }

  /** Вызывает колбэк, когда загрузка завершится (сразу, если уже завершилась). */
  onSettled(cb: (state: MediaState) => void): void {
    if (this.state !== 'loading') cb(this.state);
    else this.listeners.push(cb);
  }

  cancel(): void {
    this.listeners = [];
  }
}

export function createImage(url: string, className: string): MediaHandle {
  const img = document.createElement('img');
  img.className = className;
  img.alt = '';
  img.decoding = 'async';
  img.draggable = false;
  const handle = new MediaHandle(img, url);
  img.src = url;
  // Картинка из кеша может быть уже готова без события load.
  if (img.complete && img.naturalWidth > 0) handle.state = 'loaded';
  return handle;
}

export function createVideo(url: string, posterUrl: string | null, className: string): MediaHandle {
  const video = document.createElement('video');
  video.className = className;
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.preload = 'auto';
  video.controls = false;
  video.disablePictureInPicture = true;
  if (posterUrl) video.setAttribute('poster', posterUrl);
  const handle = new MediaHandle(video, url);
  video.src = url;
  return handle;
}

/** Предзагрузка картинки без вставки в DOM (обложка следующей группы). */
export function preloadImage(url: string): void {
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
}
