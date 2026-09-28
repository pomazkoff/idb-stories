import { FeedResponse } from '@idb-stories/schema';
import { getFeed } from '@idb-stories/schema/contracts';
import type { AppDeps } from '../../context.js';
import { AppError, badRequest } from '../../http/errors.js';
import { route } from '../../http/routes.js';
import { resolveCustomerSegments } from '../../services/customer-segments.js';

export function feedRoutes(deps: AppDeps) {
  return [
    route(getFeed, async ({ req, reply, query, headers }) => {
      const platform = headers['x-platform'];
      const appVersion = headers['x-app-version'] ?? null;
      if (platform !== 'web' && !appVersion) {
        throw badRequest(
          'Для iOS и Android обязателен заголовок X-App-Version',
          undefined,
          'app_version_required',
        );
      }
      const personalized = headers.authorization !== undefined;
      const userSegments = personalized
        ? await resolveCustomerSegments(deps, headers.authorization ?? '', req.log)
        : null;

      const result = await deps.feed.getFeed({
        placement: query.placement,
        platform,
        appVersion: platform === 'web' ? null : appVersion,
        userSegments,
      });

      if (deps.config.validateResponses) {
        const check = FeedResponse.safeParse(JSON.parse(result.body));
        if (!check.success)
          throw new AppError(
            500,
            'response_contract_violation',
            'Лента не соответствует контракту',
          );
      }

      // Персональный ответ никогда не кешируется на CDN и в браузере (угроза T6).
      void reply
        .header(
          'cache-control',
          personalized ? 'private, no-store' : `public, max-age=${result.ttlSec}`,
        )
        .header('vary', 'Authorization, X-Platform, X-App-Version')
        .header('x-feed-cache', result.cache)
        .type('application/json; charset=utf-8');
      return reply.send(result.body);
    }),
  ];
}
