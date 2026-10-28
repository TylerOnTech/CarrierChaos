import type { FailureProfileInput } from '../mock-carrier/failure-profile.js';
import type { CarrierStats } from '../mock-carrier/simulator.js';

export class MockCarrierControlError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MockCarrierControlError';
  }
}

/** Client for the mock carrier's admin API (fault injection and statistics). */
export class MockCarrierAdminClient {
  constructor(
    private readonly baseUrl: string,
    private readonly adminToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async configure(carrierId: string, profile: FailureProfileInput): Promise<void> {
    await this.call('PUT', `/admin/carriers/${encodeURIComponent(carrierId)}/profile`, profile);
  }

  async stats(carrierId: string): Promise<CarrierStats> {
    const body = (await this.call('GET', `/admin/carriers/${encodeURIComponent(carrierId)}`)) as {
      stats: CarrierStats;
    };
    return body.stats;
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.adminToken}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? null : JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      throw new MockCarrierControlError(`mock carrier unreachable at ${this.baseUrl}`, {
        cause: error,
      });
    }
    const text = await response.text();
    if (!response.ok) {
      throw new MockCarrierControlError(
        `mock carrier ${method} ${path} -> ${response.status}: ${text}`,
      );
    }
    return text === '' ? undefined : (JSON.parse(text) as unknown);
  }
}
