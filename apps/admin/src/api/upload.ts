import {
  ALLOWED_UPLOAD_CONTENT_TYPES,
  LIMITS,
  type MediaKind,
  type MediaPurpose,
  type UploadContentType,
} from '@idb-stories/schema';
import { ru } from '../i18n/ru.js';
import { api } from './endpoints.js';
import type { AdminMediaAsset } from './types.js';

/**
 * Загрузка медиа (раздел 7): presigned PUT прямо в quarantine bucket, затем `complete`.
 * Тип и размер проверяются до запроса URL; окончательная проверка — в изолированном воркере.
 */

export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadError';
  }
}

/** Минимальные размеры изображений — те же, что проверяет воркер (apps/worker/src/media/limits.ts). */
export const IMAGE_MIN = {
  slide: { width: 720, height: 1280 },
  cover: { width: 256, height: 256 },
} as const satisfies Record<MediaPurpose, { width: number; height: number }>;
export const IMAGE_MAX_SIDE = 4096;

const IMAGE_TYPES: readonly string[] = ALLOWED_UPLOAD_CONTENT_TYPES.image;
const VIDEO_TYPES: readonly string[] = ALLOWED_UPLOAD_CONTENT_TYPES.video;

export type FileCheck =
  | { ok: true; kind: MediaKind; contentType: UploadContentType }
  | { ok: false; message: string };

export function acceptAttribute(kind: MediaKind): string {
  return kind === 'image' ? IMAGE_TYPES.join(',') : `${VIDEO_TYPES.join(',')},.mov,.mp4`;
}

/** Определяет тип по MIME, который сообщил браузер, и проверяет лимит размера. */
export function checkFile(file: File, expected: MediaKind): FileCheck {
  let type = file.type.toLowerCase();
  // Некоторые системы не знают MIME для .mov — подставляем по расширению (воркер всё равно проверит сигнатуру).
  // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos
  if (!type && expected === 'video' && /\.mov$/i.test(file.name)) type = 'video/quicktime';
  const kind: MediaKind | null = IMAGE_TYPES.includes(type) ? 'image' : VIDEO_TYPES.includes(type) ? 'video' : null;
  if (kind !== expected) {
    return { ok: false, message: expected === 'image' ? ru.media.unsupportedImage : ru.media.unsupportedVideo };
  }
  if (file.size === 0) return { ok: false, message: ru.media.empty };
  const max = kind === 'image' ? LIMITS.imageMaxBytes : LIMITS.videoMaxBytes;
  if (file.size > max) return { ok: false, message: ru.media.tooLarge(max) };
  return { ok: true, kind, contentType: type as UploadContentType };
}

/**
 * Мягкая проверка размеров изображения до загрузки. Если браузер не может декодировать файл,
 * решение остаётся за воркером. blob:-URL не используется — он запрещён CSP (img-src).
 */
export async function checkImageDimensions(file: File, purpose: MediaPurpose): Promise<string | null> {
  if (typeof createImageBitmap !== 'function') return null;
  let width: number;
  let height: number;
  try {
    const bitmap = await createImageBitmap(file);
    width = bitmap.width;
    height = bitmap.height;
    bitmap.close();
  } catch {
    return null;
  }
  const min = IMAGE_MIN[purpose];
  if (width < min.width || height < min.height) return ru.media.tooSmall(min.width, min.height, width, height);
  if (width > IMAGE_MAX_SIDE || height > IMAGE_MAX_SIDE) return ru.media.tooBig(IMAGE_MAX_SIDE);
  return null;
}

/** Заголовки, которые браузер выставляет сам (Content-Length считается по телу). */
const BROWSER_MANAGED_HEADERS = new Set(['content-length', 'host', 'connection', 'cookie']);

/**
 * PUT файла по presigned URL через XMLHttpRequest — ради событий прогресса.
 * Отправляются ровно заголовки из ответа upload-url; cookie в хранилище не уходят (withCredentials=false).
 */
export function putFile(
  url: string,
  headers: Record<string, string>,
  file: Blob,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    xhr.withCredentials = false;
    for (const [name, value] of Object.entries(headers)) {
      if (!BROWSER_MANAGED_HEADERS.has(name.toLowerCase())) xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        resolve();
      } else {
        reject(new UploadError(ru.media.uploadFailed(xhr.status)));
      }
    };
    xhr.onerror = () => reject(new UploadError(ru.media.uploadNetwork));
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

export type UploadPhase = 'preparing' | 'uploading' | 'finishing';

export interface UploadCallbacks {
  onPhase?: (phase: UploadPhase) => void;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/** Полный цикл: проверка → upload-url → PUT → complete. Возвращает ассет в статусе processing. */
export async function uploadMedia(
  file: File,
  kind: MediaKind,
  purpose: MediaPurpose,
  { onPhase, onProgress, signal }: UploadCallbacks = {},
): Promise<AdminMediaAsset> {
  onPhase?.('preparing');
  const check = checkFile(file, kind);
  if (!check.ok) throw new UploadError(check.message);
  if (check.kind === 'image') {
    const problem = await checkImageDimensions(file, purpose);
    if (problem) throw new UploadError(problem);
  }
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const ticket = await api.createUploadUrl({
    kind: check.kind,
    purpose,
    contentType: check.contentType,
    size: file.size,
    fileName: file.name.slice(0, 255),
  });
  onPhase?.('uploading');
  await putFile(ticket.upload.url, ticket.upload.headers, file, (f) => onProgress?.(f), signal);
  onPhase?.('finishing');
  return api.completeUpload(ticket.asset.id);
}
