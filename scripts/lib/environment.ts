import { execSync } from 'node:child_process';
import os from 'node:os';

/** Describes the machine a measurement ran on, so results are never quoted without context. */
export function describeEnvironment() {
  let commit = 'unknown';
  try {
    commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    // not a git checkout
  }
  const cpus = os.cpus();
  return {
    timestamp: new Date().toISOString(),
    gitCommit: commit,
    node: process.version,
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    cpu: `${cpus[0]?.model ?? 'unknown'} x ${cpus.length}`,
    memoryGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
  };
}

export type Environment = ReturnType<typeof describeEnvironment>;

export function environmentMarkdown(env: Environment, extra: Record<string, string> = {}): string {
  const rows = { ...env, memoryGb: `${env.memoryGb} GB`, ...extra };
  return [
    '| | |',
    '|---|---|',
    ...Object.entries(rows).map(([k, v]) => `| ${k} | ${String(v)} |`),
  ].join('\n');
}
