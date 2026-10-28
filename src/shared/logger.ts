import { pino, type Logger } from 'pino';

export type { Logger };

export interface LoggerOptions {
  service: string;
  level: string;
  pretty?: boolean;
}

export function createLogger(options: LoggerOptions): Logger {
  return pino({
    level: options.level,
    base: { service: options.service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-admin-token"]',
        'headers.authorization',
        'accessToken',
      ],
      censor: '[redacted]',
    },
    ...(options.pretty
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss.l' } } }
      : {}),
  });
}

/** A logger that discards everything; handy for tests. */
export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
