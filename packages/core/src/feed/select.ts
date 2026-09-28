import {
  LIMITS,
  compareVersions,
  type FeedGroup,
  type Placement,
  type Platform,
} from '@idb-stories/schema';

/** Опубликованный снимок в памяти API (payload уже в формате публичного API). */
export interface LiveSnapshot {
  groupId: string;
  version: number;
  placement: Placement;
  priority: number;
  startAt: number;
  endAt: number;
  platforms: readonly Platform[];
  minAppVersionIos: string | null;
  minAppVersionAndroid: string | null;
  segmentIds: readonly string[];
  payload: FeedGroup;
}

export interface FeedRequest {
  placement: Placement;
  platform: Platform;
  /** Для web не используется. */
  appVersion: string | null;
  /** null — анонимный запрос (или адаптер сегментов недоступен): только группы без сегментов. */
  userSegments: readonly string[] | null;
  now: number;
}

export interface FeedSelection {
  groups: FeedGroup[];
  /** Ближайший момент, когда состав ленты изменится по времени (start_at или end_at). */
  nextChangeAt: number | null;
}

function minVersionFor(s: LiveSnapshot, platform: Platform): string | null {
  if (platform === 'ios') return s.minAppVersionIos;
  if (platform === 'android') return s.minAppVersionAndroid;
  return null;
}

function versionAllowed(s: LiveSnapshot, platform: Platform, appVersion: string | null): boolean {
  const min = minVersionFor(s, platform);
  if (!min) return true;
  if (!appVersion) return false;
  return compareVersions(appVersion, min) >= 0;
}

function segmentsAllowed(s: LiveSnapshot, userSegments: readonly string[] | null): boolean {
  if (s.segmentIds.length === 0) return true;
  if (!userSegments || userSegments.length === 0) return false;
  return s.segmentIds.some((id) => userSegments.includes(id));
}

/**
 * Логика ленты (раздел 5.1, шаги 2–4): период, платформа, версия приложения, placement,
 * сегменты; сортировка priority desc, start_at desc; не больше 20 групп и 10 слайдов.
 */
export function selectFeed(snapshots: readonly LiveSnapshot[], req: FeedRequest): FeedSelection {
  let nextChangeAt: number | null = null;
  const bump = (t: number) => {
    if (t > req.now && (nextChangeAt === null || t < nextChangeAt)) nextChangeAt = t;
  };

  const matching = snapshots.filter((s) => {
    if (s.placement !== req.placement || !s.platforms.includes(req.platform)) return false;
    if (!versionAllowed(s, req.platform, req.appVersion)) return false;
    if (!segmentsAllowed(s, req.userSegments)) return false;
    bump(s.startAt);
    bump(s.endAt);
    return s.startAt <= req.now && req.now < s.endAt;
  });

  matching.sort(
    (a, b) =>
      b.priority - a.priority || b.startAt - a.startAt || a.groupId.localeCompare(b.groupId),
  );

  const groups = matching.slice(0, LIMITS.groupsPerFeedMax).map((s) => ({
    ...s.payload,
    slides: s.payload.slides.slice(0, LIMITS.slidesPerGroupMax),
  }));
  return { groups, nextChangeAt };
}

/**
 * Бакет версии приложения для ключа кеша: номер «ступеньки» среди порогов min_app_version
 * опубликованных групп. Версии внутри одного бакета получают одинаковую ленту, поэтому
 * кеш не дробится по каждой патч-версии и при этом никогда не отдаёт лишнего.
 */
export function versionBucket(
  snapshots: readonly LiveSnapshot[],
  req: Pick<FeedRequest, 'placement' | 'platform' | 'appVersion'>,
): string {
  if (req.platform === 'web') return 'web';
  const thresholds = new Set<string>();
  for (const s of snapshots) {
    if (s.placement !== req.placement || !s.platforms.includes(req.platform)) continue;
    const min = minVersionFor(s, req.platform);
    if (min) thresholds.add(min);
  }
  if (!req.appVersion) return 'none';
  let passed = 0;
  for (const t of thresholds) if (compareVersions(req.appVersion, t) >= 0) passed += 1;
  // В ключ входит и число порогов: разный набор порогов — разная ступенька.
  return `v${passed}of${thresholds.size}`;
}

/** TTL ответа: не больше 60 с и не дольше, чем до ближайшего start_at/end_at. */
export function feedTtlSec(
  nextChangeAt: number | null,
  now: number,
  maxSec: number = LIMITS.feedTtlMaxSec,
): number {
  if (nextChangeAt === null) return maxSec;
  return Math.max(1, Math.min(maxSec, Math.ceil((nextChangeAt - now) / 1000)));
}
