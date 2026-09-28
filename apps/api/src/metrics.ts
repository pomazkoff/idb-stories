import Fastify, { type FastifyInstance } from 'fastify';
import { coreRegistry, prometheus } from '@idb-stories/core';
import { httpRegistry } from './http/base-app.js';
import { customerMetrics } from './services/customer-segments.js';

const appRegistry = new prometheus.Registry();
prometheus.collectDefaultMetrics({ register: appRegistry, prefix: 'stories_api_' });
for (const m of customerMetrics) appRegistry.registerMetric(m);

/** /metrics на отдельном внутреннем порту: наружу через ingress не публикуется. */
export function createMetricsApp(): FastifyInstance {
  const registry = prometheus.Registry.merge([appRegistry, httpRegistry, coreRegistry]);
  const app = Fastify({ logger: false });
  app.get('/metrics', async (_req, reply) => {
    return reply.type(registry.contentType).send(await registry.metrics());
  });
  return app;
}
