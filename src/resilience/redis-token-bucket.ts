import type { Redis } from 'ioredis';
import type { RateLimitDecision, RateLimiter, TokenBucketConfig } from './rate-limiter.js';

/**
 * Distributed token bucket shared by every worker process that talks to the same carrier.
 *
 * The refill-and-take step runs atomically in Lua, and uses the Redis server clock so that
 * worker hosts with skewed clocks still agree on the refill rate. Same arithmetic as
 * `takeToken` in rate-limiter.ts.
 */
const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_ms = tonumber(ARGV[2]) / 1000
local ttl_ms = tonumber(ARGV[3])

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local state = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil or ts == nil then
  tokens = capacity
  ts = now
end

local elapsed = math.max(0, now - ts)
tokens = math.min(capacity, tokens + elapsed * refill_per_ms)

local allowed = 0
local retry_after = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry_after = math.ceil((1 - tokens) / refill_per_ms)
end

redis.call('HSET', key, 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', key, ttl_ms)
return { allowed, retry_after, math.floor(tokens) }
`;

export class RedisTokenBucket implements RateLimiter {
  private readonly ttlMs: number;

  constructor(
    private readonly redis: Redis,
    private readonly key: string,
    private readonly config: TokenBucketConfig,
  ) {
    // Keep state at least as long as a full refill takes; an expired key means a full bucket,
    // which is exactly the state it would have refilled to anyway.
    this.ttlMs = Math.max(1000, Math.ceil((config.capacity / config.refillPerSecond) * 1000) * 2);
  }

  async tryAcquire(): Promise<RateLimitDecision> {
    const result = (await this.redis.eval(
      TOKEN_BUCKET_LUA,
      1,
      this.key,
      String(this.config.capacity),
      String(this.config.refillPerSecond),
      String(this.ttlMs),
    )) as [number, number, number];
    const [allowed, retryAfterMs, remaining] = result;
    return { allowed: allowed === 1, retryAfterMs, remaining };
  }
}
