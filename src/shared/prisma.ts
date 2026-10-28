import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

export { Prisma, PrismaClient } from '../generated/prisma/client.js';
export type { Job, JobAttempt, DeadLetter, Experiment } from '../generated/prisma/client.js';
export { JobStatus, AttemptOutcome, ExperimentStatus } from '../generated/prisma/enums.js';

export function createPrismaClient(databaseUrl: string): PrismaClient {
  const url = new URL(databaseUrl);
  // node-postgres ignores Prisma's `connection_limit` query parameter, so translate it.
  const max = Number(url.searchParams.get('connection_limit') ?? '10');
  url.searchParams.delete('connection_limit');
  const adapter = new PrismaPg({ connectionString: url.toString(), max });
  return new PrismaClient({
    adapter,
    transactionOptions: { maxWait: 5000, timeout: 10_000 },
  });
}
