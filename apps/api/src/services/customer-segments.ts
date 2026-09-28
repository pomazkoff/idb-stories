import { createHash } from 'node:crypto';
import { withTimeout } from '@idb-stories/adapters';
import { adapterErrorsTotal, prometheus } from '@idb-stories/core';
import type { FastifyBaseLogger } from 'fastify';
import type { AppDeps } from '../context.js';

/** Сегменты кешируются максимум на 5 минут (раздел 10.2). */
const SEGMENTS_TTL_SEC = 300;
const ADAPTER_TIMEOUT_MS = 800;
const BEARER_RE = /^Bearer\s+([A-Za-z0-9._~+/=-]{10,8000})$/i;

const invalidTokens = new prometheus.Counter({
  name: 'stories_customer_token_invalid_total',
  help: 'Невалидные токены покупателей в /v1/feed',
});
export const customerMetrics = [invalidTokens];

/**
 * Сегменты покупателя по токену (раздел 5.1, шаг 3; угрозы T6, T12).
 * Возвращает null, если токен невалиден или адаптеры недоступны: тогда отдаётся только
 * лента без сегментов. Токен и user_id не логируются и не сохраняются; ключ кеша —
 * sha256(user_id + соль).
 */
export async function resolveCustomerSegments(
  deps: AppDeps,
  authorization: string,
  log: FastifyBaseLogger,
): Promise<string[] | null> {
  const token = BEARER_RE.exec(authorization)?.[1];
  if (!token) {
    invalidTokens.inc();
    return null;
  }
  let identity: { userId: string } | null;
  try {
    identity = await withTimeout('customer-auth', ADAPTER_TIMEOUT_MS, () =>
      deps.adapters.customerAuth.verify(token),
    );
  } catch (err) {
    adapterErrorsTotal.inc({ adapter: 'customer-auth' });
    log.warn({ err }, 'Адаптер авторизации покупателей недоступен');
    return null;
  }
  if (!identity) {
    invalidTokens.inc();
    return null;
  }

  const userHash = createHash('sha256')
    .update(`${identity.userId}\u0000${deps.config.public.segmentsCacheSalt}`)
    .digest('hex');
  const key = deps.keys.userSegments(userHash);
  try {
    const cached = await deps.redis.get(key);
    if (cached) return JSON.parse(cached) as string[];
  } catch {
    // кеш недоступен — идём в адаптер
  }
  try {
    const segments = await withTimeout('segments', ADAPTER_TIMEOUT_MS, () =>
      deps.adapters.segments.getUserSegments(identity.userId),
    );
    await deps.redis
      .set(key, JSON.stringify(segments), 'EX', SEGMENTS_TTL_SEC)
      .catch(() => undefined);
    return segments;
  } catch (err) {
    adapterErrorsTotal.inc({ adapter: 'segments' });
    log.warn({ err }, 'Адаптер сегментов недоступен');
    return null;
  }
}
