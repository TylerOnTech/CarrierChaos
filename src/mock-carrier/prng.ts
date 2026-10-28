/**
 * Small, fast, seedable PRNG utilities. Not cryptographic; used only for reproducible fault
 * injection and synthetic data.
 */

/** 32-bit FNV-1a hash of a string. */
export function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Mulberry32: returns a generator of floats in [0, 1) for a 32-bit seed. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A generator seeded from arbitrary string parts. */
export function seededRandom(...parts: Array<string | number>): () => number {
  return mulberry32(hashString(parts.join('|')));
}

export function pick<T>(random: () => number, items: readonly T[]): T {
  if (items.length === 0) throw new RangeError('cannot pick from an empty list');
  return items[Math.floor(random() * items.length)]!;
}

export function intBetween(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}
