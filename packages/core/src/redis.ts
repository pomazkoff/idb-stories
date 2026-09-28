import { Redis } from 'ioredis';

export { Redis } from 'ioredis';

/**
 * cache — быстрый отказ: если Redis недоступен, лента и события деградируют, а не зависают.
 * queue — для BullMQ (требует maxRetriesPerRequest: null).
 */
export function createRedis(
  url: string,
  purpose: 'cache' | 'queue',
  onError?: (err: Error) => void,
): Redis {
  const client =
    purpose === 'queue'
      ? new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: false })
      : new Redis(url, {
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          connectTimeout: 2000,
          commandTimeout: 500,
          retryStrategy: (times) => Math.min(times * 200, 2000),
        });
  // Без обработчика ioredis пишет «Unhandled error event» на каждый реконнект.
  let lastReport = 0;
  client.on('error', (err: Error) => {
    const now = Date.now();
    if (now - lastReport < 10_000) return;
    lastReport = now;
    onError?.(err);
  });
  return client;
}

export type RedisKeys = ReturnType<typeof redisKeys>;

/** Все ключи Redis сервиса — в одном месте, с общим префиксом окружения. */
export function redisKeys(prefix: string) {
  return {
    prefix,
    bullPrefix: `${prefix}bull`,
    feedGeneration: `${prefix}feed:gen`,
    feedEnabled: `${prefix}settings:feed_enabled`,
    feedResponse: (generation: string, parts: string) =>
      `${prefix}feed:resp:${generation}:${parts}`,
    /** Кеш сегментов по sha256(user_id + соль) — никогда не по user_id (раздел 10.2). */
    userSegments: (userHash: string) => `${prefix}seg:${userHash}`,
    eventDedup: (eventId: string) => `${prefix}ev:${eventId}`,
    session: (sessionHash: string) => `${prefix}sess:${sessionHash}`,
    userSessions: (userId: string) => `${prefix}usess:${userId}`,
    loginState: (loginId: string) => `${prefix}login:${loginId}`,
    rateLimit: `${prefix}rl:`,
  };
}
