import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryObjectStorage } from '@idb-stories/adapters';
import { createLogger, type MediaProcessJob, type MediaResultJob } from '@idb-stories/core';
import { processMedia, type MediaDeps } from '../src/media/process.js';
import { detectType } from '../src/media/signature.js';
import { findEmbeddedMarkup } from '../src/media/polyglot.js';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const ffmpegPath = require('ffmpeg-static') as string;
const ffprobePath = (require('ffprobe-static') as { path: string }).path;

const buckets = { quarantine: 'q', media: 'm' };
let storage: MemoryObjectStorage;
let deps: MediaDeps;
let tmp: string;
let n = 0;

async function run(
  data: Buffer,
  opts: Partial<
    Pick<MediaProcessJob, 'kind' | 'purpose' | 'declaredContentType' | 'declaredSize'>
  > = {},
): Promise<MediaResultJob> {
  const assetId = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const job: MediaProcessJob = {
    assetId,
    kind: opts.kind ?? 'image',
    purpose: opts.purpose ?? 'slide',
    originalKey: `uploads/${assetId}`,
    declaredContentType: opts.declaredContentType ?? 'image/jpeg',
    declaredSize: opts.declaredSize ?? data.length,
  };
  await storage.put(buckets.quarantine, job.originalKey, data, {
    contentType: 'application/octet-stream',
  });
  return processMedia(deps, job);
}

const rejectedWith = (r: MediaResultJob, re: RegExp) => {
  expect(r.status).toBe('rejected');
  if (r.status === 'rejected') expect(r.rejectReason).toMatch(re);
};

const image = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 60, b: 90 } } });

async function ffmpeg(args: string[]): Promise<Buffer> {
  const out = path.join(tmp, `v${++n}${args.includes('mov') ? '.mov' : '.mp4'}`);
  await exec(ffmpegPath, ['-y', '-loglevel', 'error', ...args, out]);
  return readFile(out);
}

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'media-test-'));
  storage = new MemoryObjectStorage();
  deps = {
    storage,
    buckets,
    tmpDir: tmp,
    timeoutMs: 120_000,
    tools: { ffmpegPath, ffprobePath, threads: 2 },
    logger: createLogger({ name: 'test', level: 'silent' }),
  };
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('раздел 10.11: вредоносные и неподходящие загрузки отклоняются', () => {
  it('SVG (в том числе под видом JPEG)', async () => {
    const svg = Buffer.from(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
    );
    rejectedWith(await run(svg, { declaredContentType: 'image/jpeg' }), /SVG/);
    rejectedWith(await run(Buffer.from('<svg><script>alert(1)</script></svg>')), /SVG/);
  });

  it('HTML', async () => {
    rejectedWith(
      await run(Buffer.from('\uFEFF  <!DOCTYPE html><html><script>alert(1)</script></html>')),
      /HTML/,
    );
  });

  it('polyglot JPEG+HTML: валидный JPEG со встроенной разметкой', async () => {
    const jpeg = await image(1080, 1920).jpeg().toBuffer();
    const appended = Buffer.concat([
      jpeg,
      Buffer.from('<html><body><script>alert(document.cookie)</script></body></html>'),
    ]);
    rejectedWith(await run(appended), /встроенная разметка/);
    // разметка в COM-сегменте JPEG
    const com = Buffer.from('<SCRIPT>alert(1)</SCRIPT>');
    const seg = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, com.length + 2]), com]);
    const inComment = Buffer.concat([jpeg.subarray(0, 2), seg, jpeg.subarray(2)]);
    rejectedWith(await run(inComment), /встроенная разметка/);
  });

  it('подменённое расширение: PNG как JPEG, картинка как видео, видео как картинка', async () => {
    const png = await image(1080, 1920).png().toBuffer();
    rejectedWith(await run(png, { declaredContentType: 'image/jpeg' }), /расширению/);
    rejectedWith(await run(png, { kind: 'video', declaredContentType: 'video/mp4' }), /типу медиа/);
  });

  it('бомба по разрешению: заголовок PNG заявляет 50000×50000', async () => {
    const png = await image(1080, 1920).png().toBuffer();
    const bomb = Buffer.from(png);
    bomb.writeUInt32BE(50_000, 16);
    bomb.writeUInt32BE(50_000, 20);
    rejectedWith(await run(bomb, { declaredContentType: 'image/png' }), /больше 4096/);
  });

  it('заголовок врёт о размерах — расхождение с содержимым', async () => {
    const png = await image(1080, 1920).png().toBuffer();
    const lie = Buffer.from(png);
    lie.writeUInt32BE(2000, 20);
    const res = await run(lie, { declaredContentType: 'image/png' });
    expect(res.status).toBe('rejected');
  });

  it('GIF, HEIC, AVIF, PDF, ZIP, неизвестный формат', async () => {
    const gif = await image(720, 1280).gif().toBuffer();
    rejectedWith(await run(gif), /GIF/);
    const heic = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from('ftypheic\0\0\0\0mif1heic'),
      Buffer.alloc(64),
    ]);
    rejectedWith(await run(heic), /HEIC/);
    const avif = await image(720, 1280).avif().toBuffer();
    rejectedWith(await run(avif), /AVIF/);
    rejectedWith(await run(Buffer.from('%PDF-1.7\n...')), /PDF/);
    rejectedWith(await run(Buffer.from('PK\x03\x04zipzipzip')), /ZIP/);
    rejectedWith(
      await run(Buffer.from('#EXTM3U\n#EXT-X-TARGETDURATION:10\nhttp://169.254.169.254/latest'), {
        kind: 'video',
        declaredContentType: 'video/mp4',
      }),
      /Неизвестный формат/,
    );
  });

  it('размер: не совпадает с заявленным и больше лимита', async () => {
    const jpeg = await image(1080, 1920).jpeg().toBuffer();
    rejectedWith(await run(jpeg, { declaredSize: jpeg.length + 1 }), /не совпадает с заявленным/);
    const huge = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff]),
      Buffer.alloc(15 * 1024 * 1024 + 10),
    ]);
    rejectedWith(await run(huge), /больше 15 МБ/);
  });

  it('слишком маленькое и горизонтальное изображение для слайда', async () => {
    rejectedWith(await run(await image(500, 800).jpeg().toBuffer()), /не меньше 720×1280/);
    rejectedWith(await run(await image(1920, 1080).jpeg().toBuffer()), /вертикальное/);
  });
});

