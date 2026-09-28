import { StoryEvent, type FeedResponse } from '@idb-stories/schema';
import { expect } from 'vitest';
import type { PlayerOptions } from '../src/index.js';

export const CDN = 'https://cdn.stories.example';
export const ALLOWLIST = { deeplinkSchemes: ['idb'], urlDomains: ['iledebeaute.ru'] };

/** Валидный UUID v4 с номером на конце — удобно читать в тестах. */
export function uid(n: number, prefix = 0): string {
  return `${prefix.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

export const gid = (n: number) => uid(n, 0xa);
export const sid = (g: number, s: number) => uid(g * 100 + s, 0xb);

type AnySlide = Record<string, unknown>;

export function imageSlide(g: number, s: number, extra: AnySlide = {}): AnySlide {
  return {
    id: sid(g, s),
    type: 'image',
    duration_ms: 5000,
    media: {
      variants: [
        { url: `${CDN}/g${g}s${s}-1080.webp`, w: 1080, h: 1920, mime: 'image/webp' },
        { url: `${CDN}/g${g}s${s}-720.webp`, w: 720, h: 1280, mime: 'image/webp' },
        { url: `${CDN}/g${g}s${s}-720.jpg`, w: 720, h: 1280, mime: 'image/jpeg' },
      ],
    },
    elements: [{ kind: 'text', text: `Слайд ${g}.${s}`, style: 'title', position: 'top' }],
    cta: null,
    ...extra,
  };
}

export function videoSlide(g: number, s: number, extra: AnySlide = {}): AnySlide {
  return {
    id: sid(g, s),
    type: 'video',
    duration_ms: 8000,
    media: {
      poster: { url: `${CDN}/g${g}s${s}-poster.webp`, w: 1080, h: 1920 },
      variants: [
        {
          url: `${CDN}/g${g}s${s}-720.mp4`,
          w: 720,
          h: 1280,
          mime: 'video/mp4',
          bitrate_kbps: 1200,
        },
      ],
    },
    elements: [],
    cta: null,
    ...extra,
  };
}

export function productSlide(g: number, s: number, skus: string[], extra: AnySlide = {}): AnySlide {
  return {
    id: sid(g, s),
    type: 'product',
    duration_ms: 8000,
    product_skus: skus,
    elements: [{ kind: 'text', text: 'Выбор редакции', style: 'title', position: 'top' }],
    cta: null,
    ...extra,
  };
}

export function group(g: number, slides: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id: gid(g),
    version: 1,
    title: `Группа ${g}`,
    cover: { url: `${CDN}/cover-${g}.webp`, w: 256, h: 256 },
    slides,
    ...extra,
  };
}

/** Лента из `groups` групп по `slides` картинок в каждой. */
export function makeFeed(
  groups: unknown[] | number = 2,
  slides = 2,
  extra: Record<string, unknown> = {},
): FeedResponse {
  const list =
    typeof groups === 'number'
      ? Array.from({ length: groups }, (_, g) =>
          group(
            g + 1,
            Array.from({ length: slides }, (_, s) => imageSlide(g + 1, s + 1)),
          ),
        )
      : groups;
  return {
    schema_version: 1,
    generated_at: '2026-10-01T09:00:00Z',
    ttl_sec: 60,
    groups: list,
    ...extra,
  } as unknown as FeedResponse;
}

export class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
}

export function baseOptions(overrides: Partial<PlayerOptions> = {}) {
  const events: StoryEvent[] = [];
  const options: PlayerOptions = {
    placement: 'home',
    mediaOrigins: [CDN],
    ctaAllowlist: ALLOWLIST,
    storage: new MemoryStorage(),
    sessionId: 'test-session',
    appVersion: '1.0.0',
    onEvent: (e) => events.push(e),
    ...overrides,
  };
  return { options, events };
}

export const names = (events: StoryEvent[]) => events.map((e) => e.event);

export function ofType<N extends StoryEvent['event']>(events: StoryEvent[], name: N) {
  return events.filter((e): e is Extract<StoryEvent, { event: N }> => e.event === name);
}

/** Каждое событие должно проходить zod-схему раздела 9 и не содержать лишних полей. */
export function expectValidEvents(events: StoryEvent[]): void {
  for (const e of events) {
    const parsed = StoryEvent.safeParse(e);
    if (!parsed.success) throw new Error(`${e.event}: ${parsed.error.message}`);
    expect(Object.keys(e).sort()).toEqual(Object.keys(parsed.data).sort());
    expect(e.platform).toBe('web');
    expect(JSON.stringify(e)).not.toMatch(/user_?id/i);
  }
}

export function viewerRoot(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.idbs-viewer');
  if (!el) throw new Error('viewer is not open');
  return el;
}

export function stage(): HTMLElement {
  return viewerRoot().querySelector<HTMLElement>('.idbs-stage')!;
}

export function currentTexts(): string[] {
  return [...viewerRoot().querySelectorAll('.idbs-slide .idbs-text')].map(
    (e) => e.textContent ?? '',
  );
}

export function currentTitle(): string {
  return currentTexts()[0] ?? '';
}

/** happy-dom не грузит медиа: вручную «загружаем» картинки и видео текущего слайда. */
export function loadMedia(): void {
  for (const el of viewerRoot().querySelectorAll('.idbs-media img'))
    el.dispatchEvent(new Event('load'));
  for (const el of viewerRoot().querySelectorAll('.idbs-media video'))
    el.dispatchEvent(new Event('loadeddata'));
}

export function mockStageWidth(width = 300): void {
  const st = stage();
  st.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: width,
      bottom: width * 2,
      width,
      height: width * 2,
      x: 0,
      y: 0,
    }) as DOMRect;
}

let pointerSeq = 1;

export function pointer(
  type: 'pointerdown' | 'pointerup' | 'pointercancel',
  x: number,
  y: number,
  id: number,
): void {
  stage().dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      clientX: x,
      clientY: y,
      pointerId: id,
      pointerType: 'touch',
      button: 0,
    }),
  );
}

export function tap(x: number, y = 200): void {
  const id = pointerSeq++;
  pointer('pointerdown', x, y, id);
  pointer('pointerup', x, y, id);
}

export function swipe(dx: number, dy: number, from = { x: 150, y: 200 }): void {
  const id = pointerSeq++;
  pointer('pointerdown', from.x, from.y, id);
  pointer('pointerup', from.x + dx, from.y + dy, id);
}

export function key(k: string, target: EventTarget = document): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
}

export function click(el: Element | null | undefined): void {
  if (!el) throw new Error('element not found');
  (el as HTMLElement).click();
}

/** Даёт отработать микрозадачам и таймерам нулевой длительности. */
export async function flush(vi?: {
  advanceTimersByTimeAsync(ms: number): Promise<unknown>;
}): Promise<void> {
  if (vi) {
    await vi.advanceTimersByTimeAsync(0);
  } else {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  }
}
