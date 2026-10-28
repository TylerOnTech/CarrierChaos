import { createServer } from 'node:http';
import { loadConfig, loadDotEnv } from '../config/env.js';
import { createLogger } from '../shared/logger.js';
import { createWorkerMetrics } from '../shared/metrics.js';
import { createPrismaClient } from '../shared/prisma.js';
import { createRedis } from '../shared/redis.js';
import { createWorkerRuntime } from './worker-runtime.js';

loadDotEnv();
const config = loadConfig();
const logger = createLogger({
  service: 'worker',
  level: config.logLevel,
  pretty: config.logPretty,
});
const prisma = createPrismaClient(config.databaseUrl);
const workerConnection = createRedis(config.redisUrl, { forWorker: true });
const redis = createRedis(config.redisUrl);
const metrics = createWorkerMetrics();

const runtime = createWorkerRuntime({ config, prisma, workerConnection, redis, logger, metrics });

// Minimal side server for Prometheus scraping and container health checks.
const server = createServer((req, res) => {
  if (req.url === '/metrics') {
    metrics.registry
      .metrics()
      .then((body) => {
        res.writeHead(200, { 'content-type': metrics.registry.contentType });
        res.end(body);
      })
      .catch(() => {
        res.writeHead(500);
        res.end();
      });
    return;
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', workerId: runtime.workerId }));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(config.ports.workerMetrics, () => {
  logger.info({ port: config.ports.workerMetrics }, 'worker metrics listening');
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'graceful shutdown requested');
  try {
    await runtime.close();
    server.close();
    await Promise.all([prisma.$disconnect(), workerConnection.quit(), redis.quit()]);
    logger.info('shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'error during shutdown');
    process.exit(1);
  }
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
