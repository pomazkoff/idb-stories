import { brotliCompressSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { FeedResponse, LIMITS, type FeedGroup } from '@idb-stories/schema';
import { selectFeed, type LiveSnapshot } from '../src/feed/select.js';

/** Раздел 11: ответ /feed < 100 КБ. Худший случай — 20 групп × 10 слайдов с максимальными текстами. */
describe('размер ответа ленты в худшем случае', () => {
  // Реалистичная энтропия: ключи медиа случайные, тексты — разные слова.
  const hex = () => Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const keys = new Map<string, string>();
  const key = (g: number, s: number) => keys.get(`${g}:${s}`) ?? (keys.set(`${g}:${s}`, hex()), keys.get(`${g}:${s}`)!);
  const WORDS = ['аромат', 'сезон', 'уход', 'кожа', 'новинка', 'подарок', 'скидка', 'парфюм', 'сияние', 'помада', 'тон', 'крем'];
  const text = (len: number) => {
    let out = '';
    while (out.length < len) out += `${WORDS[Math.floor(Math.random() * WORDS.length)]} `;
    return out.slice(0, len);
  };
  const cdn = 'https://cdn.stories.iledebeaute.ru';
  const uuid = (n: number) => `7c1e3d9a-${String(n).padStart(4, '0')}-4a2b-8c3d-${String(n).padStart(12, '0')}`;

  const group = (g: number): FeedGroup => ({
    id: uuid(g),
    version: 12,
    title: text(LIMITS.groupTitleMax),
    cover: { url: `${cdn}/${key(g, 99)}/256x256.webp`, w: 256, h: 256 },
    slides: Array.from({ length: LIMITS.slidesPerGroupMax }, (_, s) => ({
      id: uuid(g * 100 + s),
      type: 'image' as const,
      duration_ms: 6000,
      media: {
        variants: (['webp', 'jpg'] as const).flatMap((ext) =>
          (['1080x1920', '720x1280'] as const).map((size) => ({
            url: `${cdn}/${key(g, s)}/${size}.${ext}`,
            w: size === '1080x1920' ? 1080 : 720,
            h: size === '1080x1920' ? 1920 : 1280,
            mime: ext === 'webp' ? ('image/webp' as const) : ('image/jpeg' as const),
          })),
        ),
      },
      elements: Array.from({ length: LIMITS.elementsPerSlideMax }, () => ({
        kind: 'text' as const,
        text: text(LIMITS.textElementMax),
        style: 'body' as const,
        position: 'bottom' as const,
      })),
      cta: { type: 'url' as const, value: `https://iledebeaute.ru/catalog/${hex()}${hex()}`, label: text(LIMITS.ctaLabelMax) },
    })),
  });

  it('сжатый ответ < 100 КБ', () => {
    const now = Date.now();
    const snapshots: LiveSnapshot[] = Array.from({ length: 25 }, (_, g) => ({
      groupId: uuid(g),
      version: 12,
      placement: 'home',
      priority: 0,
      startAt: now - 1000,
      endAt: now + 60_000,
      platforms: ['web'],
      minAppVersionIos: null,
      minAppVersionAndroid: null,
      segmentIds: [],
      payload: group(g),
    }));
    const { groups } = selectFeed(snapshots, { placement: 'home', platform: 'web', appVersion: null, userSegments: null, now });
    const body = JSON.stringify({ schema_version: 1, generated_at: new Date(now).toISOString(), ttl_sec: 60, groups });
    expect(FeedResponse.safeParse(JSON.parse(body)).success).toBe(true);
    const raw = Buffer.byteLength(body);
    const br = brotliCompressSync(body).length;
    const gz = gzipSync(body).length;
    // Для справки в выводе теста: без сжатия худший случай больше 100 КБ, поэтому ответ всегда сжимается.
    console.log(`feed worst case: raw ${(raw / 1024).toFixed(0)} KB, gzip ${(gz / 1024).toFixed(1)} KB, br ${(br / 1024).toFixed(1)} KB`);
    expect(br).toBeLessThan(100 * 1024);
    expect(gz).toBeLessThan(100 * 1024);
  });
});
