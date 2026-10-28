import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { JOB_STATUSES } from '../../jobs/job-states.js';
import { toJobDto } from '../../jobs/job-dto.js';
import type { JobService } from '../../jobs/job-service.js';
import { ApiError } from '../errors.js';

const SubmitJobBody = z
  .object({
    carrierId: z.string().min(1).max(64),
    policyId: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,64}$/, 'policyId must be 1-64 characters of [A-Za-z0-9._-]'),
    maxAttempts: z.number().int().min(1).max(20).optional(),
    deadlineMs: z.number().int().min(1000).max(86_400_000).optional(),
    idempotencyKey: z.string().min(1).max(200).optional(),
  })
  .strict();

const ListJobsQuery = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  carrierId: z.string().min(1).optional(),
  experimentId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
});

const JobIdParam = z.object({ id: z.uuid({ message: 'job id must be a UUID' }) });

export function jobsRouter(jobs: JobService, requireAdmin: RequestHandler): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    const body = SubmitJobBody.parse(req.body ?? {});
    const headerKey = req.get('idempotency-key');
    if (
      headerKey !== undefined &&
      body.idempotencyKey !== undefined &&
      headerKey !== body.idempotencyKey
    ) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        'Idempotency-Key header and body idempotencyKey differ',
      );
    }
    const idempotencyKey = headerKey ?? body.idempotencyKey;
    if (!idempotencyKey) {
      throw new ApiError(
        400,
        'IDEMPOTENCY_KEY_REQUIRED',
        'an Idempotency-Key header (or idempotencyKey field) is required',
      );
    }
    if (idempotencyKey.length > 200) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Idempotency-Key must be at most 200 characters');
    }

    const { job, created } = await jobs.submit({
      carrierId: body.carrierId,
      policyId: body.policyId,
      maxAttempts: body.maxAttempts,
      deadlineMs: body.deadlineMs,
      idempotencyKey,
    });
    res
      .status(created ? 202 : 200)
      .location(`/jobs/${job.id}`)
      .set('Idempotent-Replayed', String(!created))
      .json(toJobDto(job));
  });

  router.get('/', async (req, res) => {
    const query = ListJobsQuery.parse(req.query);
    const { items, nextCursor } = await jobs.list(query);
    res.json({ data: items.map((job) => toJobDto(job)), nextCursor });
  });

  router.get('/:id', async (req, res) => {
    const { id } = JobIdParam.parse(req.params);
    const job = await jobs.get(id);
    if (!job) throw new ApiError(404, 'NOT_FOUND', `job ${id} not found`);
    res.json(toJobDto(job));
  });

  router.post('/:id/retry', requireAdmin, async (req, res) => {
    const { id } = JobIdParam.parse(req.params);
    const job = await jobs.retry(id);
    res.status(202).json(toJobDto(job));
  });

  router.post('/:id/cancel', requireAdmin, async (req, res) => {
    const { id } = JobIdParam.parse(req.params);
    const { job, outcome } = await jobs.cancel(id);
    res.status(outcome === 'cancel_requested' ? 202 : 200).json({ outcome, job: toJobDto(job) });
  });

  return router;
}
