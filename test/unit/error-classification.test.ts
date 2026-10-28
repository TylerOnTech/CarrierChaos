import { describe, expect, it } from 'vitest';
import {
  CarrierError,
  ERROR_KINDS,
  ERROR_POLICIES,
  errorKindForStatus,
  toCarrierError,
} from '../../src/resilience/errors.js';

describe('errorKindForStatus', () => {
  it.each([
    [429, 'RATE_LIMITED'],
    [500, 'UPSTREAM_ERROR'],
    [502, 'UPSTREAM_ERROR'],
    [503, 'UNAVAILABLE'],
    [504, 'UPSTREAM_ERROR'],
    [408, 'TIMEOUT'],
    [401, 'AUTH_EXPIRED'],
    [403, 'AUTH_FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [400, 'BAD_REQUEST'],
    [422, 'BAD_REQUEST'],
  ])('maps HTTP %i to %s', (status, kind) => {
    expect(errorKindForStatus(status)).toBe(kind);
  });
});

describe('transient vs permanent classification', () => {
  const transient = [
    'RATE_LIMITED',
    'UPSTREAM_ERROR',
    'UNAVAILABLE',
    'TIMEOUT',
    'CONNECTION_ERROR',
    'INVALID_RESPONSE',
    'AUTH_EXPIRED',
  ];
  const permanent = ['SCHEMA_VIOLATION', 'AUTH_FORBIDDEN', 'NOT_FOUND', 'BAD_REQUEST'];

  it('classifies every kind exactly once', () => {
    expect([...transient, ...permanent, 'UNKNOWN'].sort()).toEqual([...ERROR_KINDS].sort());
  });

  it.each(transient)('%s is retryable', (kind) => {
    expect(ERROR_POLICIES[kind as keyof typeof ERROR_POLICIES].retryable).toBe(true);
  });

  it.each(permanent)('%s is not retryable', (kind) => {
    expect(ERROR_POLICIES[kind as keyof typeof ERROR_POLICIES].retryable).toBe(false);
  });

  it('counts only health-related failures against the circuit breaker', () => {
    const failures = ERROR_KINDS.filter(
      (kind) => ERROR_POLICIES[kind].breakerOutcome === 'failure',
    );
    expect(failures.sort()).toEqual(
      ['UPSTREAM_ERROR', 'UNAVAILABLE', 'TIMEOUT', 'CONNECTION_ERROR', 'INVALID_RESPONSE'].sort(),
    );
    expect(ERROR_POLICIES.RATE_LIMITED.breakerOutcome).toBe('neutral');
    expect(ERROR_POLICIES.NOT_FOUND.breakerOutcome).toBe('success');
  });
});

describe('CarrierError', () => {
  it('exposes classification from its kind', () => {
    const error = new CarrierError('UNAVAILABLE', 'down', { status: 503, retryAfterMs: 1000 });
    expect(error.retryable).toBe(true);
    expect(error.breakerOutcome).toBe('failure');
    expect(error.retryAfterMs).toBe(1000);
  });

  it('wraps unknown throwables as UNKNOWN', () => {
    const wrapped = toCarrierError(new TypeError('undefined is not a function'));
    expect(wrapped.kind).toBe('UNKNOWN');
    expect(wrapped.message).toBe('undefined is not a function');
    const same = new CarrierError('TIMEOUT', 'slow');
    expect(toCarrierError(same)).toBe(same);
  });
});
