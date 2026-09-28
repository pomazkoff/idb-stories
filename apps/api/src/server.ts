import type { FastifyInstance } from 'fastify';
import { mockAdapterNames } from '@idb-stories/adapters';
import { createAdminApp } from './app-admin.js';
import { createPublicApp } from './app-public.js';
import { loadConfig } from './config.js';
import { createDeps } from './context.js';
import { createMetricsApp } from './metrics.js';

const config = loadConfig();
const deps = createDeps(config);
const apps: FastifyInstance[] = [];

if (config.env === 'production') {
  const mocks = mockAdapterNames({
    env: config.env,
    customerAuth: config.customerAuth,
    segments: { provider: 'mock' },
    catalog: { provider: 'mock' },
    analytics: { provider: 'mock' },
    cdnPurge: { provider: 'mock' },
    siem: { provider: 'mock' },
  });
  if (mocks.length > 0)
    deps.logger.warn({ mocks }, 'В production работают mock-адаптеры интеграций ИДБ');
}

if (config.surfaces.includes('public')) {
  const app = await createPublicApp(deps);
  await app.listen({ host: config.host, port: config.publicPort });
  apps.push(app);
}
if (config.surfaces.includes('admin')) {
  const { app } = await createAdminApp(deps);
  await app.listen({ host: config.host, port: config.adminPort });
  apps.push(app);
}
const metrics = createMetricsApp();
await metrics.listen({ host: config.host, port: config.metricsPort });
apps.push(metrics);

deps.logger.info({ surfaces: config.surfaces }, 'API запущен');

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  deps.logger.info({ signal }, 'Остановка API');
  await Promise.allSettled(apps.map((a) => a.close()));
  await deps.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
