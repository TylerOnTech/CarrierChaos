import { randomUUID } from 'node:crypto';
import express, { type Express, type RequestHandler } from 'express';
import { pinoHttp } from 'pino-http';
import type { ExperimentService } from '../experiments/experiment-service.js';
import type { JobService } from '../jobs/job-service.js';
import { requireAdminToken } from '../shared/admin-auth.js';
import type { Logger } from '../shared/logger.js';
import type { ApiMetrics } from '../shared/metrics.js';
import type { PrismaClient } from '../shared/prisma.js';
import { errorHandler, notFoundHandler, sendError } from './errors.js';
import { deadLettersRouter } from './routes/dead-letters.js';
import { experimentsRouter } from './routes/experiments.js';
import { jobsRouter } from './routes/jobs.js';

export interface AppDeps {
  logger: Logger;
  adminToken: string;
  prisma: PrismaClient;
  jobs: JobService;
  experiments: ExperimentService;
  metrics: ApiMetrics;
  health: () => Promise<{ status: 'ok' | 'degraded' }>;
  carrierHealth: () => Promise<unknown>;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');

  app.use(
    pinoHttp({
      logger: deps.logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id =
          typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)
            ? incoming
            : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === '/metrics' || req.url === '/health' },
      customLogLevel: (_req, res, error) =>
        error || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
    }),
  );
  app.use(httpMetrics(deps.metrics));
  app.use(express.json({ limit: '100kb' }));

  const requireAdmin = requireAdminToken(deps.adminToken, (res) =>
    sendError(
      res,
      401,
      'UNAUTHORIZED',
      'a valid admin token is required (Authorization: Bearer <ADMIN_TOKEN>)',
    ),
  );

  app.get('/health', async (_req, res) => {
    const report = await deps.health();
    res.status(report.status === 'ok' ? 200 : 503).json(report);
  });

  app.get('/metrics', async (_req, res) => {
    res.type(deps.metrics.registry.contentType).send(await deps.metrics.registry.metrics());
  });

  app.get('/carriers/health', async (_req, res) => {
    res.json(await deps.carrierHealth());
  });

  app.use('/jobs', jobsRouter(deps.jobs, requireAdmin));
  app.use('/dead-letters', deadLettersRouter(deps.prisma));
  app.use('/experiments', experimentsRouter(deps.experiments, requireAdmin));

  app.use(notFoundHandler);
  app.use(errorHandler(deps.logger));
  return app;
}

function httpMetrics(metrics: ApiMetrics): RequestHandler {
  return (req, res, next) => {
    const stop = metrics.httpDuration.startTimer();
    res.on('finish', () => {
      // Use the matched route pattern, not the raw URL, to keep label cardinality bounded.
      const route = req.route
        ? `${req.baseUrl}${String((req.route as { path: string }).path)}`
        : 'unmatched';
      stop({ method: req.method, route });
      metrics.httpRequests.inc({ method: req.method, route, status: String(res.statusCode) });
    });
    next();
  };
}
