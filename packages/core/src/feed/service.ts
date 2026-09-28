import { createHash } from 'node:crypto';
import type { PrismaClient } from '@idb-stories/db';
import {
  FEED_SCHEMA_VERSION,
  LIMITS,
  type FeedGroup,
  type Placement,
  type Platform,
} from '@idb-stories/schema';
import type { Logger } from '../logger.js';
import { feedCacheTotal } from '../metrics.js';
import type { Redis, RedisKeys } from '../redis.js';
import type { SettingsService } from '../settings.js';
import { feedTtlSec, selectFeed, versionBucket, type LiveSnapshot } from './select.js';

export interface FeedServiceDeps {
  prisma: PrismaClient;
  redis: Redis;
  keys: RedisKeys;
  settings: SettingsService;
  logger: Logger;
  now?: () => number;
}

export interface FeedQueryInput {
  placement: Placement;
  platform: Platform;
  appVersion: string | null;
  userSegments: readonly string[] | null;
}

export interface FeedResult {
  /** Готовый JSON ответа (из кеша отдаётся без повторной сериализации). */
  body: string;
  ttlSec: number;
  cache: 'hit' | 'miss' | 'disabled';
}

/** Сколько живёт в памяти набор опубликованных снимков одного поколения. */
const LIVE_SET_MAX_AGE_MS = 60_000;
/** Если Redis недоступен и поколение неизвестно — перечитываем БД не чаще раза в 5 с. */
const LIVE_SET_FALLBACK_MS = 5_000;

export function segmentsHash(segments: readonly string[]): string {
  return createHash('sha256')
    .update([...new Set(segments)].sort().join('\n'))
    .digest('hex')
    .slice(0, 32);
}

export function emptyFeed(now: number, ttlSec: number = LIMITS.feedTtlMaxSec): string {
  return JSON.stringify({
    schema_version: FEED_SCHEMA_VERSION,
    generated_at: new Date(now).toISOString(),
    ttl_sec: ttlSec,
    groups: [],
  });
}

/**
 * Лента отдаётся только из опубликованных снимков (раздел 4.1).
 * Кеш ответа в Redis: ключ = поколение + placement + платформа + бакет версии + hash(сегментов)
 * (никогда не user_id). Любая публикация, снятие или kill switch увеличивает поколение —
 * старые ключи перестают читаться сразу и истекают сами (TTL ≤ 60 с).
 */
export class FeedService {
  private live: { gen: string | null; loadedAt: number; snapshots: LiveSnapshot[] } | null = null;
  private loading: Promise<LiveSnapshot[]> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: FeedServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  async getFeed(req: FeedQueryInput): Promise<FeedResult> {
    const now = this.now();
    if (!(await this.deps.settings.isFeedEnabled())) {
      feedCacheTotal.inc({ result: 'disabled' });
      return { body: emptyFeed(now), ttlSec: LIMITS.feedTtlMaxSec, cache: 'disabled' };
    }

    const { gen, snapshots } = await this.liveSet(now);
    const bucket = versionBucket(snapshots, req);
    const seg = req.userSegments === null ? 'anon' : `s${segmentsHash(req.userSegments)}`;
    const key =
      gen === null
        ? null
        : this.deps.keys.feedResponse(gen, `${req.placement}:${req.platform}:${bucket}:${seg}`);

    if (key) {
      try {
        const cached = await this.deps.redis.get(key);
        if (cached) {
          const sep = cached.indexOf('\n');
          const expiresAt = Number(cached.slice(0, sep));
          const ttlSec = Math.ceil((expiresAt - now) / 1000);
          if (sep > 0 && ttlSec >= 1) {
            feedCacheTotal.inc({ result: 'hit' });
            return { body: cached.slice(sep + 1), ttlSec, cache: 'hit' };
          }
        }
      } catch (err) {
        this.deps.logger.warn({ err }, 'Кеш ленты недоступен');
      }
    }

    const selection = selectFeed(snapshots, { ...req, now });
    const ttlSec = feedTtlSec(selection.nextChangeAt, now);
    const body = JSON.stringify({
      schema_version: FEED_SCHEMA_VERSION,
      generated_at: new Date(now).toISOString(),
      ttl_sec: ttlSec,
      groups: selection.groups,
    });
    if (key) {
      this.deps.redis
        .set(key, `${now + ttlSec * 1000}\n${body}`, 'EX', ttlSec)
        .catch((err: unknown) => this.deps.logger.warn({ err }, 'Не удалось записать кеш ленты'));
    }
    feedCacheTotal.inc({ result: 'miss' });
    return { body, ttlSec, cache: 'miss' };
  }

  private async liveSet(now: number): Promise<{ gen: string | null; snapshots: LiveSnapshot[] }> {
    let gen: string | null;
    try {
      gen = (await this.deps.redis.get(this.deps.keys.feedGeneration)) ?? '0';
    } catch {
      gen = null;
    }
    const live = this.live;
    if (live) {
      const age = now - live.loadedAt;
      if (gen !== null && live.gen === gen && age < LIVE_SET_MAX_AGE_MS) return live;
      if (gen === null && age < LIVE_SET_FALLBACK_MS)
        return { gen: null, snapshots: live.snapshots };
    }
    // single-flight: параллельные запросы ждут одну загрузку из БД
    this.loading ??= this.loadLiveSnapshots(now).finally(() => {
      this.loading = null;
    });
    const snapshots = await this.loading;
    this.live = { gen, loadedAt: now, snapshots };
    return { gen, snapshots };
  }

  private async loadLiveSnapshots(now: number): Promise<LiveSnapshot[]> {
    const rows = await this.deps.prisma.publishedSnapshot.findMany({
      where: { state: 'published', endAt: { gt: new Date(now) } },
      select: {
        groupId: true,
        version: true,
        placement: true,
        priority: true,
        startAt: true,
        endAt: true,
        platforms: true,
        minAppVersionIos: true,
        minAppVersionAndroid: true,
        segmentIds: true,
        payload: true,
      },
    });
    return rows.map((r) => ({
      groupId: r.groupId,
      version: r.version,
      placement: r.placement,
      priority: r.priority,
      startAt: r.startAt.getTime(),
      endAt: r.endAt.getTime(),
      platforms: r.platforms,
      minAppVersionIos: r.minAppVersionIos,
      minAppVersionAndroid: r.minAppVersionAndroid,
      segmentIds: r.segmentIds,
      payload: r.payload as unknown as FeedGroup,
    }));
  }

  /** Для тестов и kill switch: забыть набор в памяти этого инстанса. */
  reset(): void {
    this.live = null;
  }
}

/** Сбрасывает кеш ленты во всех инстансах: новое поколение ключей. */
export async function bumpFeedGeneration(
  redis: Redis,
  keys: RedisKeys,
  logger: Logger,
): Promise<void> {
  try {
    await redis.incr(keys.feedGeneration);
  } catch (err) {
    // Без Redis изменения всё равно применятся: ответы живут в кеше не дольше 60 с.
    logger.error({ err }, 'Не удалось сбросить кеш ленты в Redis');
  }
}
