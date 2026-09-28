import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import type { ObjectStorage } from '@idb-stories/adapters';
import type {
  Logger,
  MediaProcessJob,
  MediaResultJob,
  MediaVariants,
  StoredFile,
} from '@idb-stories/core';
import { MediaRejection, reject } from './errors.js';
import { processImage } from './image.js';
import { MEDIA_LIMITS } from './limits.js';
import { PolyglotScanner } from './polyglot.js';
import { declaredMatches, detectType } from './signature.js';
import { probeVideo, transcodeVideo, type VideoTools } from './video.js';

export interface MediaDeps {
  storage: ObjectStorage;
  buckets: { quarantine: string; media: string };
  tmpDir: string;
  timeoutMs: number;
  tools: VideoTools;
  logger: Logger;
}

/** Сколько байт начала файла держим в памяти для сигнатуры и заголовка изображения. */
const HEAD_BYTES = 1024 * 1024;

async function download(deps: MediaDeps, key: string, file: string, maxBytes: number) {
  const stream = await deps.storage.getStream(deps.buckets.quarantine, key);
  const hash = createHash('sha256');
  const scanner = new PolyglotScanner();
  const head: Buffer[] = [];
  let headLen = 0;
  let total = 0;
  const out = createWriteStream(file, { flags: 'wx', mode: 0o600 });
  try {
    for await (const raw of stream) {
      const chunk = raw as Buffer;
      total += chunk.length;
      if (total > maxBytes) {
        stream.destroy();
        return reject(`Файл больше ${Math.round(maxBytes / 1024 / 1024)} МБ`);
      }
      hash.update(chunk);
      scanner.push(chunk);
      if (headLen < HEAD_BYTES) {
        head.push(chunk.subarray(0, HEAD_BYTES - headLen));
        headLen += Math.min(chunk.length, HEAD_BYTES - headLen);
      }
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
    }
  } finally {
    out.end();
    await finished(out).catch(() => undefined);
  }
  return {
    sha256: hash.digest('hex'),
    head: Buffer.concat(head),
    size: total,
    polyglot: scanner.found,
  };
}

async function upload(
  deps: MediaDeps,
  key: string,
  data: Buffer,
  mime: StoredFile['mime'],
): Promise<StoredFile> {
  await deps.storage.put(deps.buckets.media, key, data, { contentType: mime });
  return { key, size: data.length, mime };
}

/**
 * Обработка одного файла (раздел 7.2): размер → сигнатура → соответствие заявленному типу →
 * поиск встроенной разметки → параметры → обязательное перекодирование → bucket media
 * под непредсказуемым ключом. Отказ — это результат, а не ошибка задачи.
 */
export async function processMedia(deps: MediaDeps, job: MediaProcessJob): Promise<MediaResultJob> {
  const deadline = Date.now() + deps.timeoutMs;
  const dir = await mkdtemp(path.join(deps.tmpDir, 'media-'));
  let sha256: string | null = null;
  let detectedMime: string | null = null;
  try {
    const maxBytes = job.kind === 'image' ? MEDIA_LIMITS.imageMaxBytes : MEDIA_LIMITS.videoMaxBytes;
    const head = await deps.storage.head(deps.buckets.quarantine, job.originalKey);
    if (!head) return reject('Файл не найден — загрузите его заново');
    if (head.size > maxBytes) return reject(`Файл больше ${Math.round(maxBytes / 1024 / 1024)} МБ`);
    if (head.size !== job.declaredSize)
      return reject('Размер файла не совпадает с заявленным при загрузке');

    const input = path.join(dir, 'input');
    const file = await download(deps, job.originalKey, input, maxBytes);
    sha256 = file.sha256;
    const type = detectType(file.head);
    if (type.kind === 'forbidden')
      return reject(`Формат ${type.name} не поддерживается. Разрешены JPEG, PNG, WebP, MP4, MOV`);
    if (type.kind === 'unknown')
      return reject('Неизвестный формат файла. Разрешены JPEG, PNG, WebP, MP4, MOV');
    detectedMime = type.mime;
    if (type.kind !== job.kind)
      return reject('Содержимое файла не соответствует выбранному типу медиа');
    if (!declaredMatches(job.declaredContentType, type)) {
      return reject('Содержимое файла не соответствует его расширению');
    }
    if (file.polyglot) return reject('В файле найдена встроенная разметка — файл отклонён');

    const storageKey = createHash('sha256')
      .update(file.sha256)
      .update(randomBytes(16))
      .digest('hex')
      .slice(0, 32);
    const timeLeftSec = () => Math.max(1, Math.floor((deadline - Date.now()) / 1000));

    if (type.kind === 'image') {
      const img = await processImage(input, file.head, type.mime, job.purpose, timeLeftSec());
      const variants: MediaVariants = { images: [], videos: [], poster: null };
      for (const v of img.variants) {
        const files = await Promise.all(
          v.files.map((f) => upload(deps, `${storageKey}/${f.name}.${f.ext}`, f.data, f.mime)),
        );
        variants.images.push({ name: v.name, w: v.w, h: v.h, files });
      }
      return {
        assetId: job.assetId,
        status: 'ready',
        detectedMime: type.mime,
        sha256: file.sha256,
        size: file.size,
        width: img.width,
        height: img.height,
        durationMs: null,
        storageKey,
        variants,
      };
    }

    const probe = await probeVideo(deps.tools, input, Math.min(60_000, deadline - Date.now()));
    const out = await transcodeVideo(deps.tools, input, dir, probe, deadline - Date.now());
    const variants: MediaVariants = { images: [], videos: [], poster: null };
    for (const v of out.variants) {
      const f = await upload(deps, `${storageKey}/${v.name}.mp4`, v.data, 'video/mp4');
      variants.videos.push({ name: v.name, w: v.w, h: v.h, bitrateKbps: v.bitrateKbps, file: f });
    }
    variants.poster = {
      name: 'poster',
      w: out.poster.w,
      h: out.poster.h,
      files: await Promise.all(
        out.poster.files.map((f) => upload(deps, `${storageKey}/poster.${f.ext}`, f.data, f.mime)),
      ),
    };
    return {
      assetId: job.assetId,
      status: 'ready',
      detectedMime: type.mime,
      sha256: file.sha256,
      size: file.size,
      width: probe.width,
      height: probe.height,
      durationMs: probe.durationMs,
      storageKey,
      variants,
    };
  } catch (err) {
    if (err instanceof MediaRejection) {
      deps.logger.warn(
        { assetId: job.assetId, reason: err.reason, sha256, detectedMime },
        'Файл отклонён',
      );
      return {
        assetId: job.assetId,
        status: 'rejected',
        rejectReason: err.reason,
        sha256,
        detectedMime,
      };
    }
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
