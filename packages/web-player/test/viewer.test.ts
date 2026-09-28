import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openViewer, type PlayerOptions } from '../src/index.js';
import {
  baseOptions,
  click,
  currentTitle,
  expectValidEvents,
  gid,
  group,
  imageSlide,
  key,
  loadMedia,
  makeFeed,
  mockStageWidth,
  names,
  ofType,
  pointer,
  stage,
  swipe,
  tap,
  videoSlide,
  viewerRoot,
} from './helpers.js';

let handle: { close(): void } | null = null;

function open(feed = makeFeed(2, 3), index = 0, extra: Partial<PlayerOptions> = {}) {
  const { options, events } = baseOptions(extra);
  handle = openViewer(feed, index, options);
  mockStageWidth(300);
  return events;
}

const isOpen = () => document.querySelector('.idbs-viewer') !== null;
const isPaused = () => viewerRoot().classList.contains('idbs-viewer--paused');

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  handle?.close();
  handle = null;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('оверлей и доступность', () => {
  it('открывает модальный диалог с заголовком группы и кнопкой закрытия', () => {
    open();
    const root = viewerRoot();
    expect(root.getAttribute('role')).toBe('dialog');
    expect(root.getAttribute('aria-modal')).toBe('true');
    expect(root.getAttribute('aria-label')).toBe('Группа 1');
    expect(root.querySelectorAll('.idbs-progress__seg')).toHaveLength(3);
    expect(root.querySelector('.idbs-progress')!.getAttribute('aria-live')).toBe('off');
    expect(root.querySelector('button[aria-label="Закрыть"]')).not.toBeNull();
    expect(document.documentElement.classList.contains('idbs-scroll-lock')).toBe(true);
    expect(currentTitle()).toBe('Слайд 1.1');
    // Текст слайда доступен скринридеру как обычный текст внутри диалога.
    expect(root.querySelector('.idbs-slide')!.getAttribute('aria-label')).toBe('Слайд 1 из 3');
  });

  it('кнопка «Закрыть» закрывает плеер, снимает блокировку прокрутки и возвращает фокус', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const events = open();
    expect(document.activeElement).toBe(viewerRoot());
    click(viewerRoot().querySelector('button[aria-label="Закрыть"]'));
    expect(isOpen()).toBe(false);
    expect(document.documentElement.classList.contains('idbs-scroll-lock')).toBe(false);
    expect(document.activeElement).toBe(opener);
    const close = ofType(events, 'story_close');
    expect(close).toHaveLength(1);
    expect(close[0]!.reason).toBe('button');
    expectValidEvents(events);
  });

  it('Tab не выпускает фокус из модального диалога', () => {
    open(
      makeFeed([
        group(1, [
          imageSlide(1, 1, { cta: { type: 'category', value: 'cat_1', label: 'Смотреть' } }),
        ]),
      ]),
    );
    const root = viewerRoot();
    const focusables = [...root.querySelectorAll<HTMLElement>('button')].filter(
      (b) => !b.hidden && b.closest('[hidden]') === null,
    );
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    expect(first.getAttribute('aria-label')).toBe('Пауза');
    last.focus();
    key('Tab', last);
    expect(document.activeElement).toBe(first);
    // Shift+Tab с самого диалога (фокус после открытия) уходит на последнюю кнопку, а не наружу.
    root.focus();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(last);
  });

  it('открывается на группе по индексу ленты', () => {
    open(makeFeed(3, 1), 2);
    expect(viewerRoot().getAttribute('aria-label')).toBe('Группа 3');
  });
});

