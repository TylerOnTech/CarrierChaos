import { NormalizedPolicySchema, type NormalizedPolicy } from '../contracts/normalized-policy.js';
import { CarrierError, errorKindForStatus } from '../resilience/errors.js';
import { parseRetryAfter } from '../resilience/retry-after.js';
import { TimeoutError, withTimeout } from '../resilience/timeout.js';

export interface CarrierClientOptions {
  carrierId: string;
  baseUrl: string;
  timeoutMs: number;
  clientId?: string;
  clientSecret?: string;
  fetchImpl?: typeof fetch;
  clock?: () => number;
}

export interface CarrierResponseMeta {
  status: number;
  durationMs: number;
}

/**
 * HTTP client for one carrier.
 *
 * Responsibilities: bound every call with a hard timeout, translate every failure mode into a
 * classified {@link CarrierError}, manage the carrier session token, and refuse to return any
 * payload that does not satisfy the NormalizedPolicy v1 contract.
 */
export class CarrierClient {
  private token: { value: string; expiresAt: number } | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => number;

  constructor(private readonly options: CarrierClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.clock = options.clock ?? Date.now;
  }

  get carrierId(): string {
    return this.options.carrierId;
  }

  async fetchPolicy(policyId: string): Promise<NormalizedPolicy> {
    const token = await this.getToken();
    const url = `${this.options.baseUrl}/carriers/${encodeURIComponent(this.carrierId)}/policies/${encodeURIComponent(policyId)}`;

    const { status, headers, body } = await this.request(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });

    if (status !== 200) {
      if (status === 401) this.token = undefined; // force a fresh session on the next attempt
      const kind = errorKindForStatus(status);
      throw new CarrierError(kind, `carrier responded ${status}`, {
        status,
        retryAfterMs:
          status === 429 || status === 503
            ? parseRetryAfter(headers.get('retry-after'), this.clock())
            : undefined,
      });
    }

    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch (error) {
      throw new CarrierError('INVALID_RESPONSE', 'response body is not valid JSON', {
        status,
        cause: error,
        details: { bodyPreview: body.slice(0, 80) },
      });
    }

    const parsed = NormalizedPolicySchema.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 5).map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      throw new CarrierError(
        'SCHEMA_VIOLATION',
        `response violates NormalizedPolicy v1: ${issues.map((i) => `${i.path || '(root)'} ${i.message}`).join('; ')}`,
        { status, details: { issues } },
      );
    }
    if (parsed.data.carrierId !== this.carrierId || parsed.data.policyId !== policyId) {
      throw new CarrierError(
        'SCHEMA_VIOLATION',
        `response identifies ${parsed.data.carrierId}/${parsed.data.policyId}, expected ${this.carrierId}/${policyId}`,
        { status },
      );
    }
    return parsed.data;
  }

  private async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.clock() + 30_000) return this.token.value;

    const url = `${this.options.baseUrl}/carriers/${encodeURIComponent(this.carrierId)}/oauth/token`;
    const { status, body } = await this.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: this.options.clientId ?? 'carrierchaos',
        client_secret: this.options.clientSecret ?? 'synthetic-secret',
      }),
    });

    if (status !== 200) {
      // Rejected client credentials are permanent; server errors keep their usual meaning.
      const kind = status >= 500 ? errorKindForStatus(status) : 'AUTH_FORBIDDEN';
      throw new CarrierError(kind, `token endpoint responded ${status}`, { status });
    }
    let parsed: { access_token?: unknown; expires_in?: unknown };
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch (error) {
      throw new CarrierError('INVALID_RESPONSE', 'token response is not valid JSON', {
        cause: error,
      });
    }
    if (typeof parsed.access_token !== 'string' || typeof parsed.expires_in !== 'number') {
      throw new CarrierError('INVALID_RESPONSE', 'token response is missing fields');
    }
    this.token = { value: parsed.access_token, expiresAt: this.clock() + parsed.expires_in * 1000 };
    return this.token.value;
  }

  /** Performs one HTTP exchange, including the body read, under the request time limit. */
  private async request(
    url: string,
    init: RequestInit,
  ): Promise<{ status: number; headers: Headers; body: string }> {
    try {
      return await withTimeout(async (signal) => {
        const response = await this.fetchImpl(url, { ...init, signal });
        const body = await response.text();
        return { status: response.status, headers: response.headers, body };
      }, this.options.timeoutMs);
    } catch (error) {
      throw translateTransportError(error, this.options.timeoutMs);
    }
  }
}

function translateTransportError(error: unknown, timeoutMs: number): CarrierError {
  if (error instanceof TimeoutError) {
    return new CarrierError('TIMEOUT', `no response within ${timeoutMs}ms`, { cause: error });
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new CarrierError('TIMEOUT', `request aborted after ${timeoutMs}ms`, { cause: error });
  }
  const code = transportErrorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  return new CarrierError('CONNECTION_ERROR', code ? `${message} (${code})` : message, {
    cause: error,
  });
}

function transportErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = current.cause;
  }
  return undefined;
}
