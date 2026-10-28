import { describe, expect, it } from 'vitest';
import {
  InvalidTransitionError,
  JOB_STATUSES,
  assertTransition,
  canTransition,
  isTerminal,
  type JobStatusValue,
} from '../../src/jobs/job-states.js';

const allowed: Array<[JobStatusValue, JobStatusValue]> = [
  ['queued', 'processing'],
  ['queued', 'cancelled'],
  ['processing', 'processing'],
  ['processing', 'queued'],
  ['processing', 'completed'],
  ['processing', 'failed'],
  ['processing', 'dead_lettered'],
  ['processing', 'cancelled'],
  ['failed', 'queued'],
  ['dead_lettered', 'queued'],
  ['cancelled', 'queued'],
];

describe('job state machine', () => {
  it.each(allowed)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it('forbids every other transition', () => {
    const allowedSet = new Set(allowed.map(([from, to]) => `${from}->${to}`));
    for (const from of JOB_STATUSES) {
      for (const to of JOB_STATUSES) {
        if (!allowedSet.has(`${from}->${to}`))
          expect(canTransition(from, to), `${from}->${to}`).toBe(false);
      }
    }
  });

  it('treats completed as final: it can never be retried into a second result', () => {
    for (const to of JOB_STATUSES) expect(canTransition('completed', to)).toBe(false);
  });

  it('marks terminal states', () => {
    expect(JOB_STATUSES.filter(isTerminal)).toEqual([
      'completed',
      'failed',
      'dead_lettered',
      'cancelled',
    ]);
  });

  it('throws a descriptive error for invalid transitions', () => {
    expect(() => assertTransition('completed', 'queued', 'retry')).toThrow(InvalidTransitionError);
    expect(() => assertTransition('completed', 'queued', 'retry')).toThrow(
      "cannot retry a job in status 'completed'",
    );
  });
});
