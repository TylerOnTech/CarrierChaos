import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TimeoutError, withTimeout } from '../../src/resilience/timeout.js';

describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the result when the operation finishes in time', async () => {
    const pending = withTimeout(
      () => new Promise<string>((resolve) => setTimeout(() => resolve('done'), 50)),
      100,
    );
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toBe('done');
    expect(vi.getTimerCount()).toBe(0); // the timeout timer was cleared
  });

  it('rejects with TimeoutError and aborts the signal when the limit passes', async () => {
    let signal: AbortSignal | undefined;
    const pending = withTimeout((s) => {
      signal = s;
      return new Promise<never>(() => {});
    }, 100);
    const assertion = expect(pending).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBeInstanceOf(TimeoutError);
  });

  it('does not wait for an operation that ignores the abort signal', async () => {
    const pending = withTimeout(
      () => new Promise<string>((resolve) => setTimeout(() => resolve('late'), 60_000)),
      200,
    );
    const assertion = expect(pending).rejects.toThrow('timed out after 200ms');
    await vi.advanceTimersByTimeAsync(200);
    await assertion;
  });

  it('propagates operation errors unchanged', async () => {
    await expect(withTimeout(() => Promise.reject(new Error('boom')), 100)).rejects.toThrow('boom');
  });
});
