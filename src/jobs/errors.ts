export class JobNotFoundError extends Error {
  constructor(readonly jobId: string) {
    super(`job ${jobId} not found`);
    this.name = 'JobNotFoundError';
  }
}

export class IdempotencyConflictError extends Error {
  constructor(
    readonly idempotencyKey: string,
    readonly existingJobId: string,
  ) {
    super(`idempotency key '${idempotencyKey}' was already used with a different request payload`);
    this.name = 'IdempotencyConflictError';
  }
}

export class UnknownCarrierError extends Error {
  constructor(readonly carrierId: string) {
    super(`unknown carrier '${carrierId}'`);
    this.name = 'UnknownCarrierError';
  }
}
