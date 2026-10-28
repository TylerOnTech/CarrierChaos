import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { defineConfig } from 'prisma/config';

// Prisma 7 no longer reads .env on its own. Load it without overriding variables that are
// already set, so CI and Docker environment variables always win.
if (existsSync('.env')) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync('.env', 'utf8')))) {
    process.env[key] ??= value;
  }
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // `prisma generate` does not need a database, so tolerate a missing URL (e.g. in Docker builds).
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
