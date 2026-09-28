import { z } from 'zod';
import {
  Cta,
  FeedGroup,
  SlideElement,
  type FeedSlide,
  type MediaKind,
  type MediaPurpose,
  type MediaStatus,
  type SlideType,
} from '@idb-stories/schema';
import { MediaVariants, type StoredFile } from '../media.js';

export interface BuildSlide {
  id: string;
  type: SlideType;
  durationMs: number;
  mediaAssetId: string | null;
  elements: unknown;
  cta: unknown;
  productSkus: readonly string[];
}

export interface BuildGroupInput {
  id: string;
  title: string;
  coverAssetId: string | null;
  slides: readonly BuildSlide[];
}

export interface BuildAsset {
  id: string;
  kind: MediaKind;
  purpose: MediaPurpose;
  status: MediaStatus;
  durationMs: number | null;
  variants: unknown;
}

export interface BuildResult {
  group: FeedGroup | null;
  /** Причины, по которым группа (или её часть) не готова к публикации. */
  problems: string[];
  /** Все файлы медиа, на которые ссылается payload (копируются в public при публикации). */
  files: StoredFile[];
  mediaAssetIds: string[];
}

const Elements = z.array(SlideElement);

/**
 * Собирает группу в формате публичного API. `urlFor` превращает ключ файла в URL:
 * CDN при согласовании, подписанный URL — для превью черновика в админке.
 */
export function buildFeedGroup(
  input: BuildGroupInput,
  assets: ReadonlyMap<string, BuildAsset>,
  version: number,
  urlFor: (key: string) => string,
  /** Для превью: без обложки взять первый слайд-картинку, чтобы черновик было видно. */
  options: { coverFallback?: boolean } = {},
): BuildResult {
  const problems: string[] = [];
  const files: StoredFile[] = [];
  const assetIds = new Set<string>();

  const readyVariants = (assetId: string | null, kind: MediaKind, what: string) => {
    if (!assetId) {
      problems.push(`${what}: не выбрано медиа`);
      return null;
    }
    const asset = assets.get(assetId);
    if (!asset || asset.kind !== kind) {
      problems.push(`${what}: медиа не найдено`);
      return null;
    }
    if (asset.status !== 'ready') {
      problems.push(
        `${what}: ${asset.status === 'rejected' ? 'файл отклонён проверкой' : 'файл ещё обрабатывается'}`,
      );
      return null;
    }
    const parsed = MediaVariants.safeParse(asset.variants);
    if (!parsed.success) {
      problems.push(`${what}: повреждены данные медиа`);
      return null;
    }
    assetIds.add(asset.id);
    return { asset, variants: parsed.data };
  };

  // Обложка
  let cover: FeedGroup['cover'] | null = null;
  const coverMedia = readyVariants(input.coverAssetId, 'image', 'Обложка');
  if (coverMedia) {
    const v = coverMedia.variants.images.find((i) => i.name === '256x256');
    const webp = v?.files.find((f) => f.mime === 'image/webp');
    if (v && webp) {
      cover = { url: urlFor(webp.key), w: v.w, h: v.h };
      files.push(...v.files);
    } else {
      problems.push('Обложка: загрузите изображение как обложку (нужен вариант 256×256)');
    }
  }

  const slides: FeedSlide[] = [];
  input.slides.forEach((s, index) => {
    const what = `Слайд ${index + 1}`;
    const elements = Elements.safeParse(s.elements);
    const cta = s.cta === null || s.cta === undefined ? null : Cta.safeParse(s.cta);
    if (!elements.success || (cta && !cta.success)) {
      problems.push(`${what}: некорректные текст или CTA`);
      return;
    }
    const common = {
      id: s.id,
      elements: elements.data.map((e) => ({
        kind: e.kind,
        text: e.text,
        style: e.style,
        position: e.position,
      })),
      cta: cta?.success
        ? { type: cta.data.type, value: cta.data.value, label: cta.data.label }
        : null,
    };

    if (s.type === 'image') {
      const media = readyVariants(s.mediaAssetId, 'image', what);
      if (!media) return;
      const variants = media.variants.images
        .filter((v) => v.name === '1080x1920' || v.name === '720x1280')
        .sort((a, b) => b.w - a.w);
      const list = (['image/webp', 'image/jpeg'] as const).flatMap((mime) =>
        variants.flatMap((v) => {
          const f = v.files.find((x) => x.mime === mime);
          if (!f) return [];
          files.push(f);
          return [{ url: urlFor(f.key), w: v.w, h: v.h, mime }];
        }),
      );
      if (list.length === 0) {
        problems.push(`${what}: нет вариантов изображения (загружено как обложка?)`);
        return;
      }
      slides.push({
        ...common,
        type: 'image',
        duration_ms: s.durationMs,
        media: { variants: list },
      });
    } else if (s.type === 'video') {
      const media = readyVariants(s.mediaAssetId, 'video', what);
      if (!media) return;
      const poster = media.variants.poster;
      const posterWebp = poster?.files.find((f) => f.mime === 'image/webp');
      if (!poster || !posterWebp || media.variants.videos.length === 0 || !media.asset.durationMs) {
        problems.push(`${what}: неполные данные видео`);
        return;
      }
      files.push(...poster.files, ...media.variants.videos.map((v) => v.file));
      slides.push({
        ...common,
        type: 'video',
        duration_ms: media.asset.durationMs,
        media: {
          poster: { url: urlFor(posterWebp.key), w: poster.w, h: poster.h },
          variants: [...media.variants.videos]
            .sort((a, b) => b.w - a.w)
            .map((v) => ({
              url: urlFor(v.file.key),
              w: v.w,
              h: v.h,
              mime: 'video/mp4' as const,
              bitrate_kbps: v.bitrateKbps,
            })),
        },
      });
    } else {
      if (s.productSkus.length === 0) {
        problems.push(`${what}: не выбраны товары`);
        return;
      }
      slides.push({
        ...common,
        type: 'product',
        duration_ms: s.durationMs,
        product_skus: [...s.productSkus],
      });
    }
  });

  if (input.slides.length === 0) problems.push('В группе нет слайдов');

  if (!cover && options.coverFallback) {
    const firstImage = slides.find((s) => s.type === 'image');
    const v = firstImage?.type === 'image' ? firstImage.media.variants.at(-1) : undefined;
    if (v) cover = { url: v.url, w: v.w, h: v.h };
  }

  const candidate =
    cover && slides.length > 0
      ? { id: input.id, version, title: input.title, cover, slides }
      : null;
  let group: FeedGroup | null = null;
  if (candidate) {
    const checked = FeedGroup.safeParse(candidate);
    if (checked.success) group = checked.data;
    else problems.push('Группа не соответствует контракту ленты');
  }
  return { group, problems, files, mediaAssetIds: [...assetIds] };
}
