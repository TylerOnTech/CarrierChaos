import { z } from 'zod';
import { seededRandom } from './prng.js';

/**
 * Failure profile for one simulated carrier.
 *
 * Two injection modes, usable together:
 * - `sequence`: an explicit list of outcomes served to requests in arrival order. Once it is
 *   exhausted, probabilistic mode takes over. Ideal for unit-style tests ("fail twice, then
 *   succeed").
 * - `faults`: per-request probabilities. The draw for a request is seeded by
 *   (seed, carrierId, policyId, n) where n counts prior requests for that policy. Every
 *   (policy, attempt) pair therefore gets the same fault on every run, regardless of how
 *   concurrent workers interleave. That is what makes experiments reproducible.
 */
export const FAULT_KINDS = [
  'rate_limit',
  'server_error',
  'unavailable',
  'slow',
  'timeout',
  'connection_reset',
  'invalid_json',
  'schema_violation',
  'auth_error',
] as const;

export type FaultKind = (typeof FAULT_KINDS)[number];
export type Outcome = FaultKind | 'ok';

const probability = z.number().min(0).max(1);

export const FailureProfileSchema = z
  .object({
    seed: z.number().int().default(1),
    latencyMs: z
      .object({ min: z.number().int().min(0), max: z.number().int().min(0) })
      .refine((range) => range.min <= range.max, 'latencyMs.min must be <= latencyMs.max')
      .default({ min: 20, max: 60 }),
    faults: z.partialRecord(z.enum(FAULT_KINDS), probability).default({}),
    sequence: z.array(z.enum([...FAULT_KINDS, 'ok'])).default([]),
    /** Retry-After seconds sent with 429/503; null omits the header. */
    retryAfterSeconds: z.number().min(0).nullable().default(1),
    /** Delay for `slow` responses: slower than normal, but within a sane client timeout. */
    slowResponseMs: z.number().int().min(0).default(1200),
    /** How long a `timeout` request hangs before the server drops it. */
    hangMs: z.number().int().min(0).default(60_000),
  })
  .refine(
    (profile) => Object.values(profile.faults).reduce((sum, p) => sum + (p ?? 0), 0) <= 1 + 1e-9,
    { message: 'fault probabilities must sum to <= 1', path: ['faults'] },
  );

export type FailureProfileInput = z.input<typeof FailureProfileSchema>;
export type FailureProfile = z.output<typeof FailureProfileSchema>;

export const HEALTHY_PROFILE: FailureProfile = FailureProfileSchema.parse({});

export interface FaultDecision {
  outcome: Outcome;
  latencyMs: number;
  /** Deterministic randomness for the chosen outcome (e.g. which schema violation). */
  random: () => number;
  source: 'sequence' | 'probability';
}

/**
 * Picks the outcome for one request. Pure given its inputs: callers pass the global request
 * index and the number of earlier requests for the same policy.
 */
export function decideFault(
  profile: FailureProfile,
  carrierId: string,
  policyId: string,
  requestIndex: number,
  policyRequestIndex: number,
): FaultDecision {
  const random = seededRandom(profile.seed, carrierId, policyId, policyRequestIndex);
  const roll = random();
  const latencyMs =
    profile.latencyMs.min +
    Math.floor(random() * (profile.latencyMs.max - profile.latencyMs.min + 1));

  const scripted = profile.sequence[requestIndex];
  if (scripted !== undefined) {
    return { outcome: scripted, latencyMs, random, source: 'sequence' };
  }

  // Fixed iteration order (FAULT_KINDS) keeps the cumulative distribution stable.
  let cumulative = 0;
  for (const kind of FAULT_KINDS) {
    cumulative += profile.faults[kind] ?? 0;
    if (roll < cumulative) return { outcome: kind, latencyMs, random, source: 'probability' };
  }
  return { outcome: 'ok', latencyMs, random, source: 'probability' };
}