describe('навигация тапами', () => {
  it('правая треть — следующий слайд, левая — предыдущий', () => {
    open();
    tap(250);
    expect(currentTitle()).toBe('Слайд 1.2');
    tap(250);
    expect(currentTitle()).toBe('Слайд 1.3');
    tap(50);
    expect(currentTitle()).toBe('Слайд 1.2');
  });

  it('тап влево на первом слайде первой группы оставляет на месте', () => {
    open();
    tap(20);
    expect(currentTitle()).toBe('Слайд 1.1');
    expect(isOpen()).toBe(true);
  });

  it('после последнего слайда группы — следующая группа, после последней группы — закрытие', () => {
    const events = open(makeFeed(2, 1));
    tap(250);
    expect(viewerRoot().getAttribute('aria-label')).toBe('Группа 2');
    tap(250);
    expect(isOpen()).toBe(false);
    const close = ofType(events, 'story_close');
    expect(close.map((e) => [e.group_id, e.reason])).toEqual([[gid(2), 'end']]);
  });

  it('тап влево на первом слайде группы — предыдущая группа', () => {
    open(makeFeed(2, 2), 1);
    tap(20);
    expect(viewerRoot().getAttribute('aria-label')).toBe('Группа 1');
  });

  it('тап по кнопке не переключает слайд', () => {
    open(
      makeFeed([
        group(1, [
          imageSlide(1, 1, { cta: { type: 'category', value: 'cat_1', label: 'Смотреть' } }),
          imageSlide(1, 2),
        ]),
      ]),
    );
    const cta = viewerRoot().querySelector('.idbs-cta')!;
    cta.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientX: 250, clientY: 200, pointerId: 99 }),
    );
    cta.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, clientX: 250, clientY: 200, pointerId: 99 }),
    );
    expect(currentTitle()).toBe('Слайд 1.1');
  });
});

describe('жесты', () => {
  it('удержание > 200 мс ставит на паузу, отпускание — снимает без перехода', () => {
    open();
    loadMedia();
    vi.advanceTimersByTime(0);
    pointer('pointerdown', 250, 200, 7);
    vi.advanceTimersByTime(250);
    expect(isPaused()).toBe(true);
    vi.advanceTimersByTime(20_000);
    expect(currentTitle()).toBe('Слайд 1.1');
    pointer('pointerup', 250, 200, 7);
    expect(isPaused()).toBe(false);
    expect(currentTitle()).toBe('Слайд 1.1');
  });

  it('свайп вниз закрывает плеер (reason swipe)', () => {
    const events = open();
    swipe(0, 150);
    expect(isOpen()).toBe(false);
    expect(ofType(events, 'story_close')[0]!.reason).toBe('swipe');
  });

  it('свайп влево — следующая группа, вправо — предыдущая', () => {
    const events = open(makeFeed(3, 2));
    swipe(-120, 5);
    expect(viewerRoot().getAttribute('aria-label')).toBe('Группа 2');
    swipe(120, 5);
    expect(viewerRoot().getAttribute('aria-label')).toBe('Группа 1');
    const opens = ofType(events, 'story_group_open');
    expect(opens.map((e) => e.source)).toEqual(['tap', 'swipe', 'swipe']);
  });
});

describe('клавиатура', () => {
  it('стрелки листают, пробел ставит на паузу, Escape закрывает', () => {
    const events = open();
    key('ArrowRight');
    expect(currentTitle()).toBe('Слайд 1.2');
    key('ArrowLeft');
    expect(currentTitle()).toBe('Слайд 1.1');
    key(' ');
    expect(isPaused()).toBe(true);
    expect(viewerRoot().querySelector('.idbs-btn--pause')!.getAttribute('aria-label')).toBe(
      'Воспроизвести',
    );
    key(' ');
    expect(isPaused()).toBe(false);
    key('Escape');
    expect(isOpen()).toBe(false);
    expect(ofType(events, 'story_close')[0]!.reason).toBe('button');
  });
});

