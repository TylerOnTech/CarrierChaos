import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

/**
 * Development-only admin authentication: a single shared secret, sent as
 * `Authorization: Bearer <token>` or `X-Admin-Token: <token>`.
 *
 * Both sides are hashed before comparison so `timingSafeEqual` always sees equal-length input
 * and the comparison time does not leak the token length. This is intentionally minimal; a real
 * deployment would use an identity provider (OIDC/JWT) or mTLS with per-operator audit trails.
 */
export function extractAdminToken(headers: {
  authorization?: string | undefined;
  'x-admin-token'?: string | string[] | undefined;
}): string | undefined {
  const header = headers['x-admin-token'];
  if (typeof header === 'string' && header !== '') return header;
  const authorization = headers.authorization;
  if (authorization?.startsWith('Bearer ')) return authorization.slice('Bearer '.length).trim();
  return undefined;
}

export function tokensMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function requireAdminToken(
  expected: string,
  onUnauthorized: (res: Parameters<RequestHandler>[1]) => void,
): RequestHandler {
  return (req, res, next) => {
    const provided = extractAdminToken(req.headers);
    if (provided === undefined || !tokensMatch(provided, expected)) {
      onUnauthorized(res);
      return;
    }
    next();
  };
}
