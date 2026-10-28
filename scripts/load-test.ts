/**
 * Repeatable local load test.
 *
 *   npm run load-test -- --jobs 1000 --concurrency 50
 *
 * Methodology
 * 1. Puts every carrier's mock profile into a healthy state (20-60 ms latency, no faults), so the
 *    test measures the pipeline rather than injected failures.
 * 2. Submits N jobs through the real HTTP API (`POST /jobs`) from C concurrent clients,
 *    round-robin across carriers, recording each request's latency.
 * 3. Observes completion by polling PostgreSQL directly (not the API), so monitoring traffic
 *    does not distort API latency.
 * 4. Reports ingest throughput and latency, end-to-end latency, processing throughput, and the
 *    peak request rate each carrier actually saw, alongside the machine description.
 *
 * Throughput is intentionally bounded by the configured per-carrier rate limits; that is the
 * system doing its job. Results from a single local machine say nothing about production scale.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadDotEnv } from '../src/config/env.js';
import { MockCarrierAdminClient } from '../src/carriers/mock-admin-client.js';
import { distribution } from '../src/experiments/stats.js';
import { createPrismaClient } from '../src/shared/prisma.js';
import { ApiClient, arg, sleep } from './lib/api.js';
import { describeEnvironment, environmentMarkdown } from './lib/environment.js';

loadDotEnv();
const apiUrl = arg('api', process.env.API_URL ?? 'http://localhost:3000');
const mockUrl = arg('mock', process.env.MOCK_CARRIER_URL ?? 'http://localhost:4000');
const adminToken = process.env.ADMIN_TOKEN ?? 'dev-admin-token';
const totalJobs = Number(arg('jobs', '1000'));
const concurrency = Number(arg('concurrency', '50'));
const outDir = arg('out', 'docs/results');
const timeoutMs = Number(arg('timeout-ms', '300000'));

interface CarrierHealth {
  carriers: Array<{
    carrierId: string;
    concurrency: number;
    rateLimit: { capacity: number; refillPerSecond: number };
  }>;
}

async function main() {
  const api = new ApiClient({ baseUrl: apiUrl, adminToken });
  const mock = new MockCarrierAdminClient(mockUrl, adminToken);
  const prisma = createPrismaClient(process.env.DATABASE_URL ?? '');
  const runId = randomUUID().slice(0, 8);
  const environment = describeEnvironment();

  await api.get('/health');
  const { carriers } = await api.get<CarrierHealth>('/carriers/health');
  for (const carrier of carriers)
    await mock.configure(carrier.carrierId, { seed: 1, latencyMs: { min: 20, max: 60 } });

  console.log(
    `load test ${runId}: ${totalJobs} jobs, ${concurrency} concurrent clients, ${carriers.length} carriers`,
  );

  // --- Ingest -------------------------------------------------------------------------------
  const postLatencies: number[] = [];
  let next = 0;
  let failedSubmissions = 0;
  const ingestStart = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < totalJobs) {
        const i = next++;
        const carrier = carriers[i % carriers.length]!;
        const started = performance.now();
        try {
          await api.post(
            '/jobs',
            { carrierId: carrier.carrierId, policyId: `LOAD-${runId}-${i}` },
            { 'idempotency-key': `load-${runId}-${i}` },
          );
        } catch {
          failedSubmissions += 1;
        }
        postLatencies.push(performance.now() - started);
      }
    }),
  );
  const ingestSeconds = (performance.now() - ingestStart) / 1000;
  console.log(
    `submitted in ${ingestSeconds.toFixed(2)}s (${(totalJobs / ingestSeconds).toFixed(0)} req/s)`,
  );

  // --- Completion ---------------------------------------------------------------------------
  const where = { idempotencyKey: { startsWith: `load-${runId}-` } };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const terminal = await prisma.job.count({
      where: { ...where, status: { in: ['completed', 'failed', 'dead_lettered', 'cancelled'] } },
    });
    process.stdout.write(`\r${terminal}/${totalJobs} terminal`);
    if (terminal >= totalJobs - failedSubmissions) break;
    if (Date.now() > deadline) throw new Error('load test timed out waiting for jobs to finish');
    await sleep(500);
  }
  process.stdout.write('\n');

  const jobs = await prisma.job.findMany({
    where,
    select: {
      status: true,
      carrierId: true,
      enqueuedAt: true,
      runStartedAt: true,
      finishedAt: true,
      attempts: true,
      rateLimitDeferrals: true,
    },
  });
  const upstream = Object.fromEntries(
    await Promise.all(
      carriers.map(async (c) => [c.carrierId, await mock.stats(c.carrierId)] as const),
    ),
  );
  await prisma.$disconnect();

  const firstEnqueue = Math.min(...jobs.map((j) => j.enqueuedAt.getTime()));
  const lastFinish = Math.max(...jobs.map((j) => j.finishedAt?.getTime() ?? 0));
  const statusCounts = jobs.reduce<Record<string, number>>(
    (acc, j) => ({ ...acc, [j.status]: (acc[j.status] ?? 0) + 1 }),
    {},
  );
  const r = (v: number | null) => (v === null ? null : Math.round(v));
  const round = (d: ReturnType<typeof distribution>) => ({
    count: d.count,
    p50: r(d.p50),
    p95: r(d.p95),
    p99: r(d.p99),
    max: r(d.max),
    mean: r(d.mean),
  });

  const report = {
    runId,
    environment,
    parameters: { totalJobs, concurrency, carriers },
    ingest: {
      seconds: Number(ingestSeconds.toFixed(2)),
      requestsPerSecond: Math.round(totalJobs / ingestSeconds),
      failedSubmissions,
      latencyMs: round(distribution(postLatencies)),
    },
    processing: {
      statusCounts,
      wallClockSeconds: Number(((lastFinish - firstEnqueue) / 1000).toFixed(2)),
      jobsPerSecond: Number((jobs.length / ((lastFinish - firstEnqueue) / 1000)).toFixed(1)),
      queueWaitMs: distribution(
        jobs
          .filter((j) => j.runStartedAt)
          .map((j) => j.runStartedAt!.getTime() - j.enqueuedAt.getTime()),
      ),
      endToEndMs: distribution(
        jobs
          .filter((j) => j.finishedAt)
          .map((j) => j.finishedAt!.getTime() - j.enqueuedAt.getTime()),
      ),
      totalAttempts: jobs.reduce((n, j) => n + j.attempts, 0),
      rateLimitWaits: jobs.reduce((n, j) => n + j.rateLimitDeferrals, 0),
    },
    upstream: Object.fromEntries(
      Object.entries(upstream).map(([id, s]) => [
        id,
        {
          requests: s.requests,
          peakRequestsPerSecond: s.peakRequestsPerSecond,
          maxConcurrent: s.maxInFlight,
        },
      ]),
    ),
  };

  mkdirSync(outDir, { recursive: true });
  const stamp = environment.timestamp.replace(/[:.]/g, '-');
  writeFileSync(join(outDir, `load-test-${stamp}.json`), JSON.stringify(report, null, 2));

  const d = (x: {
    p50: number | null;
    p95: number | null;
    p99: number | null;
    max: number | null;
  }) => `${x.p50} / ${x.p95} / ${x.p99} / ${x.max} ms`;
  const markdown = [
    '# Load test results',
    '',
    'Generated by `npm run load-test`. Methodology: docs/load-testing.md. A single local run;',
    'these figures describe this machine and configuration only, not production capacity.',
    '',
    '## Environment',
    '',
    environmentMarkdown(environment, {
      parameters: `${totalJobs} jobs, ${concurrency} concurrent HTTP clients`,
      carriers: carriers
        .map(
          (c) =>
            `${c.carrierId} (concurrency ${c.concurrency}, ${c.rateLimit.refillPerSecond}/s burst ${c.rateLimit.capacity})`,
        )
        .join('; '),
      'mock latency': '20-60 ms, no injected faults',
    }),
    '',
    '## Results',
    '',
    '| Metric | Value |',
    '|---|---|',
    `| Ingest: POST /jobs throughput | ${report.ingest.requestsPerSecond} req/s over ${report.ingest.seconds} s |`,
    `| Ingest: POST /jobs latency p50 / p95 / p99 / max | ${d(report.ingest.latencyMs)} |`,
    `| Failed submissions | ${failedSubmissions} |`,
    `| Final job states | ${Object.entries(statusCounts)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')} |`,
    `| Processing wall clock (first enqueue → last finish) | ${report.processing.wallClockSeconds} s |`,
    `| Processing throughput | ${report.processing.jobsPerSecond} jobs/s |`,
    `| Queue wait p50 / p95 / p99 / max | ${d(report.processing.queueWaitMs)} |`,
    `| End-to-end p50 / p95 / p99 / max | ${d(report.processing.endToEndMs)} |`,
    `| Upstream attempts | ${report.processing.totalAttempts} |`,
    `| Rate-limit waits (in-process or deferred) | ${report.processing.rateLimitWaits} |`,
    ...Object.entries(report.upstream).map(
      ([id, s]) =>
        `| ${id}: requests · peak req/s · max concurrent | ${s.requests} · ${s.peakRequestsPerSecond} · ${s.maxConcurrent} |`,
    ),
    '',
  ].join('\n');
  writeFileSync(join(outDir, 'LOAD_TEST.md'), markdown);
  console.log(`\n${markdown}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
