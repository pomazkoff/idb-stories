import { describe, expect, it } from 'vitest';
import { buildFeedGroup, type BuildAsset, type BuildGroupInput } from '../src/feed/build.js';
import type { MediaVariants } from '../src/media.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const file = (key: string, mime: 'image/webp' | 'image/jpeg' | 'video/mp4') => ({
  key,
  size: 1,
  mime,
});
const imageVariants: MediaVariants = {
  images: [
    {
      name: '1080x1920',
      w: 1080,
      h: 1920,
      files: [file('i/1080.webp', 'image/webp'), file('i/1080.jpg', 'image/jpeg')],
    },
    {
      name: '720x1280',
      w: 720,
      h: 1280,
      files: [file('i/720.webp', 'image/webp'), file('i/720.jpg', 'image/jpeg')],
    },
  ],
  videos: [],
  poster: null,
};
const coverVariants: MediaVariants = {
  images: [{ name: '256x256', w: 256, h: 256, files: [file('c/256.webp', 'image/webp')] }],
  videos: [],
  poster: null,
};
const videoVariants: MediaVariants = {
  images: [],
  videos: [
    { name: '720p', w: 720, h: 1280, bitrateKbps: 1200, file: file('v/720.mp4', 'video/mp4') },
    { name: '1080p', w: 1080, h: 1920, bitrateKbps: 2500, file: file('v/1080.mp4', 'video/mp4') },
  ],
  poster: { name: 'poster', w: 1080, h: 1920, files: [file('v/p.webp', 'image/webp')] },
};

const asset = (
  id: number,
  kind: 'image' | 'video',
  variants: unknown,
  extra: Partial<BuildAsset> = {},
): BuildAsset => ({
  id: uuid(id),
  kind,
  purpose: 'slide',
  status: 'ready',
  durationMs: kind === 'video' ? 9000 : null,
  variants,
  ...extra,
});

const assets = new Map<string, BuildAsset>([
  [uuid(1), asset(1, 'image', coverVariants, { purpose: 'cover' })],
  [uuid(2), asset(2, 'image', imageVariants)],
  [uuid(3), asset(3, 'video', videoVariants)],
  [uuid(4), asset(4, 'image', imageVariants, { status: 'processing' })],
  [uuid(5), asset(5, 'image', imageVariants, { status: 'rejected' })],
  [uuid(6), asset(6, 'image', { images: 'broken' })],
  [uuid(7), asset(7, 'video', { ...videoVariants, poster: null })],
  [uuid(8), asset(8, 'image', coverVariants)],
]);
const url = (k: string) => `https://cdn.test/${k}`;

const slide = (
  n: number,
  type: 'image' | 'video' | 'product',
  mediaAssetId: string | null,
  extra: object = {},
) => ({
  id: uuid(100 + n),
  type,
  durationMs: 5000,
  mediaAssetId,
  elements: [],
  cta: null,
  productSkus: [] as string[],
  ...extra,
});

describe('buildFeedGroup', () => {
  it('собирает группу: картинка (webp потом jpeg, по убыванию ширины), видео, товары', () => {
    const input: BuildGroupInput = {
      id: uuid(50),
      title: 'Т',
      coverAssetId: uuid(1),
      slides: [
        slide(1, 'image', uuid(2), {
          cta: { type: 'category', value: 'cat', label: 'Смотреть' },
          elements: [{ kind: 'text', text: 't', style: 'title', position: 'top' }],
        }),
        slide(2, 'video', uuid(3)),
        slide(3, 'product', null, { productSkus: ['SKU1'] }),
      ],
    };
    const res = buildFeedGroup(input, assets, 2, url);
    expect(res.problems).toEqual([]);
    expect(res.group?.cover).toEqual({ url: 'https://cdn.test/c/256.webp', w: 256, h: 256 });
    const [img, vid, prod] = res.group!.slides;
    expect(img?.type === 'image' && img.media.variants.map((v) => `${v.mime}:${v.w}`)).toEqual([
      'image/webp:1080',
      'image/webp:720',
      'image/jpeg:1080',
      'image/jpeg:720',
    ]);
    expect(vid?.type === 'video' && [vid.duration_ms, vid.media.variants.map((v) => v.w)]).toEqual([
      9000,
      [1080, 720],
    ]);
    expect(prod).toMatchObject({ type: 'product', product_skus: ['SKU1'] });
    expect(res.mediaAssetIds.sort()).toEqual([uuid(1), uuid(2), uuid(3)]);
    expect(res.files.length).toBe(1 + 4 + 3);
  });

  it('перечисляет все проблемы неготовой группы', () => {
    const res = buildFeedGroup(
      {
        id: uuid(51),
        title: 'Т',
        coverAssetId: null,
        slides: [
          slide(1, 'image', uuid(4)),
          slide(2, 'image', uuid(5)),
          slide(3, 'image', uuid(6)),
          slide(4, 'video', uuid(7)),
          slide(5, 'image', uuid(3)),
          slide(6, 'image', null),
          slide(7, 'product', null),
          slide(8, 'image', uuid(2), { elements: [{ kind: 'html', html: '<b>' }] }),
          slide(9, 'image', uuid(8)),
        ],
      },
      assets,
      1,
      url,
    );
    expect(res.group).toBeNull();
    expect(res.problems).toEqual([
      'Обложка: не выбрано медиа',
      'Слайд 1: файл ещё обрабатывается',
      'Слайд 2: файл отклонён проверкой',
      'Слайд 3: повреждены данные медиа',
      'Слайд 4: неполные данные видео',
      'Слайд 5: медиа не найдено',
      'Слайд 6: не выбрано медиа',
      'Слайд 7: не выбраны товары',
      'Слайд 8: некорректные текст или CTA',
      'Слайд 9: нет вариантов изображения (загружено как обложка?)',
    ]);
  });

  it('обложка без варианта 256×256 и пустая группа', () => {
    const res = buildFeedGroup(
      { id: uuid(52), title: 'Т', coverAssetId: uuid(2), slides: [] },
      assets,
      1,
      url,
    );
    expect(res.problems).toEqual([
      'Обложка: загрузите изображение как обложку (нужен вариант 256×256)',
      'В группе нет слайдов',
    ]);
  });

  it('превью без обложки берёт первый слайд-картинку', () => {
    const res = buildFeedGroup(
      { id: uuid(53), title: 'Т', coverAssetId: null, slides: [slide(1, 'image', uuid(2))] },
      assets,
      1,
      url,
      {
        coverFallback: true,
      },
    );
    expect(res.group?.cover.url).toBe('https://cdn.test/i/720.jpg');
  });

  it('невалидный итог (например, пустая ссылка) не проходит контракт ленты', () => {
    const res = buildFeedGroup(
      { id: uuid(54), title: 'Т', coverAssetId: uuid(1), slides: [slide(1, 'image', uuid(2))] },
      assets,
      1,
      () => '',
    );
    expect(res.group).toBeNull();
    expect(res.problems).toContain('Группа не соответствует контракту ленты');
  });
});
