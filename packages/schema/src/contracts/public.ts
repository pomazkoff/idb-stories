import { z } from 'zod';
import { LIMITS } from '../common.js';
import { ErrorResponse } from '../admin.js';
import { EventsAccepted, EventsBatch, StoryEvent } from '../events.js';
import { FeedHeaders, FeedQuery, FeedResponse } from '../feed.js';
import { defineContract } from './types.js';

export const HealthResponse = z
  .object({
    status: z.enum(['ok', 'degraded', 'fail']),
    checks: z.record(z.string(), z.enum(['ok', 'fail'])).optional(),
  })
  .meta({ id: 'Health' });

const error = (description: string) => ({ description, schema: ErrorResponse });

export const getFeed = defineContract({
  id: 'getFeed',
  method: 'GET',
  path: '/v1/feed',
  summary: 'Лента сторис для площадки',
  tags: ['feed'],
  auth: 'public',
  query: FeedQuery,
  headers: FeedHeaders,
  responses: {
    200: {
      description:
        'Опубликованная лента. Анонимно — Cache-Control: public, max-age<=60; с токеном — private, no-store.',
      schema: FeedResponse,
    },
    400: error('Не хватает заголовков X-Platform/X-App-Version или параметра placement'),
    429: error('Превышен лимит запросов'),
  },
});

export const postEvents = defineContract({
  id: 'postEvents',
  method: 'POST',
  path: '/v1/events',
  summary: 'Приём аналитических событий плееров',
  tags: ['events'],
  auth: 'public',
  body: EventsBatch,
  bodyDoc: z.object({ events: z.array(StoryEvent).min(1).max(LIMITS.eventsPerBatchMax) }),
  bodyLimit: LIMITS.eventsBodyMaxBytes,
  responses: {
    202: { description: 'Приняты валидные события, невалидные отброшены', schema: EventsAccepted },
    400: error('Тело не соответствует схеме батча'),
    413: error('Тело больше 64 КБ'),
    429: error('Превышен лимит запросов'),
  },
});

export const getHealth = defineContract({
  id: 'getHealth',
  method: 'GET',
  path: '/v1/health',
  summary: 'Readiness: API готов обслуживать запросы (без версий зависимостей)',
  tags: ['health'],
  auth: 'public',
  responses: {
    200: { description: 'Готов', schema: HealthResponse },
    503: { description: 'Не готов', schema: HealthResponse },
  },
});

export const getLiveness = defineContract({
  id: 'getLiveness',
  method: 'GET',
  path: '/v1/health/live',
  summary: 'Liveness: процесс жив',
  tags: ['health'],
  auth: 'public',
  responses: { 200: { description: 'Жив', schema: HealthResponse } },
});

export const publicContracts = [getFeed, postEvents, getHealth, getLiveness] as const;
