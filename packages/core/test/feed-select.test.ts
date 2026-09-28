import { describe, expect, it } from 'vitest';
import type { FeedGroup } from '@idb-stories/schema';
import {
  feedTtlSec,
  selectFeed,
  versionBucket,
  type FeedRequest,
  type LiveSnapshot,
} from '../src/feed/select.js';

const now = Date.parse('2026-10-01T09:00:00Z');
const H = 3600_000;

function snap(id: string, overrides: Partial<LiveSnapshot> = {}): LiveSnapshot {
  const payload: FeedGroup = {
    id,
    version: 1,
    title: id,
    cover: { url: 'https://cdn.example/c.webp', w: 256, h: 256 },
    slides: Array.from({ length: 12 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      type: 'product' as const,
      duration_ms: 6000,
      product_skus: ['SKU1'],
      elements: [],
      cta: null,
    })),
  };
  return {
    groupId: id,
    version: 1,
    placement: 'home',
    priority: 0,
    startAt: now - H,
    endAt: now + H,
    platforms: ['ios', 'android', 'web'],
    minAppVersionIos: null,
    minAppVersionAndroid: null,
    segmentIds: [],
    payload,
    ...overrides,
  };
}

const req: FeedRequest = {
  placement: 'home',
  platform: 'ios',
  appVersion: '5.12.0',
  userSegments: null,
  now,
};
const ids = (s: LiveSnapshot[], r = req) => selectFeed(s, r).groups.map((g) => g.id);

describe('selectFeed', () => {
  it('окно показа: start_at включительно, end_at исключительно', () => {
    const s = [
      snap('future', { startAt: now + 1 }),
      snap('past', { endAt: now }),
      snap('edge', { startAt: now }),
    ];
    expect(ids(s)).toEqual(['edge']);
  });

  it('placement и платформа', () => {
    const s = [
      snap('cart', { placement: 'cart' }),
      snap('web-only', { platforms: ['web'] }),
      snap('ok'),
    ];
    expect(ids(s)).toEqual(['ok']);
  });

  it('min_app_version своя для каждой платформы', () => {
    const s = [
      snap('ios6', { minAppVersionIos: '6.0.0' }),
      snap('android9', { minAppVersionAndroid: '9.0.0' }),
    ];
    expect(ids(s)).toEqual(['android9']);
    expect(ids(s, { ...req, appVersion: '6.0' })).toEqual(['android9', 'ios6'].sort());
    expect(ids(s, { ...req, platform: 'android', appVersion: '8.9.9' })).toEqual(['ios6']);
    expect(ids(s, { ...req, platform: 'web', appVersion: null })).toEqual(
      ['android9', 'ios6'].sort(),
    );
  });

  it('сегменты: анонимно — только группы без сегментов', () => {
    const s = [snap('all'), snap('gold', { segmentIds: ['gold'] })];
    expect(ids(s)).toEqual(['all']);
    expect(ids(s, { ...req, userSegments: ['silver'] })).toEqual(['all']);
    expect(ids(s, { ...req, userSegments: ['gold', 'x'] }).sort()).toEqual(['all', 'gold']);
  });

  it('сортировка priority desc, start_at desc; не больше 20 групп и 10 слайдов', () => {
    const s = Array.from({ length: 25 }, (_, i) =>
      snap(`g${String(i).padStart(2, '0')}`, { priority: i % 3, startAt: now - i * 1000 }),
    );
    const res = selectFeed(s, req);
    expect(res.groups).toHaveLength(20);
    expect(res.groups.every((g) => g.slides.length === 10)).toBe(true);
    const order = res.groups.map((g) => s.find((x) => x.groupId === g.id)!);
    for (let i = 1; i < order.length; i++) {
      const [a, b] = [order[i - 1]!, order[i]!];
      expect(a.priority > b.priority || (a.priority === b.priority && a.startAt >= b.startAt)).toBe(
        true,
      );
    }
  });

  it('nextChangeAt и TTL не дольше ближайшей границы', () => {
    const s = [
      snap('a', { endAt: now + 15_000 }),
      snap('b', { startAt: now + 40_000, endAt: now + H }),
    ];
    const res = selectFeed(s, req);
    expect(res.nextChangeAt).toBe(now + 15_000);
    expect(feedTtlSec(res.nextChangeAt, now)).toBe(15);
    expect(feedTtlSec(null, now)).toBe(60);
    expect(feedTtlSec(now + 10 * H, now)).toBe(60);
  });
});

describe('versionBucket', () => {
  const s = [snap('a', { minAppVersionIos: '5.10.0' }), snap('b', { minAppVersionIos: '6.0.0' })];
  it('версии с одинаковым набором пройденных порогов попадают в один бакет', () => {
    const b = (v: string) =>
      versionBucket(s, { placement: 'home', platform: 'ios', appVersion: v });
    expect(b('5.10.0')).toBe(b('5.99.9'));
    expect(b('5.9.9')).not.toBe(b('5.10.0'));
    expect(b('6.0.0')).not.toBe(b('5.99.9'));
    expect(versionBucket(s, { placement: 'home', platform: 'web', appVersion: null })).toBe('web');
  });
});
