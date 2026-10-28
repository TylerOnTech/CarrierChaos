import { Redis, type RedisOptions } from 'ioredis';

/**
 * BullMQ workers need `maxRetriesPerRequest: null` so blocking commands are never aborted.
 * Producers and ad-hoc commands use the default, so they fail fast if Redis is down.
 */
export function createRedis(url: string, options: { forWorker?: boolean } = {}): Redis {
  const redisOptions: RedisOptions = options.forWorker
    ? { maxRetriesPerRequest: null, enableReadyCheck: false }
    : { maxRetriesPerRequest: 2 };
  return new Redis(url, redisOptions);
}
