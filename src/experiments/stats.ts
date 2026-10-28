export interface Distribution {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  mean: number | null;
}

/** Nearest-rank percentile (p in (0, 100]) over an ascending-sorted array. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export function distribution(values: readonly number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.length ? sorted[sorted.length - 1]! : null,
    mean: sorted.length ? Math.round(sum / sorted.length) : null,
  };
}

export function countBy<T>(items: readonly T[], key: (item: T) => string | null | undefined) {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    if (k === null || k === undefined) continue;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}
