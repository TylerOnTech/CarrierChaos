import type { MockCarrierAdminClient } from '../carriers/mock-admin-client.js';
import type { JobService, SubmitJobInput } from '../jobs/job-service.js';
import type { CarrierStats } from '../mock-carrier/simulator.js';
import { seededRandom } from '../mock-carrier/prng.js';
import type { Logger } from '../shared/logger.js';
import type { Experiment, Prisma, PrismaClient } from '../shared/prisma.js';
import {
  CreateExperimentSchema,
  experimentPolicyId,
  resolvePlan,
  type ExperimentPlan,
} from './scenarios.js';
import { buildExperimentSummary, type ExperimentSummary, type SubmissionStats } from './summary.js';

interface StoredConfig {
  plan: ExperimentPlan;
  submission: SubmissionStats;
}

export class ExperimentNotFoundError extends Error {
  constructor(readonly experimentId: string) {
    super(`experiment ${experimentId} not found`);
    this.name = 'ExperimentNotFoundError';
  }
}

export class ExperimentSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExperimentSetupError';
  }
}

export interface ExperimentServiceOptions {
  prisma: PrismaClient;
  jobs: JobService;
  mockAdmin: MockCarrierAdminClient;
  logger: Logger;
  submitConcurrency?: number;
}

/**
 * Runs reproducible reliability experiments: configures the mock carrier's failure profile,
 * submits a deterministic batch of jobs through the normal JobService path (including
 * idempotency), and summarizes what actually happened from the recorded data.
 */
export class ExperimentService {
  constructor(private readonly options: ExperimentServiceOptions) {}

