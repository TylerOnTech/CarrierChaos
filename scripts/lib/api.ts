/** Tiny HTTP helpers shared by the CLI scripts (experiments, load test). */
export interface ApiClientOptions {
  baseUrl: string;
  adminToken: string;
}

export class ApiClient {
  constructor(private readonly options: ApiClientOptions) {}

  async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  async post<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
    return this.request<T>('POST', path, body, headers);
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const response = await fetch(`${this.options.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.options.adminToken}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? null : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${text}`);
    return JSON.parse(text) as T;
  }
}

export function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]!;
  return fallback;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
