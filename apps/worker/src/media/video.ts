import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { VIDEO_VARIANTS } from '@idb-stories/core';
import { reject } from './errors.js';
import { ExecError, run } from './exec.js';
import { encodePoster, type EncodedFile } from './image.js';
import { MEDIA_LIMITS } from './limits.js';

export interface VideoTools {
  ffmpegPath: string;
  ffprobePath: string;
  threads: number;
}

export interface ProbeInfo {
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  audioCodec: string | null;
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  disposition?: { attached_pic?: number };
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
}

// Демуксер указан явно: ffmpeg не будет «угадывать» формат (HLS, concat и т.п. — классический SSRF),
// а протоколы ограничены локальными файлами.
const INPUT_GUARD = ['-protocol_whitelist', 'file', '-f', 'mov'];

function parseRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [n, d] = rate.split('/').map(Number);
  return d ? (n ?? 0) / d : (n ?? 0);
}

export async function probeVideo(
  tools: VideoTools,
  file: string,
  timeoutMs: number,
): Promise<ProbeInfo> {
  let out: string;
  try {
    ({ stdout: out } = await run(
      tools.ffprobePath,
      ['-v', 'error', ...INPUT_GUARD, '-show_format', '-show_streams', '-of', 'json', file],
      { timeoutMs },
    ));
  } catch (err) {
    if (err instanceof ExecError && err.timedOut)
      return reject('Проверка видео заняла слишком много времени');
    return reject('Файл видео повреждён или не читается');
  }
  const data = JSON.parse(out) as {
    format?: { format_name?: string; duration?: string };
    streams?: ProbeStream[];
  };
  const streams = data.streams ?? [];
  const video = streams.filter((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (video.length !== 1) return reject('В файле должна быть ровно одна видеодорожка');
  const v = video[0]!;
  if (!v.codec_name || !(MEDIA_LIMITS.videoCodecs as readonly string[]).includes(v.codec_name)) {
    return reject(`Кодек видео ${v.codec_name ?? '?'} не поддерживается (нужен H.264 или HEVC)`);
  }
  const audio = streams.find((s) => s.codec_type === 'audio');
  if (audio && !(MEDIA_LIMITS.audioCodecs as readonly string[]).includes(audio.codec_name ?? '')) {
    return reject(`Кодек звука ${audio.codec_name ?? '?'} не поддерживается (нужен AAC)`);
  }
  const duration = Number(data.format?.duration ?? v.duration ?? NaN);
  if (!Number.isFinite(duration) || duration <= 0)
    return reject('Не удалось определить длительность видео');
  if (duration * 1000 > MEDIA_LIMITS.videoMaxDurationMs + 50)
    return reject('Видео длиннее 60 секунд');
  const fps = parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate);
  if (!fps || fps > MEDIA_LIMITS.videoMaxFps + 0.5) return reject('Частота кадров выше 60 fps');
  const w = v.width ?? 0;
  const h = v.height ?? 0;
  if (!w || !h) return reject('Не удалось определить разрешение видео');
  if (w * h > MEDIA_LIMITS.videoMaxPixels || Math.max(w, h) > MEDIA_LIMITS.videoMaxSide) {
    return reject('Разрешение видео выше 4K');
  }
  const rotation = Math.abs(
    Number(
      v.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0,
    ),
  );
  const rotated = rotation === 90 || rotation === 270;
  return {
    durationMs: Math.min(Math.round(duration * 1000), MEDIA_LIMITS.videoMaxDurationMs),
    width: rotated ? h : w,
    height: rotated ? w : h,
    fps,
    videoCodec: v.codec_name,
    audioCodec: audio?.codec_name ?? null,
  };
}

export interface TranscodedVideo {
  variants: { name: string; w: number; h: number; bitrateKbps: number; data: Buffer }[];
  poster: { w: number; h: number; files: EncodedFile[] };
}

/** H.264/AAC MP4 в 1080p и 720p за один проход декодера, без метаданных, плюс постер. */
export async function transcodeVideo(
  tools: VideoTools,
  input: string,
  workDir: string,
  probe: ProbeInfo,
  timeoutMs: number,
): Promise<TranscodedVideo> {
  const deadline = Date.now() + timeoutMs;
  const outputs = VIDEO_VARIANTS.map((v) => ({ ...v, file: path.join(workDir, `${v.name}.mp4`) }));
  const filter = [
    `[0:v:0]split=${outputs.length}${outputs.map((_, i) => `[s${i}]`).join('')}`,
    ...outputs.map(
      (o, i) =>
        `[s${i}]scale=${o.w}:${o.h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${o.w}:${o.h},setsar=1[o${i}]`,
    ),
  ].join(';');
  const maxFrames = String(
    Math.ceil((MEDIA_LIMITS.videoMaxDurationMs / 1000) * MEDIA_LIMITS.videoMaxFps),
  );
  const args = [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...INPUT_GUARD,
    '-i',
    input,
    '-filter_complex',
    filter,
    ...outputs.flatMap((o, i) => [
      '-map',
      `[o${i}]`,
      '-map',
      '0:a:0?',
      '-t',
      '60',
      '-frames:v',
      maxFrames,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-profile:v',
      'high',
      '-pix_fmt',
      'yuv420p',
      '-b:v',
      `${o.bitrateKbps}k`,
      '-maxrate',
      `${Math.round(o.bitrateKbps * 1.1)}k`,
      '-bufsize',
      `${o.bitrateKbps * 2}k`,
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ac',
      '2',
      '-ar',
      '48000',
      '-map_metadata',
      '-1',
      '-map_chapters',
      '-1',
      '-movflags',
      '+faststart',
      '-threads',
      String(tools.threads),
      o.file,
    ]),
  ];
  try {
    await run(tools.ffmpegPath, args, { timeoutMs: deadline - Date.now() });
  } catch (err) {
    if (err instanceof ExecError && err.timedOut)
      return reject('Обработка видео заняла больше 5 минут');
    return reject('Не удалось перекодировать видео');
  }

  // Постер берём из нашего же перекодированного файла, а не из оригинала.
  const posterPng = path.join(workDir, 'poster.png');
  const seek = probe.durationMs > 1500 ? '0.5' : '0';
  const first = outputs[0]!;
  await run(
    tools.ffmpegPath,
    [
      '-nostdin',
      '-loglevel',
      'error',
      '-y',
      ...INPUT_GUARD,
      '-ss',
      seek,
      '-i',
      first.file,
      '-frames:v',
      '1',
      '-f',
      'image2',
      '-c:v',
      'png',
      posterPng,
    ],
    { timeoutMs: Math.max(1000, deadline - Date.now()) },
  ).catch(() => reject('Не удалось получить кадр для постера'));

  return {
    variants: await Promise.all(
      outputs.map(async (o) => ({
        name: o.name,
        w: o.w,
        h: o.h,
        bitrateKbps: o.bitrateKbps,
        data: await readFile(o.file),
      })),
    ),
    poster: { w: first.w, h: first.h, files: await encodePoster(posterPng, first.w, first.h) },
  };
}