  async start(
    rawInput: unknown,
  ): Promise<{ experiment: Experiment; plan: ExperimentPlan; submission: SubmissionStats }> {
    const { prisma, mockAdmin, logger } = this.options;
    const plan = resolvePlan(CreateExperimentSchema.parse(rawInput));

    const replaySource = plan.replayDeadLetters ? await this.findReplaySource(plan) : null;

    // Configure fault injection first; this also resets the carrier's request counters, so the
    // fault sequence (and the upstream statistics) start from zero for this experiment.
    await mockAdmin.configure(plan.carrierId, {
      seed: plan.seed,
      faults: plan.faults,
      retryAfterSeconds: plan.retryAfterSeconds,
    });
    if (plan.control) await mockAdmin.configure(plan.control.carrierId, { seed: plan.seed });

    const experiment = await prisma.experiment.create({
      data: {
        scenario: plan.scenario,
        seed: plan.seed,
        config: { plan, submission: emptySubmission() } as unknown as Prisma.InputJsonValue,
      },
    });

    const replayedJobIds: string[] = [];
    if (replaySource) {
      const deadLettered = await prisma.job.findMany({
        where: { experimentId: replaySource, carrierId: plan.carrierId, status: 'dead_lettered' },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      for (const { id } of deadLettered) {
        await this.options.jobs.retry(id);
        replayedJobIds.push(id);
      }
    }

    const submissions = buildSubmissions(plan, experiment.id);
    let created = 0;
    let deduplicated = 0;
    await runWithConcurrency(submissions, this.options.submitConcurrency ?? 16, async (input) => {
      const result = await this.options.jobs.submit(input);
      if (result.created) created += 1;
      else deduplicated += 1;
    });

    const submission: SubmissionStats = {
      submissions: submissions.length,
      created,
      deduplicated,
      replayedJobIds,
    };
    const updated = await prisma.experiment.update({
      where: { id: experiment.id },
      data: { config: { plan, submission } as unknown as Prisma.InputJsonValue },
    });
    logger.info(
      {
        experimentId: experiment.id,
        scenario: plan.scenario,
        ...submission,
        replayedJobIds: replayedJobIds.length,
      },
      'experiment started',
    );
    return { experiment: updated, plan, submission };
  }

  /** Live summary; once every job is terminal the summary is frozen and stored. */
  async get(experimentId: string): Promise<ExperimentSummary> {
    const { prisma } = this.options;
    const experiment = await prisma.experiment.findUnique({ where: { id: experimentId } });
    if (!experiment) throw new ExperimentNotFoundError(experimentId);
    if (experiment.status === 'completed' && experiment.summary) {
      return experiment.summary as unknown as ExperimentSummary;
    }

    const { plan, submission } = experiment.config as unknown as StoredConfig;
    const jobs = await prisma.job.findMany({
      where: {
        OR: [{ experimentId }, { id: { in: submission.replayedJobIds } }],
      },
      select: {
        id: true,
        carrierId: true,
        policyId: true,
        status: true,
        circuitDeferrals: true,
        rateLimitDeferrals: true,
        enqueuedAt: true,
        runStartedAt: true,
        finishedAt: true,
        terminalReason: true,
      },
    });
    const jobIds = jobs.map((job) => job.id);
    const carrierIds = [plan.carrierId, ...(plan.control ? [plan.control.carrierId] : [])];

    const [attempts, transitions, policyRecords] = await Promise.all([
      prisma.jobAttempt.findMany({
        where: { jobId: { in: jobIds }, startedAt: { gte: experiment.startedAt } },
        select: { jobId: true, outcome: true, errorKind: true },
      }),
      prisma.circuitBreakerTransition.findMany({
        where: { carrierId: { in: carrierIds }, occurredAt: { gte: experiment.startedAt } },
        orderBy: { occurredAt: 'asc' },
      }),
      prisma.policyRecord.count({
        where: {
          OR: carrierIds.map((carrierId) => ({
            carrierId,
            policyId: { in: jobs.filter((j) => j.carrierId === carrierId).map((j) => j.policyId) },
          })),
        },
      }),
    ]);

    const draft = buildExperimentSummary({
      experiment,
      plan,
      submission,
      jobs,
      attempts,
      transitions: transitions.filter(
        (t) => !experiment.completedAt || t.occurredAt <= experiment.completedAt,
      ),
      policyRecords,
      now: new Date(),
    });
    if (draft.status !== 'completed') return draft;

    // Finalize: attach the mock carrier's own request counters and freeze the summary.
    // Transitions after the last job finished belong to whatever runs next, so they are cut off.
    const completedAt = new Date(draft.completedAt!);
    const upstream = await this.fetchUpstreamStats(carrierIds);
    const summary = buildExperimentSummary({
      experiment: { ...experiment, completedAt },
      plan,
      submission,
      jobs,
      attempts,
      transitions: transitions.filter((t) => t.occurredAt <= completedAt),
      policyRecords,
      upstream,
      now: new Date(),
    });
    await prisma.experiment.updateMany({
      where: { id: experimentId, status: 'running' },
      data: {
        status: 'completed',
        completedAt,
        summary: summary as unknown as Prisma.InputJsonValue,
      },
    });
    return summary;
  }

  private async findReplaySource(plan: ExperimentPlan): Promise<string | null> {
    if (plan.replayFromExperimentId) {
      const source = await this.options.prisma.experiment.findUnique({
        where: { id: plan.replayFromExperimentId },
      });
      if (!source)
        throw new ExperimentSetupError(`replay source ${plan.replayFromExperimentId} not found`);
      return source.id;
    }
    const latest = await this.options.prisma.experiment.findFirst({
      where: { scenario: 'outage' },
      orderBy: { startedAt: 'desc' },
    });
    return latest?.id ?? null;
  }

  private async fetchUpstreamStats(
    carrierIds: string[],
  ): Promise<Record<string, CarrierStats> | undefined> {
    try {
      const entries = await Promise.all(
        carrierIds.map(async (id) => [id, await this.options.mockAdmin.stats(id)] as const),
      );
      return Object.fromEntries(entries);
    } catch (error) {
      this.options.logger.warn({ err: error }, 'could not fetch mock carrier statistics');
      return undefined;
    }
  }
}

function emptySubmission(): SubmissionStats {
  return { submissions: 0, created: 0, deduplicated: 0, replayedJobIds: [] };
}

/**
 * The submission list for an experiment: primary jobs, optional control-carrier jobs, and
 * duplicate re-submissions of primary keys. The order is shuffled with the experiment seed so
 * duplicates race their originals, exercising the concurrent idempotency path.
 */
export function buildSubmissions(plan: ExperimentPlan, experimentId: string): SubmitJobInput[] {
  const primary: SubmitJobInput[] = Array.from({ length: plan.jobCount }, (_, i) => ({
    carrierId: plan.carrierId,
    policyId: experimentPolicyId(plan, i),
    idempotencyKey: `exp-${experimentId}-${i}`,
    maxAttempts: plan.maxAttempts ?? undefined,
    deadlineMs: plan.deadlineMs ?? undefined,
    experimentId,
  }));
  const control: SubmitJobInput[] = plan.control
    ? Array.from({ length: plan.control.jobCount }, (_, i) => ({
        carrierId: plan.control!.carrierId,
        policyId: experimentPolicyId(plan, i, true),
        idempotencyKey: `exp-${experimentId}-ctl-${i}`,
        experimentId,
      }))
    : [];
  const duplicates = primary
    .slice(0, Math.min(plan.duplicateSubmissions, primary.length))
    .map((s) => ({ ...s }));

  const all = [...primary, ...control, ...duplicates];
  const random = seededRandom('submission-order', plan.seed);
  for (let i = all.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [all[i], all[j]] = [all[j]!, all[i]!];
  }
  return all;
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next]!;
      next += 1;
      await task(item);
    }
  });
  await Promise.all(runners);
}
