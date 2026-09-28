import type { FeedResponse } from '@idb-stories/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountPreview, type PreviewOptions } from '../src/index.js';
import {
  baseOptions,
  click,
  currentTitle,
  gid,
  group,
  imageSlide,
  key,
  loadMedia,
  makeFeed,
  MemoryStorage,
  mockStageWidth,
  ofType,
  tap,
  viewerRoot,
} from './helpers.js';

let container: HTMLElement;
let handle: { destroy(): void } | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  handle?.destroy();
  handle = null;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mount(feed: FeedResponse = makeFeed(3, 2), extra: Partial<PreviewOptions> = {}) {
  const { options, events } = baseOptions(extra);
  const preview = mountPreview(container, feed, { ...options, ...extra });
  handle = preview;
  if (container.querySelector('.idbs-viewer')) mockStageWidth(300);
  return { preview, events };
}

describe('mountPreview', () => {
  it('плеер встраивается в контейнер без оверлея и без блокировки прокрутки', () => {
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    outside.focus();
    mount();
    const root = container.querySelector('.idbs-viewer')!;
    expect(root.classList.contains('idbs-viewer--inline')).toBe(true);
    expect(root.classList.contains('idbs-viewer--overlay')).toBe(false);
    expect(root.hasAttribute('aria-modal')).toBe(false);
    expect(root.getAttribute('aria-label')).toBe('Группа 1');
    expect(document.documentElement.classList.contains('idbs-scroll-lock')).toBe(false);
    // Предпросмотр не отбирает фокус у формы редактора.
    expect(document.activeElement).toBe(outside);
  });

  it('клавиши обрабатываются только когда фокус внутри предпросмотра', () => {
    mount();
    key('ArrowRight', document);
    expect(currentTitle()).toBe('Слайд 1.1');
    key('ArrowRight', viewerRoot());
    expect(currentTitle()).toBe('Слайд 1.2');
  });

  it('startGroup — индекс группы в ленте', () => {
    mount(makeFeed(3, 1), { startGroup: 2 });
    expect(viewerRoot().getAttribute('aria-label')).toBe('Группа 3');
  });

  it('закрытие показывает «Смотреть снова», повтор начинает сначала', () => {
    const { events } = mount(makeFeed(2, 1));
    click(viewerRoot().querySelector('button[aria-label="Закрыть"]'));
    const end = container.querySelector<HTMLElement>('.idbs-end')!;
    expect(end.hidden).toBe(false);
    expect(end.textContent).toContain('Просмотр завершён');
    expect(ofType(events, 'story_close')[0]!.reason).toBe('button');
    click(end.querySelector('.idbs-end__replay'));
    expect(end.hidden).toBe(true);
    expect(viewerRoot().getAttribute('aria-label')).toBe('Группа 1');
    expect(currentTitle()).toBe('Слайд 1.1');
  });

  it('после последней группы — экран окончания, а не удаление плеера', () => {
    mount(makeFeed(1, 1));
    tap(250);
    expect(container.querySelector('.idbs-viewer')).not.toBeNull();
    expect(container.querySelector<HTMLElement>('.idbs-end')!.hidden).toBe(false);
  });

  it('update() сохраняет текущую группу и слайд и перерисовывает контент', () => {
    const { preview, events } = mount(makeFeed(3, 2), { startGroup: 1 });
    tap(250);
    expect(currentTitle()).toBe('Слайд 2.2');
    const next = makeFeed(3, 2);
    const g2 = next.groups[1] as unknown as {
      title: string;
      slides: { elements: { text: string }[] }[];
    };
    g2.title = 'Новое название';
    g2.slides[1]!.elements[0]!.text = 'Обновлённый текст';
    preview.update(next);
    expect(viewerRoot().getAttribute('aria-label')).toBe('Новое название');
    expect(currentTitle()).toBe('Обновлённый текст');
    // Группа та же — повторного story_group_open нет.
    expect(ofType(events, 'story_group_open')).toHaveLength(1);
  });

  it('update() без текущей группы — ближайшая доступная', () => {
    const { preview } = mount(makeFeed(3, 1), { startGroup: 2 });
    preview.update(makeFeed([group(1, [imageSlide(1, 1)]), group(2, [imageSlide(2, 1)])]));
    expect(viewerRoot().getAttribute('aria-label')).toBe('Группа 2');
  });

  it('update() с неподдерживаемой версией или пустой лентой — сообщение, затем восстановление', () => {
    const { preview } = mount();
    preview.update(makeFeed(1, 1, { schema_version: 99 }));
    expect(container.querySelector('.idbs-viewer')).toBeNull();
    expect(container.textContent).toContain('не поддерживается');
    preview.update(makeFeed([]));
    expect(container.textContent).toBe('Нет слайдов для предпросмотра');
    preview.update(makeFeed(1, 1));
    expect(container.querySelector('.idbs-viewer')).not.toBeNull();
    expect(container.querySelector('.idbs-preview-empty')).toBeNull();
  });

  it('autoplay: false — без автоперехода', () => {
    mount(makeFeed(1, 2), { autoplay: false });
    loadMedia();
    vi.advanceTimersByTime(30_000);
    expect(currentTitle()).toBe('Слайд 1.1');
    expect(viewerRoot().classList.contains('idbs-viewer--paused')).toBe(true);
  });

  it('autoplay по умолчанию — слайды переключаются сами', () => {
    mount(makeFeed(1, 2));
    loadMedia();
    vi.advanceTimersByTime(5000);
    expect(currentTitle()).toBe('Слайд 1.2');
  });

  it('предпросмотр не помечает группы просмотренными', () => {
    const storage = new MemoryStorage();
    mount(makeFeed(1, 1), { storage });
    expect(storage.length).toBe(0);
    expect(gid(1)).toBeTruthy();
  });

  it('destroy() убирает плеер из контейнера', () => {
    const { preview } = mount();
    preview.destroy();
    expect(container.childElementCount).toBe(0);
    expect(() => preview.update(makeFeed(1, 1))).not.toThrow();
    expect(container.childElementCount).toBe(0);
  });
});
