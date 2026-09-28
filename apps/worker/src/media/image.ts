import sharp, { type Metadata } from 'sharp';
import { IMAGE_VARIANTS } from '@idb-stories/core';
import type { MediaPurpose } from '@idb-stories/schema';
import { reject } from './errors.js';
import { readImageHeader } from './image-header.js';
import { MEDIA_LIMITS, minSizeFor } from './limits.js';

let configured = false;

/**
 * libvips в режиме минимальной поверхности атаки (раздел 10.5): все загрузчики заблокированы,
 * кроме JPEG/PNG/WebP; кеш выключен; лимит пикселей на входе.
 */
export function configureSharp(): void {
  if (configured) return;
  sharp.cache(false);
  sharp.concurrency(1);
  sharp.block({ operation: ['VipsForeignLoad'] });
  sharp.unblock({
    operation: ['Jpeg', 'Png', 'Webp'].flatMap((f) =>
      ['File', 'Buffer', 'Source'].map((s) => `VipsForeignLoad${f}${s}`),
    ),
  });
  configured = true;
}

export interface EncodedFile {
  name: string;
  ext: 'webp' | 'jpg';
  mime: 'image/webp' | 'image/jpeg';
  data: Buffer;
}

export interface ImageResult {
  width: number;
  height: number;
  variants: { name: string; w: number; h: number; files: EncodedFile[] }[];
}

const INPUT_OPTIONS = {
  limitInputPixels: MEDIA_LIMITS.imageMaxSide * MEDIA_LIMITS.imageMaxSide,
  failOn: 'error',
  sequentialRead: true,
} as const;

/** Проверяет размеры (заголовок + метаданные libvips) и перекодирует во все варианты. */
export async function processImage(
  path: string,
  head: Buffer,
  mime: 'image/jpeg' | 'image/png' | 'image/webp',
  purpose: MediaPurpose,
  timeoutSec: number,
): Promise<ImageResult> {
  configureSharp();
  const header = readImageHeader(mime, head);
  if (!header) return reject('Не удалось прочитать размеры изображения');
  if (header.animated) return reject('Анимированные изображения не поддерживаются');
  if (header.width > MEDIA_LIMITS.imageMaxSide || header.height > MEDIA_LIMITS.imageMaxSide) {
    return reject(`Изображение больше ${MEDIA_LIMITS.imageMaxSide}×${MEDIA_LIMITS.imageMaxSide}`);
  }

  let meta: Metadata;
  try {
    meta = await sharp(path, INPUT_OPTIONS).metadata();
  } catch {
    return reject('Файл изображения повреждён');
  }
  if (meta.width !== header.width || meta.height !== header.height) {
    return reject('Размеры в заголовке не совпадают с содержимым файла');
  }
  if ((meta.pages ?? 1) > 1)
    return reject('Многостраничные и анимированные изображения не поддерживаются');
  // EXIF-ориентация 5–8 поворачивает изображение на 90°.
  const rotated = (meta.orientation ?? 1) >= 5;
  const width = rotated ? header.height : header.width;
  const height = rotated ? header.width : header.height;
  const min = minSizeFor(purpose);
  if (width < min.width || height < min.height) {
    return reject(
      purpose === 'cover'
        ? `Обложка должна быть не меньше ${min.width}×${min.height}`
        : `Нужно вертикальное изображение не меньше ${min.width}×${min.height}, загружено ${width}×${height}`,
    );
  }

  const variants: ImageResult['variants'] = [];
  for (const v of IMAGE_VARIANTS[purpose]) {
    const base = () =>
      sharp(path, INPUT_OPTIONS)
        .rotate() // применяем EXIF-ориентацию; метаданные (EXIF, GPS, XMP) в выход не попадают
        .resize(v.w, v.h, { fit: 'cover', position: 'centre' })
        .timeout({ seconds: timeoutSec });
    try {
      const [webp, jpg] = await Promise.all([
        base().webp({ quality: 82, effort: 4 }).toBuffer(),
        base()
          .flatten({ background: '#ffffff' })
          .jpeg({ quality: 82, mozjpeg: true, progressive: true })
          .toBuffer(),
      ]);
      variants.push({
        name: v.name,
        w: v.w,
        h: v.h,
        files: [
          { name: v.name, ext: 'webp', mime: 'image/webp', data: webp },
          { name: v.name, ext: 'jpg', mime: 'image/jpeg', data: jpg },
        ],
      });
    } catch {
      return reject('Не удалось перекодировать изображение');
    }
  }
  return { width, height, variants };
}

/** Постер видео: кадр из уже перекодированного нами файла → WebP и JPEG. */
export async function encodePoster(pngPath: string, w: number, h: number): Promise<EncodedFile[]> {
  configureSharp();
  const base = () => sharp(pngPath, INPUT_OPTIONS).resize(w, h, { fit: 'cover' });
  const [webp, jpg] = await Promise.all([
    base().webp({ quality: 80 }).toBuffer(),
    base().jpeg({ quality: 80, mozjpeg: true }).toBuffer(),
  ]);
  return [
    { name: 'poster', ext: 'webp', mime: 'image/webp', data: webp },
    { name: 'poster', ext: 'jpg', mime: 'image/jpeg', data: jpg },
  ];
}
