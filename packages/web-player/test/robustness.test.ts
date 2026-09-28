import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openViewer, SUPPORTED_SCHEMA_VERSION } from '../src/index.js';
import {
  baseOptions,
  currentTexts,
  currentTitle,
  expectValidEvents,
  gid,
  group,
  imageSlide,
  loadMedia,
  makeFeed,
  mockStageWidth,
  ofType,
  sid,
  tap,
  viewerRoot,
} from './helpers.js';

let handle: { close(): void } | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  handle?.close();
  handle = null;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function open(feed: ReturnType<typeof makeFeed>, index = 0) {
  const { options, events } = baseOptions();
  handle = openViewer(feed, index, options);
  if (document.querySelector('.idbs-viewer')) mockStageWidth(300);
  return events;
}

describe('совместимость контракта (раздел 8)', () => {
  it('SUPPORTED_SCHEMA_VERSION = 1', () => {
    expect(SUPPORTED_SCHEMA_VERSION).toBe(1);
  });

  it('неизвестный type слайда пропускается молча', () => {
    const feed = makeFeed([
      group(1, [
        imageSlide(1, 1),
        {
          id: sid(1, 2),
          type: 'poll',
          duration_ms: 5000,
          question: 'Да?',
          elements: [],
          cta: null,
        },
        imageSlide(1, 3),
      ]),
    ]);
    const events = open(feed);
    expect(viewerRoot().querySelectorAll('.idbs-progress__seg')).toHaveLength(2);
    tap(250);
    expect(currentTitle()).toBe('Слайд 1.3');
    expect(ofType(events, 'story_media_error')).toHaveLength(0);
  });

  it('slide_index в событиях — позиция в исходной ленте, даже если перед слайдом был пропущенный', () => {
    const feed = makeFeed([
      group(1, [{ id: sid(1, 1), type: 'quiz', elements: [], cta: null }, imageSlide(1, 2)]),
    ]);
    const events = open(feed);
    loadMedia();
    vi.advanceTimersByTime(1000);
    const view = ofType(events, 'story_slide_view');
    expect(view).toHaveLength(1);
    expect(view[0]).toMatchObject({ slide_id: sid(1, 2), slide_index: 1, slide_type: 'image' });
    expectValidEvents(events);
  });

  it('неизвестный kind элемента пропускается, остальные элементы показываются', () => {
    const feed = makeFeed([
      group(1, [
        imageSlide(1, 1, {
          elements: [
            { kind: 'sticker', emoji: '🔥', position: 'top' },
            { kind: 'text', text: 'Текст', style: 'body', position: 'center' },
            { kind: 'text', text: 'Подпись', style: 'unknown-style', position: 'nowhere' },
            { kind: 'poll', text: 'Опрос?' },
          ],
        }),
      ]),
    ]);
    open(feed);
    expect(currentTexts()).toEqual(['Текст', 'Подпись']);
    const caption = viewerRoot().querySelector('.idbs-layer--bottom .idbs-text')!;
    expect(caption.className).toBe('idbs-text idbs-text--body');
  });

  it('группа без отображаемых слайдов пропускается целиком', () => {
    const feed = makeFeed([
      group(1, [{ id: sid(1, 1), type: 'ar-effect', elements: [], cta: null }]),
      group(2, [imageSlide(2, 1)]),
    ]);
    const events = open(feed, 0);
    expect(viewerRoot().getAttribute('aria-label')).toBe('Группа 2');
    expect(ofType(events, 'story_group_open')[0]!.group_id).toBe(gid(2));
  });

  it('некорректные группы и слайды отбрасываются, неизвестные поля игнорируются', () => {
    const feed = makeFeed([
      { title: 'Без id', slides: [imageSlide(9, 1)] },
      'мусор',
      null,
      group(1, [null, 42, { type: 'image' }, imageSlide(1, 2, { new_field: { x: 1 } })], {
        badge: 'new',
      }),
    ]);
    open(feed);
    expect(viewerRoot().getAttribute('aria-label')).toBe('Группа 1');
    expect(currentTitle()).toBe('Слайд 1.2');
  });

  it('schema_version выше поддерживаемой — плеер не открывается', () => {
    open(makeFeed(1, 1, { schema_version: SUPPORTED_SCHEMA_VERSION + 1 }));
    expect(document.querySelector('.idbs-viewer')).toBeNull();
  });

  it('ответ не того формата — плеер не открывается и не бросает исключений', () => {
    for (const bad of [
      null,
      'строка',
      { schema_version: '1', groups: [] },
      { schema_version: 1 },
    ]) {
      expect(() => open(bad as unknown as ReturnType<typeof makeFeed>)).not.toThrow();
      expect(document.querySelector('.idbs-viewer')).toBeNull();
    }
  });

  it('пустой текст и многострочный текст', () => {
    const feed = makeFeed([
      group(1, [
        imageSlide(1, 1, {
          elements: [
            { kind: 'text', text: '   ', style: 'title', position: 'top' },
            { kind: 'text', text: 'Строка 1\nСтрока 2', style: 'body', position: 'bottom' },
          ],
        }),
      ]),
    ]);
    open(feed);
    expect(currentTexts()).toEqual(['Строка 1\nСтрока 2']);
  });
});
