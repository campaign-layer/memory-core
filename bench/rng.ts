// Seeded deterministic PRNG. No Math.random() anywhere in the harness.

/** FNV-1a 32-bit string hash. Stable across runs and platforms. */
export function hashString(input: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, well-distributed 32-bit PRNG. */
export class Rng {
  private state: number;

  constructor(seed: number | string) {
    this.state = (typeof seed === "number" ? seed >>> 0 : hashString(seed)) || 0x9e3779b9;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("Rng.pick on empty array");
    return items[this.int(0, items.length - 1)]!;
  }

  /** Fisher-Yates on a copy. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const tmp = out[i]!;
      out[i] = out[j]!;
      out[j] = tmp;
    }
    return out;
  }
}

/**
 * Draws from a pool without replacement so every generated entity is unique.
 * Throws rather than silently repeating - a repeated anchor would make gold labels ambiguous.
 */
export class UniquePool<T> {
  private readonly order: T[];
  private cursor = 0;

  constructor(items: readonly T[], rng: Rng, private readonly label = "pool") {
    this.order = rng.shuffle(items);
  }

  take(): T {
    if (this.cursor >= this.order.length) {
      throw new Error(`UniquePool "${this.label}" exhausted after ${this.order.length} draws`);
    }
    return this.order[this.cursor++]!;
  }

  get remaining(): number {
    return this.order.length - this.cursor;
  }
}

/** Cartesian product of two pools, shuffled — cheap way to get thousands of unique names. */
export function crossPool(a: readonly string[], b: readonly string[], joiner = " "): string[] {
  const out: string[] = [];
  for (const x of a) for (const y of b) out.push(`${x}${joiner}${y}`);
  return out;
}
