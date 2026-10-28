/**
 * Runs the reliability experiments (A-D) against a running stack and records the results.
 *
 *   npm run experiments
 *   npm run experiments -- --scenarios healthy,intermittent --seed 7 --out docs/results
 *
 * Each experiment is submitted through `POST /experiments`, polled until every job reaches a
 * terminal state, and the frozen summary is written to <out>/experiments-<timestamp>.json and
 * <out>/EXPERIMENTS.md. All numbers come from the API's recorded data and the mock carrier's own
 * request counters; nothing is estimated.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExperimentSummary } from '../src/experiments/summary.js';
import { ApiClient, arg, sleep } from './lib/api.js';
import { describeEnvironment, environmentMarkdown } from './lib/environment.js';

const apiUrl = arg('api', process.env.API_URL ?? 'http://localhost:3000');
const adminToken = process.env.ADMIN_TOKEN ?? 'dev-admin-token';
const seed = Number(arg('seed', '42'));
const scenarios = arg('scenarios', 'healthy,intermittent,outage,recovery').split(',');
const outDir = arg('out', 'docs/results');
const api = new ApiClient({ baseUrl: apiUrl, adminToken });

interface CarrierHealth {
  carriers: Array<{
    carrierId: string;
    concurrency: number;
    rateLimit: { capacity: number; refillPerSecond: number };
  }>;
}

async function runScenario(
  scenario: string,
  extra: Record<string, unknown>,
): Promise<ExperimentSummary> {
  const started = await api.post<{ id: string }>('/experiments', { scenario, seed, ...extra });
  process.stdout.write(`\n▶ ${scenario} (experiment ${started.id})\n`);
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    const summary = await api.get<ExperimentSummary>(`/experiments/${started.id}`);
    const done = Object.values(summary.carriers).reduce(
      (n, c) => n + c.jobs.total - c.jobs.inFlight,
      0,
    );
    process.stdout.write(
      `\r  ${done}/${summary.totals.jobs} jobs terminal, ${(summary.durationMs / 1000).toFixed(1)}s   `,
    );
    if (summary.status === 'completed') {
      process.stdout.write('\n');
      return summary;
    }
    if (Date.now() > deadline)
      throw new Error(`experiment ${started.id} did not finish within 5 minutes`);
    await sleep(500);
  }
}

const ms = (value: number | null) => (value === null ? 'n/a' : `${value} ms`);
const pct = (value: number | null) => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
const counts = (record: Record<string, number>) =>
  Object.keys(record).length === 0
    ? 'none'
    : Object.entries(record)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v}`)
        .join(', ');

function experimentMarkdown(summary: ExperimentSummary): string {
  const carriers = Object.entries(summary.carriers);
  const header = `| Metric | ${carriers.map(([id, c]) => `${id} (${c.role})`).join(' | ')} |`;
  const divider = `|---|${carriers.map(() => '---').join('|')}|`;
  const row = (label: string, render: (c: (typeof carriers)[number][1]) => string) =>
    `| ${label} | ${carriers.map(([, c]) => render(c)).join(' | ')} |`;

  const transitions = (c: (typeof carriers)[number][1]) =>
    c.circuitBreaker.transitions.length === 0
      ? 'none'
      : c.circuitBreaker.transitions
          .map((t) => `${t.from}→${t.to} @${(t.atMs / 1000).toFixed(2)}s`)
          .join('<br>');

  return [
    `### ${summary.title}`,
    '',
    summary.description,
    '',
    `Experiment \`${summary.experimentId}\`, seed ${summary.seed}, wall-clock ${(summary.durationMs / 1000).toFixed(2)} s. ` +
      `Faults: \`${JSON.stringify(summary.config.faults)}\`` +
      (summary.config.maxAttempts ? `, maxAttempts ${summary.config.maxAttempts}` : '') +
      (summary.config.deadlineMs ? `, deadline ${summary.config.deadlineMs} ms` : '') +
      (summary.config.replayedDeadLetters
        ? `, replayed dead letters ${summary.config.replayedDeadLetters}`
        : '') +
      '.',
    '',
    header,
    divider,
    row('Jobs', (c) => String(c.jobs.total)),
    row(
      'Completed / failed / dead-lettered',
      (c) => `${c.jobs.completed} / ${c.jobs.failed} / ${c.jobs.deadLettered}`,
    ),
    row('Success rate', (c) => pct(c.successRate)),
    row('Upstream attempts (retries)', (c) => `${c.attempts.total} (${c.attempts.retries})`),
    row('Jobs that needed a retry', (c) => String(c.attempts.jobsRetried)),
    row('Max attempts for one job', (c) => String(c.attempts.maxPerJob)),
    row(
      'Circuit-open deferrals / rate-limit waits',
      (c) => `${c.deferrals.circuitOpen} / ${c.deferrals.rateLimited}`,
    ),
    row(
      'Queue wait p50 / p95 / max',
      (c) =>
        `${ms(c.latencyMs.queueWait.p50)} / ${ms(c.latencyMs.queueWait.p95)} / ${ms(c.latencyMs.queueWait.max)}`,
    ),
    row('End-to-end (completed) p50 / p95 / p99 / max', (c) => {
      const d = c.latencyMs.endToEndCompleted;
      return `${ms(d.p50)} / ${ms(d.p95)} / ${ms(d.p99)} / ${ms(d.max)}`;
    }),
    row('Failure distribution (attempts)', (c) => counts(c.failureDistribution)),
    row('Terminal failure reasons', (c) => counts(c.terminalReasons)),
    row('Circuit-breaker transitions', transitions),
    row('Upstream requests seen by carrier', (c) =>
      c.upstream ? String(c.upstream.requests) : 'n/a',
    ),
    row('Peak upstream req/s · max concurrent', (c) =>
      c.upstream
        ? `${c.upstream.peakRequestsPerSecond} · ${c.upstream.maxConcurrentRequests}`
        : 'n/a',
    ),
    '',
    `**Idempotency:** ${summary.idempotency.submissions} submissions → ${summary.idempotency.jobsCreated} jobs created, ` +
      `${summary.idempotency.duplicateSubmissionsDeduplicated} duplicate submissions deduplicated; ` +
      `${summary.idempotency.completedJobs} completed jobs, ${summary.idempotency.successfulAttempts} successful attempts, ` +
      `${summary.idempotency.jobsWithMultipleSuccessfulAttempts} jobs with more than one successful attempt; ` +
      `${summary.idempotency.policyRecords} policy records for ${summary.idempotency.distinctPoliciesCompleted} distinct completed policies.`,
    '',
  ].join('\n');
}

async function main() {
  await api.get('/health');
  const health = await api.get<CarrierHealth>('/carriers/health');
  const environment = describeEnvironment();
  const results: ExperimentSummary[] = [];
  let outageId: string | undefined;

  for (const scenario of scenarios) {
    const extra = scenario === 'recovery' && outageId ? { replayFromExperimentId: outageId } : {};
    const summary = await runScenario(scenario, extra);
    if (scenario === 'outage') outageId = summary.experimentId;
    results.push(summary);
  }

  mkdirSync(outDir, { recursive: true });
  const stamp = environment.timestamp.replace(/[:.]/g, '-');
  const jsonPath = join(outDir, `experiments-${stamp}.json`);
  writeFileSync(
    jsonPath,
    JSON.stringify({ environment, carriers: health.carriers, results }, null, 2),
  );

  const carrierConfig = health.carriers
    .map(
      (c) =>
        `${c.carrierId}: concurrency ${c.concurrency}, rate limit ${c.rateLimit.refillPerSecond}/s (burst ${c.rateLimit.capacity})`,
    )
    .join('; ');
  const markdown = [
    '# Experiment results',
    '',
    `Generated by \`npm run experiments\` (seed ${seed}). Raw data: \`${jsonPath.split('/').pop()}\`.`,
    'Every number below was measured during this run; see docs/experiments.md for methodology.',
    '',
    '## Environment',
    '',
    environmentMarkdown(environment, { api: apiUrl, carriers: carrierConfig }),
    '',
    '## Results',
    '',
    ...results.map(experimentMarkdown),
  ].join('\n');
  writeFileSync(join(outDir, 'EXPERIMENTS.md'), markdown);

  console.log(`\n${markdown}`);
  console.log(`\nWrote ${jsonPath} and ${join(outDir, 'EXPERIMENTS.md')}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
