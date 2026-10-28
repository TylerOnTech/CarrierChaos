import type { ErrorRequestHandler, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { MockCarrierControlError } from '../carriers/mock-admin-client.js';
import {
  ExperimentNotFoundError,
  ExperimentSetupError,
} from '../experiments/experiment-service.js';
import { IdempotencyConflictError, JobNotFoundError, UnknownCarrierError } from '../jobs/errors.js';
import { InvalidCursorError } from '../jobs/job-service.js';
import { InvalidTransitionError } from '../jobs/job-states.js';
import type { Logger } from '../shared/logger.js';

/**
 * Error contract. Every non-2xx response has the same shape:
 *
 *   { "error": { "code": "VALIDATION_ERROR", "message": "...", "details": ..., "requestId": "..." } }
 *
 * `code` is stable and machine-readable; `message` is for humans; `details` is optional.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): void {
  const requestId = res.getHeader('x-request-id');
  res.status(status).json({
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
      ...(typeof requestId === 'string' ? { requestId } : {}),
    },
  });
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof z.ZodError) {
    return new ApiError(
      400,
      'VALIDATION_ERROR',
      'request validation failed',
      error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  if (error instanceof JobNotFoundError || error instanceof ExperimentNotFoundError) {
    return new ApiError(404, 'NOT_FOUND', error.message);
  }
  if (error instanceof IdempotencyConflictError) {
    return new ApiError(409, 'IDEMPOTENCY_KEY_CONFLICT', error.message, {
      existingJobId: error.existingJobId,
    });
  }
  if (error instanceof InvalidTransitionError) {
    return new ApiError(409, 'INVALID_STATE_TRANSITION', error.message, {
      currentStatus: error.from,
      action: error.action,
    });
  }
  if (error instanceof UnknownCarrierError) {
    return new ApiError(400, 'UNKNOWN_CARRIER', error.message, { carrierId: error.carrierId });
  }
  if (error instanceof InvalidCursorError) {
    return new ApiError(400, 'INVALID_CURSOR', error.message);
  }
  if (error instanceof ExperimentSetupError) {
    return new ApiError(400, 'EXPERIMENT_SETUP_ERROR', error.message);
  }
  if (error instanceof MockCarrierControlError) {
    return new ApiError(502, 'MOCK_CARRIER_UNAVAILABLE', error.message);
  }
  const bodyParserType = (error as { type?: unknown } | null)?.type;
  if (bodyParserType === 'entity.parse.failed') {
    return new ApiError(400, 'INVALID_JSON', 'request body is not valid JSON');
  }
  if (bodyParserType === 'entity.too.large') {
    return new ApiError(413, 'PAYLOAD_TOO_LARGE', 'request body is too large');
  }
  return new ApiError(500, 'INTERNAL_ERROR', 'internal server error');
}

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, req, res, _next) => {
    const apiError = toApiError(error);
    if (apiError.status >= 500) {
      logger.error({ err: error, method: req.method, url: req.originalUrl }, 'request failed');
    }
    sendError(res, apiError.status, apiError.code, apiError.message, apiError.details);
  };
}

export const notFoundHandler: RequestHandler = (req, res) => {
  sendError(res, 404, 'ROUTE_NOT_FOUND', `no route for ${req.method} ${req.path}`);
};
