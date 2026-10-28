import { beforeEach, describe, expect, it } from 'vitest';
import {
  CircuitBreaker,
  type CircuitBreakerOptions,
  type Permit,
  type StateChange,
} from '../../src/resilience/circuit-breaker.js';

let now = 0;
const clock = () => now;

const options: CircuitBreakerOptions = {
  failureRateThreshold: 0.5,
  minimumRequests: 4,
  windowMs: 10_000,
  openDurationMs: 5000,
  halfOpenMaxProbes: 2,
  halfOpenSuccessThreshold: 2,
  clock,
};

function acquire(breaker: CircuitBreaker): Permit {
  const result = breaker.tryAcquire();
  if (!result.allowed) throw new Error(`expected a permit, breaker is ${result.state}`);
  return result.permit;
}

function fail(breaker: CircuitBreaker, times: number) {
  for (let i = 0; i < times; i += 1) breaker.record(acquire(breaker), 'failure');
}

function succeed(breaker: CircuitBreaker, times: number) {
  for (let i = 0; i < times; i += 1) breaker.record(acquire(breaker), 'success');
}

function trip(breaker: CircuitBreaker) {
  fail(breaker, options.minimumRequests);
  expect(breaker.currentState()).toBe('OPEN');
}

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;
  let changes: StateChange[];

  beforeEach(() => {
    now = 1_000_000;
    breaker = new CircuitBreaker(options);
    changes = [];
    breaker.onStateChange((change) => changes.push(change));
  });

  describe('CLOSED', () => {
    it('allows calls and stays closed while healthy', () => {
      succeed(breaker, 20);
      expect(breaker.currentState()).toBe('CLOSED');
    });

    it('does not trip before the minimum number of requests', () => {
      fail(breaker, options.minimumRequests - 1);
      expect(breaker.currentState()).toBe('CLOSED');
    });

    it('trips to OPEN when the failure rate reaches the threshold', () => {
      succeed(breaker, 2);
      fail(breaker, 1);
      expect(breaker.currentState()).toBe('CLOSED');
      fail(breaker, 1); // 2/4 = 50%
      expect(breaker.currentState()).toBe('OPEN');
      expect(changes).toEqual([expect.objectContaining({ from: 'CLOSED', to: 'OPEN', at: now })]);
    });

    it('stays closed below the threshold', () => {
      succeed(breaker, 7);
      fail(breaker, 3); // 30%
      expect(breaker.currentState()).toBe('CLOSED');
    });

    it('forgets outcomes older than the rolling window', () => {
      fail(breaker, 3);
      now += options.windowMs + 1;
      fail(breaker, 1); // only 1 failure in the window now
      expect(breaker.currentState()).toBe('CLOSED');
      expect(breaker.snapshot().windowRequests).toBe(1);
    });

    it('ignores neutral outcomes such as throttling', () => {
      for (let i = 0; i < 10; i += 1) breaker.record(acquire(breaker), 'neutral');
      expect(breaker.snapshot().windowRequests).toBe(0);
      expect(breaker.currentState()).toBe('CLOSED');
    });
  });

  describe('OPEN', () => {
    it('rejects calls with the remaining open time', () => {
      trip(breaker);
      now += 1500;
      expect(breaker.tryAcquire()).toEqual({ allowed: false, state: 'OPEN', retryAfterMs: 3500 });
    });

    it('moves to HALF_OPEN once the open duration has elapsed', () => {
      trip(breaker);
      now += options.openDurationMs - 1;
      expect(breaker.currentState()).toBe('OPEN');
      now += 1;
      expect(breaker.currentState()).toBe('HALF_OPEN');
      expect(changes.map((c) => `${c.from}->${c.to}`)).toEqual(['CLOSED->OPEN', 'OPEN->HALF_OPEN']);
    });
  });

  describe('HALF_OPEN', () => {
    beforeEach(() => {
      trip(breaker);
      now += options.openDurationMs;
    });

    it('allows only a bounded number of concurrent probes', () => {
      const first = breaker.tryAcquire();
      const second = breaker.tryAcquire();
      const third = breaker.tryAcquire();
      expect(first).toMatchObject({ allowed: true, permit: { probe: true } });
      expect(second).toMatchObject({ allowed: true, permit: { probe: true } });
      expect(third).toMatchObject({ allowed: false, state: 'HALF_OPEN' });
      expect(third.allowed === false && third.retryAfterMs).toBeGreaterThan(0);
    });

    it('closes after enough successful probes', () => {
      const a = acquire(breaker);
      const b = acquire(breaker);
      breaker.record(a, 'success');
      expect(breaker.currentState()).toBe('HALF_OPEN');
      breaker.record(b, 'success');
      expect(breaker.currentState()).toBe('CLOSED');
      expect(changes.at(-1)).toMatchObject({ from: 'HALF_OPEN', to: 'CLOSED' });
    });

    it('re-opens on a failed probe and restarts the open timer', () => {
      breaker.record(acquire(breaker), 'failure');
      expect(breaker.currentState()).toBe('OPEN');
      expect(breaker.tryAcquire()).toEqual({
        allowed: false,
        state: 'OPEN',
        retryAfterMs: options.openDurationMs,
      });
    });

    it('frees a probe slot when a permit is released without a call', () => {
      const a = acquire(breaker);
      acquire(breaker);
      expect(breaker.tryAcquire().allowed).toBe(false);
      breaker.release(a);
      expect(breaker.tryAcquire().allowed).toBe(true);
    });

    it('does not count neutral probe outcomes as recovery evidence', () => {
      breaker.record(acquire(breaker), 'neutral');
      breaker.record(acquire(breaker), 'neutral');
      expect(breaker.currentState()).toBe('HALF_OPEN');
      expect(breaker.snapshot().probesInFlight).toBe(0);
    });
  });

  describe('stale permits', () => {
    it('ignores a late success from a call that started before the breaker opened', () => {
      const slowCall = acquire(breaker); // issued while CLOSED
      trip(breaker);
      now += options.openDurationMs;
      expect(breaker.currentState()).toBe('HALF_OPEN');
      breaker.record(slowCall, 'success');
      breaker.record(slowCall, 'success');
      expect(breaker.currentState()).toBe('HALF_OPEN');
    });

    it('ignores a late probe failure after the breaker already closed', () => {
      trip(breaker);
      now += options.openDurationMs;
      const a = acquire(breaker);
      const b = acquire(breaker);
      breaker.record(a, 'success');
      breaker.record(b, 'success');
      expect(breaker.currentState()).toBe('CLOSED');
      breaker.record(a, 'failure');
      expect(breaker.currentState()).toBe('CLOSED');
    });
  });

  it('runs a full CLOSED -> OPEN -> HALF_OPEN -> OPEN -> HALF_OPEN -> CLOSED cycle', () => {
    trip(breaker);
    now += options.openDurationMs;
    breaker.record(acquire(breaker), 'failure');
    now += options.openDurationMs;
    succeed(breaker, 2);
    expect(changes.map((c) => c.to)).toEqual(['OPEN', 'HALF_OPEN', 'OPEN', 'HALF_OPEN', 'CLOSED']);
  });

  it('keeps working when a listener throws', () => {
    breaker.onStateChange(() => {
      throw new Error('observer bug');
    });
    trip(breaker);
    expect(breaker.currentState()).toBe('OPEN');
  });

  it('validates its options', () => {
    expect(() => new CircuitBreaker({ ...options, failureRateThreshold: 0 })).toThrow(RangeError);
    expect(() => new CircuitBreaker({ ...options, minimumRequests: 0 })).toThrow(RangeError);
    expect(() => new CircuitBreaker({ ...options, halfOpenMaxProbes: 0 })).toThrow(RangeError);
  });
});
