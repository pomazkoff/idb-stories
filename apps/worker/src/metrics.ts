import { createServer, type Server } from 'node:http';
import { coreRegistry, prometheus } from '@idb-stories/core';

export const workerRegistry = new prometheus.Registry();

/** /metrics на внутреннем порту (без внешней публикации). */
export function startMetricsServer(port: number, prefix: string): Server {
  prometheus.collectDefaultMetrics({ register: workerRegistry, prefix });
  const registry = prometheus.Registry.merge([workerRegistry, coreRegistry]);
  const server = createServer((req, res) => {
    if (req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    registry
      .metrics()
      .then((body) => res.writeHead(200, { 'content-type': registry.contentType }).end(body))
      .catch(() => res.writeHead(500).end());
  });
  server.listen(port);
  return server;
}
