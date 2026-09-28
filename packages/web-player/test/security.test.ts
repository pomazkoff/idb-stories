import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openViewer, type PlayerOptions } from '../src/index.js';
import {
  baseOptions,
  CDN,
  click,
  currentTexts,
  expectValidEvents,
  gid,
  group,
  imageSlide,
  makeFeed,
  mockStageWidth,
  ofType,
  sid,
  videoSlide,
  viewerRoot,
} from './helpers.js';

const XSS = ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>'];

let handle: { close(): void } | null = null;
let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  assign = vi.fn();
  vi.spyOn(window.location, 'assign').mockImplementation(assign);
});

afterEach(() => {
  handle?.close();
  handle = null;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function open(feed: ReturnType<typeof makeFeed>, extra: Partial<PlayerOptions> = {}) {
  const { options, events } = baseOptions(extra);
  handle = openViewer(feed, 0, options);
  if (document.querySelector('.idbs-viewer')) mockStageWidth(300);
  return events;
}

function ctaFeed(type: string, value: string) {
  return makeFeed([group(1, [imageSlide(1, 1, { cta: { type, value, label: 'Перейти' } })])]);
}

describe('T3: текст только как plain text', () => {
  it('HTML в тексте, заголовке группы и подписи CTA выводится буквально', () => {
    const feed = makeFeed([
      group(
        1,
        [
          imageSlide(1, 1, {
            elements: XSS.map((text) => ({
              kind: 'text',
              text,
              style: 'body',
              position: 'center',
            })),
            cta: { type: 'category', value: 'cat_1', label: XSS[1] },
          }),
        ],
        { title: XSS[0] },
      ),
    ]);
    open(feed);
    const root = viewerRoot();
    expect(currentTexts()).toEqual(XSS);
    expect(root.querySelector('.idbs-cta')!.textContent).toBe(XSS[1]);
    expect(root.querySelector('.idbs-header__title')!.textContent).toBe(XSS[0]);
    expect(root.getAttribute('aria-label')).toBe(XSS[0]);
    // Никаких элементов из текста не создано.
    expect(document.querySelectorAll('script')).toHaveLength(0);
    const imgs = [...root.querySelectorAll('img')];
    expect(imgs.every((i) => (i.getAttribute('src') ?? '').startsWith(CDN) || i.hidden)).toBe(true);
    expect(root.querySelectorAll('[onerror]')).toHaveLength(0);
    for (const p of root.querySelectorAll('.idbs-text')) expect(p.children).toHaveLength(0);
  });
});

describe('медиа только с разрешённых origin', () => {
  it('слайд с медиа с чужого origin пропускается и даёт story_media_error forbidden_origin', () => {
    const evil = imageSlide(1, 1, {
      media: {
        variants: [{ url: 'https://evil.example/x.webp', w: 720, h: 1280, mime: 'image/webp' }],
      },
    });
    const events = open(makeFeed([group(1, [evil, imageSlide(1, 2)])]));
    const root = viewerRoot();
    expect(root.querySelectorAll('.idbs-progress__seg')).toHaveLength(1);
    expect(currentTexts()).toEqual(['Слайд 1.2']);
    expect(document.querySelector('img[src*="evil.example"]')).toBeNull();
    const err = ofType(events, 'story_media_error');
    expect(err).toHaveLength(1);
    expect(err[0]).toMatchObject({
      error_code: 'forbidden_origin',
      group_id: gid(1),
      slide_id: sid(1, 1),
      slide_index: 0,
      slide_type: 'image',
    });
    expectValidEvents(events);
  });

  it('javascript:, data: и http-подмена origin не проходят', () => {
    const variants = [
      { url: 'javascript:alert(1)', w: 720, h: 1280, mime: 'image/webp' },
      { url: 'data:image/webp;base64,AAAA', w: 720, h: 1280, mime: 'image/webp' },
      { url: 'http://cdn.stories.example/x.webp', w: 720, h: 1280, mime: 'image/webp' },
      { url: 'https://cdn.stories.example.evil.com/x.webp', w: 720, h: 1280, mime: 'image/webp' },
      { url: 'https://user:pass@cdn.stories.example/x.webp', w: 720, h: 1280, mime: 'image/webp' },
    ];
    open(makeFeed([group(1, [imageSlide(1, 1, { media: { variants } })])]));
    expect(document.querySelector('.idbs-viewer')).toBeNull();
  });

  it('разрешённые варианты используются, чужие игнорируются; чужой постер и обложка не грузятся', () => {
    const feed = makeFeed([
      group(
        1,
        [
          videoSlide(1, 1, {
            media: {
              poster: { url: 'https://evil.example/poster.webp', w: 1, h: 1 },
              variants: [
                {
                  url: 'https://evil.example/v.mp4',
                  w: 1080,
                  h: 1920,
                  mime: 'video/mp4',
                  bitrate_kbps: 1,
                },
                { url: `${CDN}/v.mp4`, w: 720, h: 1280, mime: 'video/mp4', bitrate_kbps: 1 },
              ],
            },
          }),
        ],
        { cover: { url: 'https://evil.example/cover.webp', w: 1, h: 1 } },
      ),
    ]);
    const events = open(feed);
    const video = viewerRoot().querySelector('video')!;
    expect(video.getAttribute('src')).toBe(`${CDN}/v.mp4`);
    expect(video.hasAttribute('poster')).toBe(false);
    const avatar = viewerRoot().querySelector<HTMLImageElement>('.idbs-header__avatar')!;
    expect(avatar.hidden).toBe(true);
    expect(avatar.hasAttribute('src')).toBe(false);
    expect(ofType(events, 'story_media_error')).toHaveLength(0);
  });

  it('mediaOrigins нормализуются (слэш на конце не мешает)', () => {
    open(makeFeed(1, 1), { mediaOrigins: [`${CDN}/`] });
    expect(document.querySelector('.idbs-viewer')).not.toBeNull();
  });
});

describe('T4: CTA повторно проверяется по allowlist', () => {
  it.each([
    ['url', 'javascript:alert(1)'],
    ['url', 'JaVaScRiPt:alert(document.cookie)'],
    ['url', 'https://evil.com/phishing'],
    ['url', 'https://iledebeaute.ru.evil.com/'],
    ['url', 'http://iledebeaute.ru/'],
    ['url', 'data:text/html;base64,PHNjcmlwdD4='],
    ['deeplink', 'javascript:alert(1)'],
    ['deeplink', 'intent://scan/#Intent;scheme=zxing;end'],
    ['deeplink', 'otherapp://open'],
    ['product', '../../admin'],
  ])('%s %s — перехода нет, события нет', (type, value) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onCta = vi.fn();
    const events = open(ctaFeed(type, value), { onCta });
    click(viewerRoot().querySelector('.idbs-cta'));
    expect(assign).not.toHaveBeenCalled();
    expect(onCta).not.toHaveBeenCalled();
    expect(ofType(events, 'story_cta_click')).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  it('url: переход через location.assign с добавленным story_ref', () => {
    const events = open(ctaFeed('url', 'https://www.iledebeaute.ru/promo?utm=stories'));
    click(viewerRoot().querySelector('.idbs-cta'));
    expect(assign).toHaveBeenCalledTimes(1);
    const href = new URL(assign.mock.calls[0]![0] as string);
    expect(href.origin).toBe('https://www.iledebeaute.ru');
    expect(href.searchParams.get('utm')).toBe('stories');
    expect(href.searchParams.get('story_ref')).toBe(`${gid(1)}:${sid(1, 1)}`);
    const click0 = ofType(events, 'story_cta_click');
    expect(click0).toHaveLength(1);
    expect(click0[0]).toMatchObject({
      cta_type: 'url',
      cta_value: 'https://www.iledebeaute.ru/promo?utm=stories',
      slide_id: sid(1, 1),
    });
    expectValidEvents(events);
  });

  it('deeplink: story_ref добавляется, существующий story_ref перезаписывается', () => {
    open(ctaFeed('deeplink', 'idb://product/123?story_ref=forged'));
    click(viewerRoot().querySelector('.idbs-cta'));
    expect(assign).toHaveBeenCalledWith(`idb://product/123?story_ref=${gid(1)}%3A${sid(1, 1)}`);
  });

  it('onCta хоста получает href, storyRef и отменяет навигацию по умолчанию', () => {
    const onCta = vi.fn();
    open(ctaFeed('url', 'https://iledebeaute.ru/sale'), { onCta });
    click(viewerRoot().querySelector('.idbs-cta'));
    expect(assign).not.toHaveBeenCalled();
    expect(onCta).toHaveBeenCalledWith({
      type: 'url',
      value: 'https://iledebeaute.ru/sale',
      href: `https://iledebeaute.ru/sale?story_ref=${gid(1)}%3A${sid(1, 1)}`,
      storyRef: `${gid(1)}:${sid(1, 1)}`,
    });
  });

  it('product и category: href = null, переход делает хост через onCta', () => {
    const onCta = vi.fn();
    const events = open(ctaFeed('category', 'cat_123'), { onCta });
    click(viewerRoot().querySelector('.idbs-cta'));
    expect(onCta).toHaveBeenCalledWith({
      type: 'category',
      value: 'cat_123',
      href: null,
      storyRef: `${gid(1)}:${sid(1, 1)}`,
    });
    expect(ofType(events, 'story_cta_click')[0]).toMatchObject({
      cta_type: 'category',
      cta_value: 'cat_123',
    });
    expect(assign).not.toHaveBeenCalled();
  });

  it('без onCta product/category никуда не переходят', () => {
    open(ctaFeed('product', 'SKU001'));
    click(viewerRoot().querySelector('.idbs-cta'));
    expect(assign).not.toHaveBeenCalled();
  });

  it('ошибка в onCta хоста не ломает плеер', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    open(ctaFeed('category', 'cat_1'), {
      onCta: () => {
        throw new Error('boom');
      },
    });
    expect(() => click(viewerRoot().querySelector('.idbs-cta'))).not.toThrow();
    expect(error).toHaveBeenCalled();
  });
});
