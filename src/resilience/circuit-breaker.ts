/**
 * Circuit breaker with CLOSED, OPEN and HALF_OPEN states.
 *
 * CLOSED     Calls flow. Outcomes are recorded in a rolling time window. When the window holds
 *            at least `minimumRequests` outcomes and the failure rate reaches
 *            `failureRateThreshold`, the breaker trips to OPEN.
 * OPEN       Calls are rejected immediately with a hint of when to come back. After
 *            `openDurationMs` the next acquisition moves the breaker to HALF_OPEN.
 * HALF_OPEN  At most `halfOpenMaxProbes` probe calls may be in flight. Any probe failure re-opens
 *            the breaker; `halfOpenSuccessThreshold` probe successes close it.
 *
 * Correctness details:
 * - Every transition bumps a generation counter. Each permit remembers the generation it was
 *   issued in, and outcomes from older generations are ignored. A slow call that started while
 *   CLOSED therefore cannot close a breaker that has since opened, and a stale probe cannot
 *   re-open a breaker that already recovered.
 * - Calls that are acquired but never made (e.g. deferred by a rate limiter) must be released so
 *   they do not hold a probe slot forever.
 * - Time is injected through `clock`, so every transition is deterministic in tests.
 *
 * The breaker is in-memory and therefore per process. See docs/design-tradeoffs in the README.
 */
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export type CallOutcome = 'success' | 'failure' | 'neutral';

export interface CircuitBreakerOptions {
  failureRateThreshold: number;
  minimumRequests: number;
  windowMs: number;
  openDurationMs: number;
  halfOpenMaxProbes: number;
  halfOpenSuccessThreshold: number;
  clock?: () => number;
}

export interface Permit {
  readonly generation: number;
  readonly probe: boolean;
}

export type AcquireResult =
  | { allowed: true; permit: Permit }
  | { allowed: false; state: CircuitState; retryAfterMs: number };

export interface StateChange {
  from: CircuitState;
  to: CircuitState;
  reason: string;
  at: number;
}

export interface CircuitSnapshot {
  state: CircuitState;
  windowRequests: number;
  windowFailures: number;
  probesInFlight: number;
  probeSuccesses: number;
  openedAt: number | null;
  /** Milliseconds until an OPEN breaker allows probes; 0 otherwise. */
  retryAfterMs: number;
}

type Listener = (change: StateChange) => void;

interface WindowEntry {
  at: number;
  failed: boolean;
}

export class CircuitBreaker {
  private readonly options: Required<CircuitBreakerOptions>;
  private state: CircuitState = 'CLOSED';
  private generation = 0;
  private window: WindowEntry[] = [];
  private openedAt: number | null = null;
  private probesInFlight = 0;
  private probeSuccesses = 0;
  private readonly listeners: Listener[] = [];

  constructor(options: CircuitBreakerOptions) {
    if (options.failureRateThreshold <= 0 || options.failureRateThreshold > 1) {
      throw new RangeError('failureRateThreshold must be in (0, 1]');
    }
    if (options.minimumRequests < 1) throw new RangeError('minimumRequests must be >= 1');
    if (options.halfOpenMaxProbes < 1) throw new RangeError('halfOpenMaxProbes must be >= 1');
    if (options.halfOpenSuccessThreshold < 1) {
      throw new RangeError('halfOpenSuccessThreshold must be >= 1');
    }
    this.options = { clock: Date.now, ...options };
  }

