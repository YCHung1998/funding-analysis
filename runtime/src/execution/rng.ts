/**
 * runtime/src/execution/rng.ts
 *
 * Dependency-free seeded PRNG (design.md Decision 3): `mulberry32` is the
 * generator, `hash32` derives a 32-bit seed from `(seed, client_order_id)`
 * so every order gets its own independent stream — same seed + same inputs
 * always reproduce identical decisions regardless of event interleaving
 * (spec "Simulated latency and reproducible failure injection").
 */

/** FNV-1a-style 32-bit string hash, deterministic across runs (no crypto). */
export function hash32(...parts: Array<string | number>): number {
  let hash = 0x811c9dc5;
  const input = parts.join('|');
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A mulberry32 PRNG instance: `next()` returns a float in [0, 1). */
export interface Rng {
  next(): number;
}

/** mulberry32 — small, fast, dependency-free 32-bit PRNG. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next(): number {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/**
 * Per-order PRNG stream: `stream(seed, client_order_id)`. Each order gets an
 * independent generator derived from the global seed and its own
 * `client_order_id`, so the order in which orders are created/processed does
 * not affect any individual order's sequence of random decisions.
 */
export function stream(seed: number, clientOrderId: string): Rng {
  return mulberry32(hash32(seed, clientOrderId));
}
