import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createMockCarrierApp } from '../../src/mock-carrier/app.js';

export const TEST_ADMIN_TOKEN = 'test-admin-token';

/** Starts the mock carrier API on an ephemeral port. */
export async function startMockCarrier() {
  const { app, registry } = createMockCarrierApp({ adminToken: TEST_ADMIN_TOKEN });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    registry,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export type MockCarrier = Awaited<ReturnType<typeof startMockCarrier>>;
