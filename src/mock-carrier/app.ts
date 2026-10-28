import { randomUUID } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAdminToken } from '../shared/admin-auth.js';
import { buildSchemaViolation, buildSyntheticPolicy } from './policy-factory.js';
import { CarrierRegistry, type CarrierSimulator } from './simulator.js';
import type { FaultDecision } from './failure-profile.js';

/**
 * Simulated insurance carrier API.
 *
 *   POST /carriers/:carrierId/oauth/token          client-credentials token
 *   GET  /carriers/:carrierId/policies/:policyId   NormalizedPolicy v1 (or an injected fault)
 *   GET  /admin/carriers[/:carrierId]              profile + live statistics      (admin)
 *   PUT  /admin/carriers/:carrierId/profile        replace failure profile        (admin)
 *   POST /admin/carriers/:carrierId/reset          reset counters and statistics  (admin)
 *
 * Policy IDs starting with `MISSING-` always return 404, which gives tests a permanent failure.
 */
export interface MockCarrierOptions {
  adminToken: string;
  clock?: () => number;
}

export function createMockCarrierApp(options: MockCarrierOptions) {
  const registry = new CarrierRegistry(options.clock);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.post('/carriers/:carrierId/oauth/token', (req, res) => {
    const carrierId = req.params.carrierId;
    const body = z
      .object({ client_id: z.string().min(1), client_secret: z.string().min(1) })
      .safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    if (body.data.client_secret.startsWith('revoked')) {
      res.status(401).json({ error: 'invalid_client' });
      return;
    }
    res.json({
      access_token: `mock.${carrierId}.${randomUUID()}`,
      token_type: 'Bearer',
      expires_in: 3600,
    });
  });

  app.get('/carriers/:carrierId/policies/:policyId', async (req, res) => {
    const { carrierId, policyId } = req.params;
    const carrier = registry.get(carrierId);
    carrier.enter();
    res.on('close', () => carrier.exit());

    if (!req.headers.authorization?.startsWith(`Bearer mock.${carrierId}.`)) {
      carrier.countRequest();
      carrier.recordOutcome('unauthorized');
      res.status(401).json({ error: 'invalid_token' });
      return;
    }

    if (policyId.startsWith('MISSING-')) {
      carrier.countRequest();
      carrier.recordOutcome('not_found');
      await waitWhileConnected(res, 5);
      res.status(404).json({ error: 'policy_not_found', policyId });
      return;
    }

    const decision = carrier.nextDecision(policyId);
    res.setHeader('x-mock-outcome', decision.outcome);
    await serveDecision(carrier, decision, policyId, res);
  });

  const admin = express.Router();
  admin.use(
    requireAdminToken(options.adminToken, (res) => {
      res.status(401).json({ error: 'unauthorized' });
    }),
  );

  admin.get('/carriers', (_req, res) => {
    res.json({ carriers: registry.list().map(describe) });
  });

  admin.get('/carriers/:carrierId', (req, res) => {
    res.json(describe(registry.get(req.params.carrierId)));
  });

  admin.put('/carriers/:carrierId/profile', (req: Request<{ carrierId: string }>, res) => {
    try {
      const carrier = registry.get(req.params.carrierId);
      carrier.configure(req.body as never);
      res.json(describe(carrier));
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'invalid_profile', issues: error.issues });
        return;
      }
      throw error;
    }
  });

  admin.post('/carriers/:carrierId/reset', (req, res) => {
    const carrier = registry.get(req.params.carrierId);
    carrier.reset();
    res.json(describe(carrier));
  });

  app.use('/admin', admin);

  return { app, registry };
}

function describe(carrier: CarrierSimulator) {
  return { carrierId: carrier.carrierId, profile: carrier.getProfile(), stats: carrier.getStats() };
}

async function serveDecision(
  carrier: CarrierSimulator,
  decision: FaultDecision,
  policyId: string,
  res: Response,
): Promise<void> {
  const profile = carrier.getProfile();
  const retryAfter =
    profile.retryAfterSeconds === null ? undefined : String(profile.retryAfterSeconds);

  switch (decision.outcome) {
    case 'ok':
    case 'slow': {
      const delay = decision.outcome === 'slow' ? profile.slowResponseMs : decision.latencyMs;
      if (!(await waitWhileConnected(res, delay))) return;
      carrier.recordOutcome(decision.outcome, policyId);
      res.status(200).json(buildSyntheticPolicy(carrier.carrierId, policyId));
      return;
    }
    case 'timeout': {
      // Hang without answering; the server eventually drops the connection.
      carrier.recordOutcome('timeout');
      if (await waitWhileConnected(res, profile.hangMs)) res.socket?.destroy();
      return;
    }
    case 'connection_reset': {
      if (!(await waitWhileConnected(res, decision.latencyMs))) return;
      carrier.recordOutcome('connection_reset');
      const body = JSON.stringify(buildSyntheticPolicy(carrier.carrierId, policyId));
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });
      // Send part of the body, then kill the socket mid-response.
      res.write(body.slice(0, Math.floor(body.length / 3)), () => res.socket?.destroy());
      return;
    }
    case 'invalid_json': {
      if (!(await waitWhileConnected(res, decision.latencyMs))) return;
      carrier.recordOutcome('invalid_json');
      const body =
        decision.random() < 0.5
          ? '<html><body><h1>502 Bad Gateway</h1></body></html>'
          : JSON.stringify(buildSyntheticPolicy(carrier.carrierId, policyId)).slice(0, 120);
      res.status(200).type('application/json').send(body);
      return;
    }
    case 'schema_violation': {
      if (!(await waitWhileConnected(res, decision.latencyMs))) return;
      carrier.recordOutcome('schema_violation');
      const policy = buildSyntheticPolicy(carrier.carrierId, policyId);
      res.status(200).json(buildSchemaViolation(policy, decision.random));
      return;
    }
    case 'rate_limit':
    case 'unavailable':
    case 'server_error':
    case 'auth_error': {
      if (!(await waitWhileConnected(res, decision.latencyMs))) return;
      carrier.recordOutcome(decision.outcome);
      sendError(res, decision.outcome, retryAfter);
      return;
    }
  }
}

function sendError(
  res: Response,
  outcome: 'rate_limit' | 'unavailable' | 'server_error' | 'auth_error',
  retryAfter: string | undefined,
): void {
  if (outcome === 'rate_limit') {
    if (retryAfter !== undefined) res.setHeader('retry-after', retryAfter);
    res.status(429).json({ error: 'rate_limited' });
  } else if (outcome === 'unavailable') {
    if (retryAfter !== undefined) res.setHeader('retry-after', retryAfter);
    res.status(503).json({ error: 'service_unavailable' });
  } else if (outcome === 'server_error') {
    res.status(500).json({ error: 'internal_error' });
  } else {
    res.setHeader('www-authenticate', 'Bearer error="invalid_token"');
    res.status(401).json({ error: 'token_expired' });
  }
}

/** Waits `ms`, resolving early with `false` if the client disconnects first. */
function waitWhileConnected(res: Response, ms: number): Promise<boolean> {
  if (res.destroyed) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onClose = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      res.off('close', onClose);
      resolve(!res.destroyed);
    }, ms);
    res.once('close', onClose);
  });
}
