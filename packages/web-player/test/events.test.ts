import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openViewer, type PlayerOptions } from '../src/index.js';
import {
  baseOptions,
  expectValidEvents,
  gid,
  loadMedia,
  makeFeed,
  mockStageWidth,
  names,
  ofType,
  sid,
  tap,
} from './helpers.js';

let handle: { close(): void } | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-01T09:00:00.000Z'));
});

afterEach(() => {
  handle?.close();
  handle = null;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function open(extra: Partial<PlayerOptions> = {}, feed = makeFeed(2, 3)) {
  const { options, events } = baseOptions(extra);
  handle = openViewer(feed, 0, options);
  mockStageWidth(300);
  return events;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('общие поля событий (раздел 9)', () => {
  it('event_id — уникальный UUID v4, ts — ISO, session/platform/app_version/placement из опций', () => {
    const events = open({ placement: 'catalog', sessionId: 'sess-1', appVersion: '5.12.0' });
    loadMedia();
    vi.advanceTimersByTime(1000);
    handle!.close();
    expect(events.length).toBeGreaterThanOrEqual(3);
    const ids = new Set(events.map((e) => e.event_id));
    expect(ids.size).toBe(events.length);
    for (const e of events) {
      expect(e.event_id).toMatch(UUID_V4);
      expect(e).toMatchObject({
        platform: 'web',
        placement: 'catalog',
        session_id: 'sess-1',
        app_version: '5.12.0',
      });
    }
    expect(events[0]!.ts).toBe('2026-10-01T09:00:00.000Z');
    expectValidEvents(events);
  });

  it('по умолчанию app_version = web, session_id случайный и общий для страницы', () => {
    const a = open({ appVersion: undefined, sessionId: undefined });
    handle!.close();
    const b = open({ appVersion: undefined, sessionId: undefined });
    expect(a[0]!.app_version).toBe('web');
    expect(a[0]!.session_id).toMatch(UUID_V4);
    expect(b[0]!.session_id).toBe(a[0]!.session_id);
    expectValidEvents([...a, ...b]);
  });

  it('без crypto.randomUUID (не secure context) event_id всё равно UUID v4', () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', {
      getRandomValues: <T extends ArrayBufferView>(a: T) => real.getRandomValues(a),
    });
    try {
      const events = open({ sessionId: 's' });
      expect(events[0]!.event_id).toMatch(UUID_V4);
      expectValidEvents(events);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('опция now задаёт ts', () => {
    const events = open({ now: () => Date.parse('2030-01-02T03:04:05.000Z') });
    expect(events[0]!.ts).toBe('2030-01-02T03:04:05.000Z');
  });

  it('ошибка в onEvent хоста не ломает плеер', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() =>
      open({
        onEvent: () => {
          throw new Error('analytics down');
        },
      }),
    ).not.toThrow();
    expect(document.querySelector('.idbs-viewer')).not.toBeNull();
  });
});

describe('story_group_open / story_slide_view / story_slide_complete', () => {
  it('group_open при открытии с source=tap и полями группы', () => {
    const events = open();
    expect(ofType(events, 'story_group_open')).toEqual([
      expect.objectContaining({ group_id: gid(1), group_version: 1, source: 'tap' }),
    ]);
  });

  it('slide_view — только после ≥ 1 с показа', () => {
    const events = open();
    loadMedia();
    vi.advanceTimersByTime(999);
    expect(ofType(events, 'story_slide_view')).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(ofType(events, 'story_slide_view')).toEqual([
      expect.objectContaining({
        group_id: gid(1),
        slide_id: sid(1, 1),
        slide_index: 0,
        slide_type: 'image',
      }),
    ]);
  });

  it('пролистанный раньше 1 с слайд не засчитывается ни как view, ни как complete', () => {
    const events = open();
    loadMedia();
    vi.advanceTimersByTime(500);
    tap(250);
    loadMedia();
    vi.advanceTimersByTime(500);
    tap(250);
    expect(ofType(events, 'story_slide_view')).toHaveLength(0);
    expect(ofType(events, 'story_slide_complete')).toHaveLength(0);
  });

  it('slide_complete — только если слайд доигран до конца', () => {
    const events = open();
    loadMedia();
    vi.advanceTimersByTime(3000);
    tap(250);
    expect(ofType(events, 'story_slide_complete')).toHaveLength(0);
    loadMedia();
    vi.advanceTimersByTime(5000);
    expect(ofType(events, 'story_slide_complete')).toEqual([
      expect.objectContaining({ slide_id: sid(1, 2), slide_index: 1 }),
    ]);
  });

  it('переход в следующую группу по тапу — group_open source=tap, по таймеру — auto', () => {
    const events = open({}, makeFeed(3, 1));
    tap(250);
    loadMedia();
    vi.advanceTimersByTime(5000);
    expect(ofType(events, 'story_group_open').map((e) => [e.group_id, e.source])).toEqual([
      [gid(1), 'tap'],
      [gid(2), 'tap'],
      [gid(3), 'auto'],
    ]);
  });
});

describe('story_close', () => {
  it('watched_slides — число слайдов текущей группы, показанных ≥ 1 с', () => {
    const events = open();
    loadMedia();
    vi.advanceTimersByTime(1500);
    tap(250);
    loadMedia();
    vi.advanceTimersByTime(1500);
    tap(250);
    handle!.close();
    expect(ofType(events, 'story_close')).toEqual([
      expect.objectContaining({
        group_id: gid(1),
        group_version: 1,
        reason: 'button',
        watched_slides: 2,
      }),
    ]);
    expectValidEvents(events);
  });

  it('последовательность событий полного просмотра валидна по схеме', () => {
    const events = open({}, makeFeed(1, 2));
    for (let i = 0; i < 2; i++) {
      loadMedia();
      vi.advanceTimersByTime(5000);
    }
    expect(names(events)).toEqual([
      'story_group_open',
      'story_slide_view',
      'story_slide_complete',
      'story_slide_view',
      'story_slide_complete',
      'story_close',
    ]);
    expect(ofType(events, 'story_close')[0]).toMatchObject({ reason: 'end', watched_slides: 2 });
    expectValidEvents(events);
  });
});