  onStateChange(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  /** Current state, applying the time-based OPEN -> HALF_OPEN transition if it is due. */
  currentState(): CircuitState {
    this.advanceClock();
    return this.state;
  }

  tryAcquire(): AcquireResult {
    this.advanceClock();
    const now = this.options.clock();

    switch (this.state) {
      case 'CLOSED':
        return { allowed: true, permit: { generation: this.generation, probe: false } };
      case 'OPEN':
        return {
          allowed: false,
          state: 'OPEN',
          retryAfterMs: Math.max(0, (this.openedAt ?? now) + this.options.openDurationMs - now),
        };
      case 'HALF_OPEN':
        if (this.probesInFlight < this.options.halfOpenMaxProbes) {
          this.probesInFlight += 1;
          return { allowed: true, permit: { generation: this.generation, probe: true } };
        }
        // Probes are already in flight; their results will arrive shortly.
        return { allowed: false, state: 'HALF_OPEN', retryAfterMs: this.halfOpenRetryHintMs() };
    }
  }

  /** Records the outcome of a call made with `permit`. */
  record(permit: Permit, outcome: CallOutcome): void {
    if (permit.generation !== this.generation) return; // stale: issued before a transition

    if (this.state === 'CLOSED') {
      if (outcome === 'neutral') return;
      this.window.push({ at: this.options.clock(), failed: outcome === 'failure' });
      this.evaluateWindow();
      return;
    }

    if (this.state === 'HALF_OPEN' && permit.probe) {
      this.probesInFlight = Math.max(0, this.probesInFlight - 1);
      if (outcome === 'failure') {
        this.transition('OPEN', 'probe failed');
      } else if (outcome === 'success') {
        this.probeSuccesses += 1;
        if (this.probeSuccesses >= this.options.halfOpenSuccessThreshold) {
          this.transition('CLOSED', `${this.probeSuccesses} consecutive probe successes`);
        }
      }
    }
  }

  /** Returns a permit whose call was never made, without recording an outcome. */
  release(permit: Permit): void {
    if (permit.generation !== this.generation) return;
    if (this.state === 'HALF_OPEN' && permit.probe) {
      this.probesInFlight = Math.max(0, this.probesInFlight - 1);
    }
  }

  snapshot(): CircuitSnapshot {
    this.advanceClock();
    const now = this.options.clock();
    this.pruneWindow(now);
    return {
      state: this.state,
      windowRequests: this.window.length,
      windowFailures: this.window.filter((entry) => entry.failed).length,
      probesInFlight: this.probesInFlight,
      probeSuccesses: this.probeSuccesses,
      openedAt: this.openedAt,
      retryAfterMs:
        this.state === 'OPEN' && this.openedAt !== null
          ? Math.max(0, this.openedAt + this.options.openDurationMs - now)
          : 0,
    };
  }

  private advanceClock(): void {
    if (this.state !== 'OPEN' || this.openedAt === null) return;
    if (this.options.clock() >= this.openedAt + this.options.openDurationMs) {
      this.transition('HALF_OPEN', `open for ${this.options.openDurationMs}ms`);
    }
  }

  private evaluateWindow(): void {
    const now = this.options.clock();
    this.pruneWindow(now);
    const total = this.window.length;
    if (total < this.options.minimumRequests) return;
    const failures = this.window.filter((entry) => entry.failed).length;
    const rate = failures / total;
    if (rate >= this.options.failureRateThreshold) {
      this.transition(
        'OPEN',
        `failure rate ${(rate * 100).toFixed(0)}% (${failures}/${total}) within ${this.options.windowMs}ms`,
      );
    }
  }

  private pruneWindow(now: number): void {
    const cutoff = now - this.options.windowMs;
    let firstFresh = 0;
    while (firstFresh < this.window.length && this.window[firstFresh]!.at <= cutoff) {
      firstFresh += 1;
    }
    if (firstFresh > 0) this.window = this.window.slice(firstFresh);
  }

  private halfOpenRetryHintMs(): number {
    return Math.max(50, Math.round(this.options.openDurationMs / 5));
  }

  private transition(to: CircuitState, reason: string): void {
    const from = this.state;
    if (from === to) return;
    const at = this.options.clock();
    this.state = to;
    this.generation += 1;
    this.probesInFlight = 0;
    this.probeSuccesses = 0;
    this.window = [];
    this.openedAt = to === 'OPEN' ? at : null;

    const change: StateChange = { from, to, reason, at };
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch {
        // A faulty observer must never break the breaker itself.
      }
    }
  }
}