describe('обязательное перекодирование', () => {
  it('JPEG с EXIF и GPS → WebP и JPEG 1080×1920 и 720×1280 без метаданных', async () => {
    const jpeg = await image(1242, 2208)
      .jpeg()
      .withExif({
        IFD0: { Copyright: 'secret', Artist: 'someone' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '55/1 45/1 0/1' },
      })
      .toBuffer();
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();
    const res = await run(jpeg);
    expect(res.status).toBe('ready');
    if (res.status !== 'ready') return;
    expect(res).toMatchObject({
      width: 1242,
      height: 2208,
      detectedMime: 'image/jpeg',
      durationMs: null,
    });
    expect(res.storageKey).toMatch(/^[0-9a-f]{32}$/);
    expect(res.variants.images.map((v) => [v.name, v.w, v.h])).toEqual([
      ['1080x1920', 1080, 1920],
      ['720x1280', 720, 1280],
    ]);
    for (const f of res.variants.images.flatMap((v) => v.files)) {
      expect(f.key.startsWith(`${res.storageKey}/`)).toBe(true);
      const stored = storage.objects.get(`${buckets.media}/${f.key}`)!;
      const meta = await sharp(stored.body).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
      expect(meta.format).toBe(f.mime === 'image/webp' ? 'webp' : 'jpeg');
    }
  });

  it('PNG и WebP проходят; обложка даёт 256×256', async () => {
    expect(
      (await run(await image(720, 1280).png().toBuffer(), { declaredContentType: 'image/png' }))
        .status,
    ).toBe('ready');
    expect(
      (await run(await image(900, 1600).webp().toBuffer(), { declaredContentType: 'image/webp' }))
        .status,
    ).toBe('ready');
    const cover = await run(await image(512, 512).jpeg().toBuffer(), { purpose: 'cover' });
    expect(cover.status).toBe('ready');
    if (cover.status === 'ready')
      expect(cover.variants.images.map((v) => v.name)).toEqual(['256x256']);
  });

  it('одинаковые файлы получают разные непредсказуемые ключи', async () => {
    const jpeg = await image(720, 1280).jpeg().toBuffer();
    const [a, b] = [await run(jpeg), await run(jpeg)];
    expect(a.status === 'ready' && b.status === 'ready' && a.storageKey !== b.storageKey).toBe(
      true,
    );
  });
});

