import { StoryEvent } from '@idb-stories/schema';
import { postEvents } from '@idb-stories/schema/contracts';
import { eventsTotal, type EventsIngestJob } from '@idb-stories/core';
import type { AppDeps } from '../../context.js';
import { AppError } from '../../http/errors.js';
import { route } from '../../http/routes.js';

const DEDUP_TTL_SEC = 24 * 3600;

/**
 * Приём событий (раздел 5.2): каждое событие валидируется отдельно, невалидные отбрасываются,
 * дубли по event_id отсекаются в Redis (24 ч). Дальше — очередь: сырые события, агрегаты
 * и отправка в аналитику ИДБ с ретраями выполняются фоновыми задачами.
 */
export function eventsRoutes(deps: AppDeps) {
  return [
    route(postEvents, async ({ body, reply, req }) => {
      const valid: StoryEvent[] = [];
      let rejected = 0;
      for (const raw of body.events) {
        const parsed = StoryEvent.safeParse(raw);
        if (parsed.success) valid.push(parsed.data);
        else rejected += 1;
      }

      let fresh = valid;
      let dedupKeys: string[] = [];
      if (valid.length > 0) {
        try {
          const pipeline = deps.redis.multi();
          for (const e of valid)
            pipeline.set(deps.keys.eventDedup(e.event_id), '1', 'EX', DEDUP_TTL_SEC, 'NX');
          const results = await pipeline.exec();
          fresh = valid.filter((_, i) => results?.[i]?.[1] === 'OK');
          dedupKeys = fresh.map((e) => deps.keys.eventDedup(e.event_id));
        } catch (err) {
          // Без Redis дедупликация остаётся на уровне БД (event_id — первичный ключ).
          req.log.warn({ err }, 'Дедупликация событий недоступна');
        }
      }

      if (fresh.length > 0) {
        const job: EventsIngestJob = { receivedAt: deps.now().toISOString(), events: fresh };
        try {
          await deps.queues.eventsIngest.add('ingest', job);
        } catch (err) {
          if (dedupKeys.length > 0) await deps.redis.del(...dedupKeys).catch(() => undefined);
          req.log.error({ err }, 'Очередь событий недоступна');
          throw new AppError(503, 'unavailable', 'Приём событий временно недоступен');
        }
      }
      eventsTotal.inc({ result: 'accepted' }, valid.length);
      eventsTotal.inc({ result: 'duplicate' }, valid.length - fresh.length);
      eventsTotal.inc({ result: 'rejected' }, rejected);
      reply.code(202);
      return { accepted: valid.length, rejected };
    }),
  ];
}
