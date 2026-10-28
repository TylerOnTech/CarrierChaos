import { describe, expect, it } from 'vitest';
import {
  FailureProfileSchema,
  decideFault,
  type FailureProfile,
} from '../../src/mock-carrier/failure-profile.js';
import { CarrierSimulator } from '../../src/mock-carrier/simulator.js';

const profile = (input: Record<string, unknown>): FailureProfile =>
  FailureProfileSchema.parse(input);

describe('decideFault', () => {
  const mixed = profile({ seed: 7, faults: { rate_limit: 0.2, server_error: 0.1, timeout: 0.1 } });

  it('is deterministic for the same seed, policy and per-policy request number', () => {
    const a = decideFault(mixed, 'northwind', 'POL-1', 0, 3);
    const b = decideFault(mixed, 'northwind', 'POL-1', 999, 3);
    expect(a.outcome).toBe(b.outcome);
    expect(a.latencyMs).toBe(b.latencyMs);
  });

  it('changes with the seed', () => {
    const outcomes = (seed: number) =>
      Array.from(
        { length: 200 },
        (_, i) => decideFault({ ...mixed, seed }, 'northwind', `POL-${i}`, i, 0).outcome,
      );
    expect(outcomes(1)).not.toEqual(outcomes(2));
    expect(outcomes(1)).toEqual(outcomes(1));
  });

  it('approximates the configured probabilities', () => {
    const counts: Record<string, number> = {};
    const n = 20_000;
    for (let i = 0; i < n; i += 1) {
      const { outcome } = decideFault(mixed, 'northwind', `POL-${i}`, i, 0);
      counts[outcome] = (counts[outcome] ?? 0) + 1;
    }
    expect(counts.rate_limit! / n).toBeCloseTo(0.2, 1);
    expect(counts.server_error! / n).toBeCloseTo(0.1, 1);
    expect(counts.timeout! / n).toBeCloseTo(0.1, 1);
    expect(counts.ok! / n).toBeCloseTo(0.6, 1);
  });

  it('serves the scripted sequence first, then falls back to probabilities', () => {
    const scripted = profile({ sequence: ['server_error', 'rate_limit', 'ok'] });
    expect(decideFault(scripted, 'c', 'p', 0, 0).outcome).toBe('server_error');
    expect(decideFault(scripted, 'c', 'p', 1, 1).outcome).toBe('rate_limit');
    expect(decideFault(scripted, 'c', 'p', 2, 2).outcome).toBe('ok');
    expect(decideFault(scripted, 'c', 'p', 3, 3)).toMatchObject({
      outcome: 'ok',
      source: 'probability',
    });
  });

  it('respects the latency range', () => {
    const p = profile({ latencyMs: { min: 10, max: 12 } });
    for (let i = 0; i < 100; i += 1) {
      const { latencyMs } = decideFault(p, 'c', `p${i}`, i, 0);
      expect(latencyMs).toBeGreaterThanOrEqual(10);
      expect(latencyMs).toBeLessThanOrEqual(12);
    }
  });
});

describe('FailureProfileSchema', () => {
  it('rejects probabilities that sum above 1', () => {
    expect(() => profile({ faults: { rate_limit: 0.7, server_error: 0.5 } })).toThrow();
  });

  it('rejects inverted latency ranges', () => {
    expect(() => profile({ latencyMs: { min: 50, max: 10 } })).toThrow();
  });

  it('provides healthy defaults', () => {
    expect(profile({})).toMatchObject({ faults: {}, sequence: [], retryAfterSeconds: 1 });
  });
});

describe('CarrierSimulator', () => {
  it('produces the same per-policy fault sequence regardless of request interleaving', () => {
    const config = { seed: 99, faults: { server_error: 0.3, unavailable: 0.2 } };
    const policies = Array.from({ length: 30 }, (_, i) => `POL-${i}`);

    const run = (order: string[]) => {
      const simulator = new CarrierSimulator('northwind');
      simulator.configure(config);
      const perPolicy = new Map<string, string[]>();
      for (const policyId of order) {
        const list = perPolicy.get(policyId) ?? [];
        list.push(simulator.nextDecision(policyId).outcome);
        perPolicy.set(policyId, list);
      }
      return perPolicy;
    };

    // Three requests per policy, sequential vs. interleaved in reverse.
    const sequential = policies.flatMap((p) => [p, p, p]);
    const interleaved = [...policies.reverse(), ...policies, ...policies];
    const a = run(sequential);
    const b = run(interleaved);
    for (const policyId of policies) expect(b.get(policyId)).toEqual(a.get(policyId));
  });

  it('tracks statistics and resets them when reconfigured', () => {
    const simulator = new CarrierSimulator('northwind');
    simulator.nextDecision('POL-1');
    simulator.recordOutcome('ok', 'POL-1');
    simulator.nextDecision('POL-1');
    simulator.recordOutcome('ok', 'POL-1');
    expect(simulator.getStats()).toMatchObject({
      requests: 2,
      successfulResponses: 2,
      policiesServedMoreThanOnce: 1,
    });
    simulator.configure({});
    expect(simulator.getStats()).toMatchObject({ requests: 0, successfulResponses: 0 });
  });
});