describe('видео', () => {
  it('MP4 → H.264/AAC 1080p и 720p + постер, без метаданных', async () => {
    const mp4 = await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=720x1280:rate=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440',
      '-t',
      '2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-metadata',
      'location=+55.7558+037.6173/',
      '-metadata',
      'title=secret',
    ]);
    const res = await run(mp4, { kind: 'video', declaredContentType: 'video/mp4' });
    expect(res.status, JSON.stringify(res)).toBe('ready');
    if (res.status !== 'ready') return;
    expect(res.durationMs).toBeGreaterThanOrEqual(1900);
    expect(res.durationMs).toBeLessThanOrEqual(2100);
    expect(res.variants.videos.map((v) => [v.name, v.w, v.h, v.bitrateKbps])).toEqual([
      ['1080p', 1080, 1920, 2500],
      ['720p', 720, 1280, 1200],
    ]);
    expect(res.variants.poster?.files.map((f) => f.mime)).toEqual(['image/webp', 'image/jpeg']);
    const out = path.join(tmp, 'check.mp4');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      out,
      storage.objects.get(`${buckets.media}/${res.variants.videos[0]!.file.key}`)!.body,
    );
    const { stdout } = await exec(ffprobePath, [
      '-v',
      'error',
      '-show_format',
      '-show_streams',
      '-of',
      'json',
      out,
    ]);
    const probe = JSON.parse(stdout) as {
      format: { tags?: Record<string, string> };
      streams: { codec_name: string }[];
    };
    expect(probe.streams.map((s) => s.codec_name).sort()).toEqual(['aac', 'h264']);
    expect(JSON.stringify(probe.format.tags ?? {})).not.toMatch(/secret|55\.75/);
  }, 60_000);

  it('MOV проходит', async () => {
    const mov = await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=360x640:rate=25',
      '-t',
      '1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-f',
      'mov',
    ]);
    expect(detectType(mov)).toMatchObject({ kind: 'video', mime: 'video/quicktime' });
    expect((await run(mov, { kind: 'video', declaredContentType: 'video/quicktime' })).status).toBe(
      'ready',
    );
  }, 60_000);

  it('длиннее 60 секунд и выше 60 fps — отказ', async () => {
    const long = await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=160x284:rate=1',
      '-t',
      '62',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
    ]);
    rejectedWith(
      await run(long, { kind: 'video', declaredContentType: 'video/mp4' }),
      /длиннее 60/,
    );
    const fast = await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=160x284:rate=120',
      '-t',
      '1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
    ]);
    rejectedWith(await run(fast, { kind: 'video', declaredContentType: 'video/mp4' }), /60 fps/);
  }, 60_000);

  it('видео с чужим кодеком (MPEG-4 Part 2) — отказ', async () => {
    const mpeg4 = await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x568:rate=25',
      '-t',
      '1',
      '-c:v',
      'mpeg4',
    ]);
    rejectedWith(
      await run(mpeg4, { kind: 'video', declaredContentType: 'video/mp4' }),
      /Кодек видео/,
    );
  }, 60_000);
});

describe('детекторы', () => {
  it('маркеры разметки ищутся без учёта регистра и через границу чанков', () => {
    expect(findEmbeddedMarkup(Buffer.from('xx<ScRiPt>'))).toBe('<script');
    expect(findEmbeddedMarkup(Buffer.from('safe binary \x00\x01 data'))).toBeNull();
  });
});
