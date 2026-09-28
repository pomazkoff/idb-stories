import { getHealth, getLiveness } from '@idb-stories/schema/contracts';
import type { AppDeps } from '../../context.js';
import { route } from '../../http/routes.js';

async function check(fn: () => Promise<unknown>, timeoutMs = 1000): Promise<'ok' | 'fail'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
    return 'ok';
  } catch {
    return 'fail';
  } finally {
    clearTimeout(timer);
  }
}

/** Health без версий зависимостей (раздел 5.3). Без Redis лента работает в деградированном режиме. */
export function healthRoutes(deps: AppDeps) {
  return [
    route(getLiveness, () => Promise.resolve({ status: 'ok' as const })),
    route(getHealth, async ({ reply }) => {
      const [db, redis] = await Promise.all([
        check(() => deps.prisma.$queryRaw`SELECT 1`),
        check(() => deps.redis.ping()),
      ]);
      if (db === 'fail') reply.code(503);
      return {
        status: db === 'fail' ? 'fail' : redis === 'fail' ? 'degraded' : 'ok',
        checks: { db, redis },
      };
    }),
  ];
}
