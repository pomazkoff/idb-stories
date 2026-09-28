import { createHash } from 'node:crypto';
import { randomToken } from '@idb-stories/adapters';
import type { Redis, RedisKeys } from '@idb-stories/core';

export interface SessionData {
  userId: string;
  csrfToken: string;
  createdAt: number;
  lastSeenAt: number;
  ip: string | null;
}

/** Обновлять TTL не чаще, чем раз в 30 с: idle-timeout точен до этой величины. */
const TOUCH_INTERVAL_MS = 30_000;

const hashId = (sid: string) => createHash('sha256').update(sid).digest('hex');

/**
 * Серверные сессии админки в Redis (раздел 10.2). В cookie — случайный идентификатор (256 бит),
 * в Redis — только его sha256, так что дамп Redis не даёт готовых сессий.
 * Idle-timeout — TTL ключа, абсолютный — проверка createdAt.
 */
export class SessionStore {
  constructor(
    private readonly redis: Redis,
    private readonly keys: RedisKeys,
    private readonly idleSec: number,
    private readonly absoluteSec: number,
    private readonly now: () => number = Date.now,
  ) {}

  async create(userId: string, ip: string | null): Promise<{ sid: string; data: SessionData }> {
    const sid = randomToken(32);
    const now = this.now();
    const data: SessionData = {
      userId,
      csrfToken: randomToken(32),
      createdAt: now,
      lastSeenAt: now,
      ip,
    };
    const key = this.keys.session(hashId(sid));
    const userKey = this.keys.userSessions(userId);
    await this.redis
      .multi()
      .set(key, JSON.stringify(data), 'EX', this.idleSec)
      .sadd(userKey, hashId(sid))
      .expire(userKey, this.absoluteSec)
      .exec();
    return { sid, data };
  }

  async get(sid: string): Promise<SessionData | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(sid)) return null;
    const raw = await this.redis.get(this.keys.session(hashId(sid)));
    if (!raw) return null;
    const data = JSON.parse(raw) as SessionData;
    const now = this.now();
    if (
      now - data.createdAt > this.absoluteSec * 1000 ||
      now - data.lastSeenAt > this.idleSec * 1000
    ) {
      await this.destroy(sid, data.userId);
      return null;
    }
    if (now - data.lastSeenAt > TOUCH_INTERVAL_MS) {
      data.lastSeenAt = now;
      const ttl = Math.min(
        this.idleSec,
        Math.ceil((data.createdAt + this.absoluteSec * 1000 - now) / 1000),
      );
      await this.redis.set(
        this.keys.session(hashId(sid)),
        JSON.stringify(data),
        'EX',
        Math.max(ttl, 1),
      );
    }
    return data;
  }

  expiresAt(data: SessionData): Date {
    return new Date(
      Math.min(data.lastSeenAt + this.idleSec * 1000, data.createdAt + this.absoluteSec * 1000),
    );
  }

  async destroy(sid: string, userId?: string): Promise<void> {
    const h = hashId(sid);
    await this.redis.del(this.keys.session(h));
    if (userId) await this.redis.srem(this.keys.userSessions(userId), h);
  }

  /** Все сессии пользователя (блокировка, смена ролей администратором). */
  async destroyAllForUser(userId: string): Promise<void> {
    const userKey = this.keys.userSessions(userId);
    const hashes = await this.redis.smembers(userKey);
    const pipeline = this.redis.multi();
    for (const h of hashes) pipeline.del(this.keys.session(h));
    pipeline.del(userKey);
    await pipeline.exec();
  }
}
