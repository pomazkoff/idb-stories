import type { StoryEvent } from '@idb-stories/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountFeed, type FeedOptions } from '../src/index.js';
import { viewedKey } from '../src/viewed.js';
import {
  ALLOWLIST,
  CDN,
  click,
  expectValidEvents,
  gid,
  group,
  imageSlide,
  makeFeed,
  MemoryStorage,
  ofType,
  sid,
} from './helpers.js';

const API = 'https://api.stories.example';

type FetchCall = [string, RequestInit | undefined];

function jsonResponse(body: unknown, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

class FakeIO {
  static instances: FakeIO[] = [];
  target: Element | null = null;
  disconnected = false;
  constructor(private readonly cb: IntersectionObserverCallback) {
    FakeIO.instances.push(this);
  }
  observe(el: Element) {
    this.target = el;
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  takeRecords() {
    return [];
  }
  trigger(isIntersecting = true) {
    const entry = {
      isIntersecting,
      target: this.target,
      intersectionRatio: isIntersecting ? 1 : 0,
    };
    this.cb(
      [entry as unknown as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

let container: HTMLElement;
let handles: { destroy(): void }[] = [];
let fetchMock: ReturnType<typeof vi.fn>;
let events: StoryEvent[];
let storage: MemoryStorage;
let beacon: ReturnType<typeof vi.fn<(url: string | URL, data?: BodyInit | null) => boolean>>;

function setup(response: () => Promise<Response>) {
  fetchMock = vi.fn((_url: string, _init?: RequestInit) => response());
  vi.stubGlobal('fetch', fetchMock);
}

function mount(extra: Partial<FeedOptions> = {}) {
  const handle = mountFeed(container, {
    apiBaseUrl: `${API}/`,
    placement: 'home',
    mediaOrigins: [CDN],
    ctaAllowlist: ALLOWLIST,
    storage,
    sessionId: 'feed-session',
    eventsEndpoint: null,
    onEvent: (e) => events.push(e),
    ...extra,
  });
  handles.push(handle);
  return handle;
}

const titles = () =>
  [...container.querySelectorAll('.idbs-circle__title')].map((e) => e.textContent);
const feedCalls = () =>
  (fetchMock.mock.calls as FetchCall[]).filter(([url]) => url.includes('/v1/feed'));

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  events = [];
  storage = new MemoryStorage();
  FakeIO.instances = [];
  vi.stubGlobal('IntersectionObserver', FakeIO);
  // Реализация happy-dom ходит в сеть — подменяем.
  beacon = vi.fn((_url: string | URL, _data?: BodyInit | null) => true);
  vi.spyOn(navigator, 'sendBeacon').mockImplementation(beacon);
});

afterEach(() => {
  for (const h of handles) h.destroy();
  handles = [];
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('загрузка ленты', () => {
  it('GET /v1/feed?placement=… с X-Platform: web, без токена — без Authorization', async () => {
    setup(() => Promise.resolve(jsonResponse(makeFeed(2, 1))));
    const feed = mount();
    expect(container.hidden).toBe(true);
    await feed.refresh();
    const [url, init] = feedCalls()[0]!;
    expect(url).toBe(`${API}/v1/feed?placement=home`);
    const headers = init!.headers as Record<string, string>;
    expect(headers['X-Platform']).toBe('web');
    expect(headers.Authorization).toBeUndefined();
    expect(init!.credentials).toBe('omit');
    expect(container.hidden).toBe(false);
    expect(titles()).toEqual(['Группа 1', 'Группа 2']);
    const img = container.querySelector('.idbs-circle__img')!;
    expect(img.getAttribute('src')).toBe(`${CDN}/cover-1.webp`);
  });

  it('с токеном — Authorization: Bearer; ошибка получения токена — анонимный запрос', async () => {
    setup(() => Promise.resolve(jsonResponse(makeFeed(1, 1))));
    await mount({ getAuthToken: () => Promise.resolve('tok-123') }).refresh();
    expect((feedCalls()[0]![1]!.headers as Record<string, string>).Authorization).toBe(
      'Bearer tok-123',
    );
    await mount({ getAuthToken: () => Promise.reject(new Error('no auth')) }).refresh();
    expect((feedCalls()[1]![1]!.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it.each([
    ['сеть недоступна', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['HTTP 500', () => Promise.resolve(jsonResponse({}, 500))],
    ['HTTP 304', () => Promise.resolve(jsonResponse(makeFeed(1, 1), 304))],
    [
      'невалидный JSON',
      () =>
        Promise.resolve({
          status: 200,
          json: () => Promise.reject(new SyntaxError('bad json')),
        } as unknown as Response),
    ],
    ['пустой список групп', () => Promise.resolve(jsonResponse(makeFeed([])))],
    [
      'schema_version выше поддерживаемой',
      () => Promise.resolve(jsonResponse(makeFeed(2, 1, { schema_version: 2 }))),
    ],
    ['не объект', () => Promise.resolve(jsonResponse('<html>'))],
    [
      'все слайды неизвестного типа',
      () =>
        Promise.resolve(
          jsonResponse(
            makeFeed([group(1, [{ id: sid(1, 1), type: 'poll', elements: [], cta: null }])]),
          ),
        ),
    ],
  ])('%s — блок молча скрывается', async (_name, response) => {
    setup(response);
    container.appendChild(document.createElement('span'));
    const feed = mount();
    await expect(feed.refresh()).resolves.toBeUndefined();
    expect(container.hidden).toBe(true);
    expect(container.childElementCount).toBe(0);
    expect(ofType(events, 'stories_feed_shown')).toHaveLength(0);
  });

  it('после ошибки лента скрывается, даже если раньше была показана (TTL истёк)', async () => {
    vi.useFakeTimers();
    let fail = false;
    setup(() =>
      fail ? Promise.reject(new Error('down')) : Promise.resolve(jsonResponse(makeFeed(1, 1))),
    );
    const feed = mount();
    await feed.refresh();
    expect(container.hidden).toBe(false);
    fail = true;
    vi.advanceTimersByTime(61_000);
    await feed.refresh();
    expect(container.hidden).toBe(true);
  });

  it('ответ кешируется в памяти до ttl_sec', async () => {
    vi.useFakeTimers();
    setup(() => Promise.resolve(jsonResponse(makeFeed(1, 1, { ttl_sec: 30 }))));
    const feed = mount();
    await feed.refresh();
    expect(feedCalls()).toHaveLength(1);
    vi.advanceTimersByTime(29_000);
    await feed.refresh();
    expect(feedCalls()).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    await feed.refresh();
    expect(feedCalls()).toHaveLength(2);
  });

  it('параллельные refresh() делят один запрос', async () => {
    setup(() => Promise.resolve(jsonResponse(makeFeed(1, 1))));
    const feed = mount();
    await Promise.all([feed.refresh(), feed.refresh(), feed.refresh()]);
    expect(feedCalls()).toHaveLength(1);
  });

  it('заголовок группы — только текст', async () => {
    setup(() =>
      Promise.resolve(
        jsonResponse(
          makeFeed([group(1, [imageSlide(1, 1)], { title: '<img src=x onerror=alert(1)>' })]),
        ),
      ),
    );
    await mount().refresh();
    expect(titles()).toEqual(['<img src=x onerror=alert(1)>']);
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(container.querySelector('[onerror]')).toBeNull();
  });

  it('обложка с чужого origin не загружается', async () => {
    setup(() =>
      Promise.resolve(
        jsonResponse(
          makeFeed([
            group(1, [imageSlide(1, 1)], {
              cover: { url: 'https://evil.example/c.webp', w: 1, h: 1 },
            }),
          ]),
        ),
      ),
    );
    await mount().refresh();
    const img = container.querySelector<HTMLImageElement>('.idbs-circle__img')!;
    expect(img.hasAttribute('src')).toBe(false);
    expect(img.hidden).toBe(true);
  });
});

describe('просмотренные группы', () => {
  it('просмотренные приглушены и в конце ряда; новая версия снова непросмотрена', async () => {
    storage.setItem(viewedKey(gid(1), 1), '1');
    storage.setItem(viewedKey(gid(3), 1), '1');
    const feed = makeFeed(3, 1);
    (feed.groups[2] as { version: number }).version = 2; // группу 3 обновили
    setup(() => Promise.resolve(jsonResponse(feed)));
    await mount().refresh();
    expect(titles()).toEqual(['Группа 2', 'Группа 3', 'Группа 1']);
    const circles = [...container.querySelectorAll('.idbs-circle')];
    expect(circles.map((c) => c.classList.contains('idbs-circle--viewed'))).toEqual([
      false,
      false,
      true,
    ]);
    expect(circles[2]!.getAttribute('aria-label')).toBe('Группа 1, просмотрено');
  });

  it('открытая группа становится просмотренной и после закрытия уезжает в конец', async () => {
    setup(() => Promise.resolve(jsonResponse(makeFeed(3, 1))));
    await mount().refresh();
    const first = container.querySelector<HTMLButtonElement>('.idbs-circle')!;
    first.focus();
    click(first);
    const viewer = document.querySelector('.idbs-viewer')!;
    expect(viewer.getAttribute('aria-label')).toBe('Группа 1');
    click(viewer.querySelector('button[aria-label="Закрыть"]'));
    expect(document.querySelector('.idbs-viewer')).toBeNull();
    expect(titles()).toEqual(['Группа 2', 'Группа 3', 'Группа 1']);
    expect(storage.getItem(viewedKey(gid(1), 1))).toBe('1');
    // Фокус вернулся на тот же кружок.
    expect(document.activeElement).toBe(first);
  });

  it('недоступный Storage не ломает ленту', async () => {
    const broken = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    } as unknown as Storage;
    setup(() => Promise.resolve(jsonResponse(makeFeed(2, 1))));
    await mount({ storage: broken }).refresh();
    expect(titles()).toEqual(['Группа 1', 'Группа 2']);
    click(container.querySelector('.idbs-circle'));
    click(document.querySelector('.idbs-viewer button[aria-label="Закрыть"]'));
    // «Просмотрено» помнится в памяти до перезагрузки страницы.
    expect(titles()).toEqual(['Группа 2', 'Группа 1']);
  });

  it('открытие из ленты листает группы в порядке ряда', async () => {
    storage.setItem(viewedKey(gid(1), 1), '1');
    setup(() => Promise.resolve(jsonResponse(makeFeed(3, 1))));
    await mount().refresh();
    click(container.querySelector('.idbs-circle'));
    const viewer = document.querySelector('.idbs-viewer')!;
    expect(viewer.getAttribute('aria-label')).toBe('Группа 2');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(viewer.getAttribute('aria-label')).toBe('Группа 3');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(viewer.getAttribute('aria-label')).toBe('Группа 1');
  });
});

describe('stories_feed_shown', () => {
  it('отправляется, когда ряд попал во вьюпорт, один раз', async () => {
    setup(() => Promise.resolve(jsonResponse(makeFeed(3, 1))));
    const feed = mount();
    await feed.refresh();
    expect(ofType(events, 'stories_feed_shown')).toHaveLength(0);
    const io = FakeIO.instances.at(-1)!;
    expect(io.target).toBe(container.querySelector('.idbs-feed'));
    io.trigger(false);
    expect(ofType(events, 'stories_feed_shown')).toHaveLength(0);
    io.trigger(true);
    const shown = ofType(events, 'stories_feed_shown');
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      groups_count: 3,
      group_ids: [gid(1), gid(2), gid(3)],
      placement: 'home',
    });
    expect(io.disconnected).toBe(true);
    expectValidEvents(events);
  });

  it('без IntersectionObserver — сразу после отрисовки', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    setup(() => Promise.resolve(jsonResponse(makeFeed(2, 1))));
    await mount().refresh();
    expect(ofType(events, 'stories_feed_shown')).toHaveLength(1);
  });

  it('forbidden_origin для слайдов с чужими медиа сообщается при загрузке ленты', async () => {
    const evil = imageSlide(1, 1, {
      media: { variants: [{ url: 'https://evil.example/x.webp', w: 1, h: 1, mime: 'image/webp' }] },
    });
    setup(() =>
      Promise.resolve(jsonResponse(makeFeed([group(1, [evil]), group(2, [imageSlide(2, 1)])]))),
    );
    await mount().refresh();
    expect(titles()).toEqual(['Группа 2']);
    const err = ofType(events, 'story_media_error');
    expect(err).toHaveLength(1);
    expect(err[0]).toMatchObject({
      error_code: 'forbidden_origin',
      group_id: gid(1),
      slide_id: sid(1, 1),
    });
    expectValidEvents(events);
  });
});

describe('отправка событий', () => {
  function postedBatches(): unknown[][] {
    return (fetchMock.mock.calls as FetchCall[])
      .filter(([url]) => url.endsWith('/v1/events'))
      .map(([, init]) => (JSON.parse(init!.body as string) as { events: unknown[] }).events);
  }

  it('события копятся и уходят POST {events} раз в ~5 с на /v1/events', async () => {
    vi.useFakeTimers();
    setup(() => Promise.resolve(jsonResponse(makeFeed(2, 1))));
    const feed = mount({ eventsEndpoint: undefined });
    await feed.refresh();
    FakeIO.instances.at(-1)!.trigger();
    expect(postedBatches()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5000);
    const batches = postedBatches();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(batches[0]![0]).toMatchObject({ event: 'stories_feed_shown' });
    const init = (fetchMock.mock.calls as FetchCall[]).find(
      ([url]) => url === `${API}/v1/events`,
    )![1]!;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.credentials).toBe('omit');
  });

  it('батч не больше 50 событий: полный батч уходит сразу', async () => {
    vi.useFakeTimers();
    setup(() => Promise.resolve(jsonResponse(makeFeed(1, 1))));
    const feed = mount({ eventsEndpoint: `${API}/v1/events` });
    await feed.refresh();
    const io = FakeIO.instances.at(-1)!;
    click(container.querySelector('.idbs-circle'));
    // 60 событий: открываем и закрываем плеер.
    for (let i = 0; i < 30; i++) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      click(container.querySelector('.idbs-circle'));
    }
    io.trigger();
    const first = postedBatches();
    expect(first).toHaveLength(1);
    expect(first[0]).toHaveLength(50);
    await vi.advanceTimersByTimeAsync(5000);
    const all = postedBatches();
    expect(all).toHaveLength(2);
    expect(all.every((b) => b.length <= 50)).toBe(true);
    expect(all.flat()).toHaveLength(62);
  });

  it('при pagehide остаток уходит через navigator.sendBeacon', async () => {
    setup(() => Promise.resolve(jsonResponse(makeFeed(1, 1))));
    const feed = mount({ eventsEndpoint: 'https://collector.example/v1/events' });
    await feed.refresh();
    FakeIO.instances.at(-1)!.trigger();
    window.dispatchEvent(new Event('pagehide'));
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(beacon.mock.calls[0]![0]).toBe('https://collector.example/v1/events');
    const blob = beacon.mock.calls[0]![1] as Blob;
    const body = JSON.parse(await blob.text()) as { events: StoryEvent[] };
    expect(body.events.map((e) => e.event)).toEqual(['stories_feed_shown']);
    expect(postedBatches()).toHaveLength(0);
  });

  it('eventsEndpoint: null — события не отправляются, но onEvent вызывается', async () => {
    vi.useFakeTimers();
    setup(() => Promise.resolve(jsonResponse(makeFeed(1, 1))));
    const feed = mount({ eventsEndpoint: null });
    await feed.refresh();
    FakeIO.instances.at(-1)!.trigger();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(postedBatches()).toHaveLength(0);
    expect(ofType(events, 'stories_feed_shown')).toHaveLength(1);
  });
});

describe('destroy', () => {
  it('очищает контейнер, закрывает плеер и отправляет остаток событий', async () => {
    setup(() => Promise.resolve(jsonResponse(makeFeed(2, 1))));
    const feed = mount({ eventsEndpoint: `${API}/v1/events` });
    await feed.refresh();
    click(container.querySelector('.idbs-circle'));
    expect(document.querySelector('.idbs-viewer')).not.toBeNull();
    feed.destroy();
    expect(document.querySelector('.idbs-viewer')).toBeNull();
    expect(container.childElementCount).toBe(0);
    expect(container.hidden).toBe(false);
    expect(document.documentElement.classList.contains('idbs-scroll-lock')).toBe(false);
    // Остаток событий (group_open) отправлен при destroy.
    expect(beacon).toHaveBeenCalledTimes(1);
    const body = JSON.parse(await (beacon.mock.calls[0]![1] as Blob).text()) as {
      events: StoryEvent[];
    };
    expect(body.events.map((e) => e.event)).toEqual(['story_group_open']);
    await expect(feed.refresh()).resolves.toBeUndefined();
    expect(feedCalls()).toHaveLength(1);
  });

  it('ответ, пришедший после destroy, ничего не рисует', async () => {
    let resolve!: (r: Response) => void;
    setup(() => new Promise<Response>((r) => (resolve = r)));
    const feed = mount();
    const pending = feed.refresh();
    feed.destroy();
    resolve(jsonResponse(makeFeed(1, 1)));
    await pending;
    expect(container.childElementCount).toBe(0);
  });
});
