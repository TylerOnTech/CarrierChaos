import { Router } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '../../shared/prisma.js';

const Query = z.object({
  carrierId: z.string().min(1).optional(),
  state: z.enum(['open', 'replayed', 'all']).default('open'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Dead-letter inspection. Replay is `POST /jobs/:id/retry` (admin). */
export function deadLettersRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.get('/', async (req, res) => {
    const query = Query.parse(req.query);
    const entries = await prisma.deadLetter.findMany({
      where: {
        ...(query.carrierId ? { carrierId: query.carrierId } : {}),
        ...(query.state === 'open' ? { replayedAt: null } : {}),
        ...(query.state === 'replayed' ? { replayedAt: { not: null } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      include: { job: { select: { policyId: true, status: true, replayCount: true } } },
    });
    res.json({
      data: entries.map((entry) => ({
        id: entry.id,
        jobId: entry.jobId,
        carrierId: entry.carrierId,
        policyId: entry.job.policyId,
        run: entry.run,
        reason: entry.reason,
        errorKind: entry.errorKind,
        message: entry.message,
        attempts: entry.attempts,
        createdAt: entry.createdAt.toISOString(),
        replayedAt: entry.replayedAt?.toISOString() ?? null,
        currentJobStatus: entry.job.status,
        replay: { method: 'POST', path: `/jobs/${entry.jobId}/retry` },
      })),
    });
  });
  return router;
}
