import { z } from 'zod';
import { FAULT_KINDS, type FaultKind } from '../mock-carrier/failure-profile.js';

export const SCENARIO_NAMES = ['healthy', 'intermittent', 'outage', 'recovery'] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

export interface ScenarioPreset {
  code: 'A' | 'B' | 'C' | 'D';
  title: string;
  description: string;
  carrierId: string;
  jobCount: number;
  /** Re-submissions of already-used idempotency keys, mixed in concurrently. */
  duplicateSubmissions: number;
  faults: Partial<Record<FaultKind, number>>;
  retryAfterSeconds: number | null;
  maxAttempts?: number;
  deadlineMs?: number;
  /** A healthy carrier receiving traffic at the same time, to demonstrate isolation. */
  control?: { carrierId: string; jobCount: number };
  /** Replay the dead-lettered jobs of a previous `outage` experiment. */
  replayDeadLetters?: boolean;
}

export const SCENARIOS: Readonly<Record<ScenarioName, ScenarioPreset>> = {
  healthy: {
    code: 'A',
    title: 'Healthy carrier',
    description: '100 retrievals against a carrier with no injected failures.',
    carrierId: 'northwind',
    jobCount: 100,
    duplicateSubmissions: 10,
    faults: {},
    retryAfterSeconds: 1,
  },
  intermittent: {
    code: 'B',
    title: 'Intermittent failures',
    description:
      '100 retrievals with 10% HTTP 429, 8% HTTP 500, 7% HTTP 503 and 5% hanging requests (client timeout).',
    carrierId: 'northwind',
    jobCount: 100,
    duplicateSubmissions: 10,
    faults: { rate_limit: 0.1, server_error: 0.08, unavailable: 0.07, timeout: 0.05 },
    retryAfterSeconds: 1,
    maxAttempts: 6,
  },
  outage: {
    code: 'C',
    title: 'Carrier outage',
    description:
      'Sustained HTTP 503 from one carrier while a healthy control carrier receives traffic concurrently.',
    carrierId: 'bluepeak',
    jobCount: 60,
    duplicateSubmissions: 0,
    faults: { unavailable: 1 },
    retryAfterSeconds: 1,
    maxAttempts: 4,
    deadlineMs: 20_000,
    control: { carrierId: 'harborline', jobCount: 40 },
  },
  recovery: {
    code: 'D',
    title: 'Recovery',
    description:
      'The failed carrier is restored; dead letters from the outage are replayed alongside new jobs.',
    carrierId: 'bluepeak',
    jobCount: 40,
    duplicateSubmissions: 0,
    faults: {},
    retryAfterSeconds: 1,
    replayDeadLetters: true,
  },
};

export const CreateExperimentSchema = z
  .object({
    scenario: z.enum(SCENARIO_NAMES),
    seed: z.number().int().min(0).max(2_147_483_647).default(42),
    carrierId: z.string().min(1).optional(),
    jobCount: z.number().int().min(1).max(5000).optional(),
    duplicateSubmissions: z.number().int().min(0).max(5000).optional(),
    faults: z.partialRecord(z.enum(FAULT_KINDS), z.number().min(0).max(1)).optional(),
    maxAttempts: z.number().int().min(1).max(20).optional(),
    deadlineMs: z.number().int().min(1000).max(86_400_000).optional(),
    controlJobCount: z.number().int().min(0).max(5000).optional(),
    replayFromExperimentId: z.uuid().optional(),
  })
  .strict();

export type CreateExperimentInput = z.input<typeof CreateExperimentSchema>;

export interface ExperimentPlan {
  scenario: ScenarioName;
  code: ScenarioPreset['code'];
  title: string;
  description: string;
  seed: number;
  carrierId: string;
  jobCount: number;
  duplicateSubmissions: number;
  faults: Partial<Record<FaultKind, number>>;
  retryAfterSeconds: number | null;
  maxAttempts: number | null;
  deadlineMs: number | null;
  control: { carrierId: string; jobCount: number } | null;
  replayDeadLetters: boolean;
  replayFromExperimentId: string | null;
}

export function resolvePlan(input: z.output<typeof CreateExperimentSchema>): ExperimentPlan {
  const preset = SCENARIOS[input.scenario];
  const control =
    preset.control && input.controlJobCount !== 0
      ? { ...preset.control, jobCount: input.controlJobCount ?? preset.control.jobCount }
      : null;
  return {
    scenario: input.scenario,
    code: preset.code,
    title: preset.title,
    description: preset.description,
    seed: input.seed,
    carrierId: input.carrierId ?? preset.carrierId,
    jobCount: input.jobCount ?? preset.jobCount,
    duplicateSubmissions: input.duplicateSubmissions ?? preset.duplicateSubmissions,
    faults: input.faults ?? preset.faults,
    retryAfterSeconds: preset.retryAfterSeconds,
    maxAttempts: input.maxAttempts ?? preset.maxAttempts ?? null,
    deadlineMs: input.deadlineMs ?? preset.deadlineMs ?? null,
    control,
    replayDeadLetters: preset.replayDeadLetters ?? false,
    replayFromExperimentId: input.replayFromExperimentId ?? null,
  };
}

/** Deterministic policy ids: re-running a scenario with the same seed targets the same policies. */
export function experimentPolicyId(plan: ExperimentPlan, index: number, control = false): string {
  return `POL-${plan.code}${plan.seed}-${control ? 'CTL-' : ''}${String(index).padStart(4, '0')}`;
}