describe('автопереход', () => {
  it('переключает слайды по duration_ms, затем группы, затем закрывается', () => {
    const events = open(makeFeed(2, 2));
    loadMedia();
    vi.advanceTimersByTime(4999);
    expect(currentTitle()).toBe('Слайд 1.1');
    vi.advanceTimersByTime(1);
    expect(currentTitle()).toBe('Слайд 1.2');
    loadMedia();
    vi.advanceTimersByTime(5000);
    expect(viewerRoot().getAttribute('aria-label')).toBe('Группа 2');
    expect(currentTitle()).toBe('Слайд 2.1');
    loadMedia();
    vi.advanceTimersByTime(5000);
    loadMedia();
    vi.advanceTimersByTime(5000);
    expect(isOpen()).toBe(false);
    expect(names(events)).toEqual([
      'story_group_open',
      'story_slide_view',
      'story_slide_complete',
      'story_slide_view',
      'story_slide_complete',
      'story_group_open',
      'story_slide_view',
      'story_slide_complete',
      'story_slide_view',
      'story_slide_complete',
      'story_close',
    ]);
    const opens = ofType(events, 'story_group_open');
    expect(opens.map((e) => e.source)).toEqual(['tap', 'auto']);
    const close = ofType(events, 'story_close')[0]!;
    expect(close).toMatchObject({ reason: 'end', group_id: gid(2), watched_slides: 2 });
    expectValidEvents(events);
  });

  it('пока картинка не загрузилась, таймер стоит', () => {
    open();
    vi.advanceTimersByTime(30_000);
    expect(currentTitle()).toBe('Слайд 1.1');
    expect(viewerRoot().classList.contains('idbs-viewer--loading')).toBe(true);
    loadMedia();
    vi.advanceTimersByTime(5000);
    expect(currentTitle()).toBe('Слайд 1.2');
  });

  it('пауза пробелом останавливает таймер, остаток дотикивает после снятия', () => {
    open();
    loadMedia();
    vi.advanceTimersByTime(3000);
    key(' ');
    vi.advanceTimersByTime(10_000);
    expect(currentTitle()).toBe('Слайд 1.1');
    key(' ');
    vi.advanceTimersByTime(1999);
    expect(currentTitle()).toBe('Слайд 1.1');
    vi.advanceTimersByTime(1);
    expect(currentTitle()).toBe('Слайд 1.2');
  });

  it('при скрытой вкладке таймер стоит', () => {
    open();
    loadMedia();
    vi.advanceTimersByTime(1000);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(20_000);
    expect(currentTitle()).toBe('Слайд 1.1');
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(4000);
    expect(currentTitle()).toBe('Слайд 1.2');
  });

  it('prefers-reduced-motion: старт на паузе, без автоперехода, переход тапом', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('reduce'),
      media: q,
      addEventListener() {},
      removeEventListener() {},
    }));
    const events = open();
    loadMedia();
    vi.advanceTimersByTime(60_000);
    expect(currentTitle()).toBe('Слайд 1.1');
    expect(isPaused()).toBe(true);
    // Слайд всё равно считается показанным.
    expect(ofType(events, 'story_slide_view')).toHaveLength(1);
    tap(250);
    expect(currentTitle()).toBe('Слайд 1.2');
    expect(isPaused()).toBe(true);
  });
});

