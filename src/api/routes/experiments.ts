import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { ExperimentService } from '../../experiments/experiment-service.js';

const IdParam = z.object({ id: z.uuid({ message: 'experiment id must be a UUID' }) });

export function experimentsRouter(
  experiments: ExperimentService,
  requireAdmin: RequestHandler,
): Router {
  const router = Router();

  router.post('/', requireAdmin, async (req, res) => {
    const { experiment, plan, submission } = await experiments.start(req.body ?? {});
    res
      .status(202)
      .location(`/experiments/${experiment.id}`)
      .json({
        id: experiment.id,
        status: experiment.status,
        startedAt: experiment.startedAt.toISOString(),
        plan,
        submission: {
          ...submission,
          replayedJobs: submission.replayedJobIds.length,
          replayedJobIds: undefined,
        },
      });
  });

  router.get('/:id', async (req, res) => {
    const { id } = IdParam.parse(req.params);
    res.json(await experiments.get(id));
  });

  return router;
}
