export class TimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`operation timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Runs `operation` with a hard time limit.
 *
 * The operation receives an AbortSignal that fires on timeout, so cooperative work (fetch,
 * body reads) is actually cancelled and its socket released. The returned promise also races
 * the timer, so even an operation that ignores the signal cannot hold the caller past the limit.
 */
export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new TimeoutError(timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