describe('видео', () => {
  function videoFeed() {
    return makeFeed([group(1, [videoSlide(1, 1), imageSlide(1, 2)])]);
  }
  const video = () => viewerRoot().querySelector<HTMLVideoElement>('.idbs-media video')!;

  it('видео без звука, inline, с постером; переход по ended', () => {
    const events = open(videoFeed());
    const v = video();
    expect(v.muted).toBe(true);
    expect(v.hasAttribute('playsinline')).toBe(true);
    expect(v.getAttribute('poster')).toBe('https://cdn.stories.example/g1s1-poster.webp');
    expect(viewerRoot().querySelector<HTMLElement>('.idbs-btn--mute')!.hidden).toBe(false);
    loadMedia();
    vi.advanceTimersByTime(3000);
    v.dispatchEvent(new Event('ended'));
    expect(currentTitle()).toBe('Слайд 1.2');
    expect(ofType(events, 'story_slide_complete')).toHaveLength(1);
  });

  it('пока видео буферизуется (waiting/stalled), таймер стоит', () => {
    open(videoFeed());
    loadMedia();
    vi.advanceTimersByTime(0);
    const v = video();
    v.dispatchEvent(new Event('waiting'));
    expect(viewerRoot().classList.contains('idbs-viewer--loading')).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(currentTitle()).toBe('');
    expect(viewerRoot().querySelector('.idbs-slide--video')).not.toBeNull();
    v.dispatchEvent(new Event('playing'));
    v.dispatchEvent(new Event('stalled'));
    vi.advanceTimersByTime(60_000);
    expect(viewerRoot().querySelector('.idbs-slide--video')).not.toBeNull();
    v.dispatchEvent(new Event('playing'));
    // Страховочный таймер (duration_ms + запас) всё-таки переключит зависшее видео.
    vi.advanceTimersByTime(10_000);
    expect(currentTitle()).toBe('Слайд 1.2');
  });

  it('ошибка загрузки медиа — story_media_error load_failed и переход дальше', () => {
    const events = open(videoFeed());
    video().dispatchEvent(new Event('error'));
    vi.advanceTimersByTime(0);
    expect(currentTitle()).toBe('Слайд 1.2');
    const err = ofType(events, 'story_media_error');
    expect(err).toHaveLength(1);
    expect(err[0]).toMatchObject({
      error_code: 'load_failed',
      slide_type: 'video',
      slide_index: 0,
    });
    expectValidEvents(events);
  });

  it('ошибка загрузки картинки тоже пропускает слайд', () => {
    const events = open(makeFeed(1, 2));
    viewerRoot().querySelector('.idbs-media img')!.dispatchEvent(new Event('error'));
    vi.advanceTimersByTime(0);
    expect(currentTitle()).toBe('Слайд 1.2');
    expect(ofType(events, 'story_media_error')[0]!.error_code).toBe('load_failed');
  });
});

describe('выбор варианта медиа и предзагрузка', () => {
  it('берёт самый узкий WebP с шириной ≥ ширины контейнера × DPR', () => {
    const feed = makeFeed(1, 2);
    const { options } = baseOptions();
    const root = document.createElement('div');
    document.body.appendChild(root);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(360);
    vi.stubGlobal('devicePixelRatio', 2);
    handle = openViewer(feed, 0, { ...options, container: root });
    const img = viewerRoot().querySelector<HTMLImageElement>('.idbs-media img')!;
    expect(img.getAttribute('src')).toBe('https://cdn.stories.example/g1s1-720.webp');
  });

  it('если ни один вариант не достаёт до нужной ширины — самый широкий', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
    vi.stubGlobal('devicePixelRatio', 3);
    open(makeFeed(1, 1));
    const img = viewerRoot().querySelector<HTMLImageElement>('.idbs-media img')!;
    expect(img.getAttribute('src')).toBe('https://cdn.stories.example/g1s1-1080.webp');
  });

  it('предзагружает следующий слайд и обложку следующей группы', () => {
    const created: string[] = [];
    const origSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
    vi.spyOn(HTMLImageElement.prototype, 'src', 'set').mockImplementation(function (
      this: HTMLImageElement,
      v: string,
    ) {
      created.push(v);
      origSrc.set!.call(this, v);
    });
    open(makeFeed(2, 2));
    expect(created).toContain('https://cdn.stories.example/g1s2-1080.webp');
    expect(created).toContain('https://cdn.stories.example/cover-2.webp');
    // Предзагруженный элемент переиспользуется при показе.
    tap(250);
    expect(
      viewerRoot().querySelector<HTMLImageElement>('.idbs-media img')!.getAttribute('src'),
    ).toBe('https://cdn.stories.example/g1s2-1080.webp');
  });
});

describe('стартовые проверки', () => {
  it('пустая лента — плеер не открывается', () => {
    handle = openViewer(makeFeed([]), 0, baseOptions().options);
    expect(isOpen()).toBe(false);
    expect(() => handle!.close()).not.toThrow();
  });

  it('close() идемпотентен', () => {
    const events = open();
    handle!.close();
    handle!.close();
    expect(ofType(events, 'story_close')).toHaveLength(1);
    expect(stage).toBeTypeOf('function');
  });
});
