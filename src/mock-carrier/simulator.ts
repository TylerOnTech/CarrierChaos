import {
  FailureProfileSchema,
  HEALTHY_PROFILE,
  decideFault,
  type FailureProfile,
  type FailureProfileInput,
  type FaultDecision,
  type Outcome,
} from './failure-profile.js';

export interface CarrierStats {
  requests: number;
  byOutcome: Partial<Record<Outcome | 'not_found' | 'unauthorized', number>>;
  inFlight: number;
  maxInFlight: number;
  /** Highest number of policy requests received within any single wall-clock second. */
  peakRequestsPerSecond: number;
  successfulResponses: number;
  /** Policies that were served successfully more than once (at-least-once evidence). */
  policiesServedMoreThanOnce: number;
  since: string;
}

/** Mutable state of one simulated carrier: its profile, request counters and statistics. */
export class CarrierSimulator {
  private profile: FailureProfile = HEALTHY_PROFILE;
  private requestIndex = 0;
  private readonly policyRequestCounts = new Map<string, number>();
  private readonly successesByPolicy = new Map<string, number>();
  private readonly perSecond = new Map<number, number>();
  private stats!: Omit<CarrierStats, 'policiesServedMoreThanOnce'>;

  constructor(
    readonly carrierId: string,
    private readonly clock: () => number = Date.now,
  ) {
    this.reset();
  }

  getProfile(): FailureProfile {
    return this.profile;
  }

  /** Replaces the profile and resets counters, so a new experiment starts from request #0. */
  configure(input: FailureProfileInput): FailureProfile {
    this.profile = FailureProfileSchema.parse(input);
    this.reset();
    return this.profile;
  }

  reset(): void {
    this.requestIndex = 0;
    this.policyRequestCounts.clear();
    this.successesByPolicy.clear();
    this.perSecond.clear();
    this.stats = {
      requests: 0,
      byOutcome: {},
      inFlight: 0,
      maxInFlight: 0,
      peakRequestsPerSecond: 0,
      successfulResponses: 0,
      since: new Date(this.clock()).toISOString(),
    };
  }

  /** Registers an incoming policy request and decides how to answer it. */
  nextDecision(policyId: string): FaultDecision {
    const policyIndex = this.policyRequestCounts.get(policyId) ?? 0;
    this.policyRequestCounts.set(policyId, policyIndex + 1);
    const decision = decideFault(
      this.profile,
      this.carrierId,
      policyId,
      this.requestIndex,
      policyIndex,
    );
    this.requestIndex += 1;
    this.countRequest();
    return decision;
  }

  countRequest(): void {
    this.stats.requests += 1;
    const second = Math.floor(this.clock() / 1000);
    const count = (this.perSecond.get(second) ?? 0) + 1;
    this.perSecond.set(second, count);
    this.stats.peakRequestsPerSecond = Math.max(this.stats.peakRequestsPerSecond, count);
    for (const key of this.perSecond.keys()) {
      if (key < second - 5) this.perSecond.delete(key);
    }
  }

  recordOutcome(outcome: Outcome | 'not_found' | 'unauthorized', policyId?: string): void {
    this.stats.byOutcome[outcome] = (this.stats.byOutcome[outcome] ?? 0) + 1;
    if ((outcome === 'ok' || outcome === 'slow') && policyId !== undefined) {
      this.stats.successfulResponses += 1;
      this.successesByPolicy.set(policyId, (this.successesByPolicy.get(policyId) ?? 0) + 1);
    }
  }

  enter(): void {
    this.stats.inFlight += 1;
    this.stats.maxInFlight = Math.max(this.stats.maxInFlight, this.stats.inFlight);
  }

  exit(): void {
    this.stats.inFlight = Math.max(0, this.stats.inFlight - 1);
  }

  getStats(): CarrierStats {
    let repeated = 0;
    for (const count of this.successesByPolicy.values()) if (count > 1) repeated += 1;
    return {
      ...this.stats,
      byOutcome: { ...this.stats.byOutcome },
      policiesServedMoreThanOnce: repeated,
    };
  }
}

export class CarrierRegistry {
  private readonly carriers = new Map<string, CarrierSimulator>();

  constructor(private readonly clock: () => number = Date.now) {}

  /** Carriers are created lazily with a healthy profile. */
  get(carrierId: string): CarrierSimulator {
    let carrier = this.carriers.get(carrierId);
    if (!carrier) {
      carrier = new CarrierSimulator(carrierId, this.clock);
      this.carriers.set(carrierId, carrier);
    }
    return carrier;
  }

  list(): CarrierSimulator[] {
    return [...this.carriers.values()];
  }
}
