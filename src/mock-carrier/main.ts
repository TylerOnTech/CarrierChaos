import { loadConfig, loadDotEnv } from '../config/env.js';
import { createLogger } from '../shared/logger.js';
import { createMockCarrierApp } from './app.js';

loadDotEnv();
const config = loadConfig();
const logger = createLogger({
  service: 'mock-carrier',
  level: config.logLevel,
  pretty: config.logPretty,
});
const { app } = createMockCarrierApp({ adminToken: config.adminToken });

const server = app.listen(config.ports.mockCarrier, () => {
  logger.info({ port: config.ports.mockCarrier }, 'mock carrier API listening');
});

// Hanging "timeout" responses would otherwise keep the process alive for a minute on shutdown.
const shutdown = (signal: string) => {
  logger.info({ signal }, 'shutting down mock carrier');
  server.close(() => process.exit(0));
  server.closeAllConnections();
};
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
