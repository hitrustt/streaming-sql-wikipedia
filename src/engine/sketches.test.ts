import { describe, expect, it } from 'vitest';
import { murmur3 } from './hash';
import { CountMinSketch, HyperLogLog, TDigest } from './sketches';

/** Deterministic PRNG so accuracy assertions cannot flake. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('murmur3', () => {
  it('is deterministic', () => {
    expect(murmur3('hello')).toBe(murmur3('hello'));
  });

  it('returns an unsigned 32-bit integer', () => {
    for (const s of ['', 'a', 'hello world', '日本語', 'x'.repeat(500)]) {
      const h = murmur3(s);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(2 ** 32);
    }
  });

  it('separates similar inputs', () => {
    expect(murmur3('user1')).not.toBe(murmur3('user2'));
    expect(murmur3('a', 0)).not.toBe(murmur3('a', 1));
  });

  it('distributes evenly across buckets', () => {
    // A weak hash would clump sequential keys, which is exactly the input
    // shape here (user1, user2, ...) and would quietly wreck HLL accuracy.
    const buckets = new Array(16).fill(0);
    for (let i = 0; i < 16000; i += 1) buckets[murmur3(`user${i}`) % 16] += 1;
    for (const count of buckets) {
      expect(count).toBeGreaterThan(800);
      expect(count).toBeLessThan(1200);
    }
  });
});

describe('HyperLogLog', () => {
  it.each([100, 1000, 10_000, 100_000])('estimates %i distinct within 3%%', (n) => {
    const hll = new HyperLogLog(12);
    for (let i = 0; i < n; i += 1) hll.add(`item${i}`);
    expect(Math.abs(hll.count() - n) / n).toBeLessThan(0.03);
  });

  it('is exact for a handful of values', () => {
    const hll = new HyperLogLog(12);
    for (const v of ['a', 'b', 'c', 'a', 'b']) hll.add(v);
    expect(hll.count()).toBe(3);
  });

  it('ignores duplicates', () => {
    const hll = new HyperLogLog(12);
    for (let i = 0; i < 1000; i += 1) hll.add('same');
    expect(hll.count()).toBe(1);
  });

  it('counts an empty sketch as zero', () => {
    expect(new HyperLogLog(12).count()).toBe(0);
  });

  it('merges as a union', () => {
    const a = new HyperLogLog(12);
    const b = new HyperLogLog(12);
    for (let i = 0; i < 5000; i += 1) a.add(`a${i}`);
    for (let i = 0; i < 5000; i += 1) b.add(i < 2500 ? `a${i}` : `b${i}`);
    a.merge(b);
    expect(Math.abs(a.count() - 7500) / 7500).toBeLessThan(0.05);
  });

  it('rejects merging different precisions', () => {
    expect(() => new HyperLogLog(12).merge(new HyperLogLog(10))).toThrow();
  });
});

describe('CountMinSketch', () => {
  it('never underestimates', () => {
    const cms = new CountMinSketch();
    const truth = new Map<string, number>();
    const random = rng(7);
    for (let i = 0; i < 20_000; i += 1) {
      const key = `k${Math.floor(random() * 500)}`;
      truth.set(key, (truth.get(key) ?? 0) + 1);
      cms.add(key);
    }
    for (const [key, count] of truth) {
      expect(cms.estimate(key)).toBeGreaterThanOrEqual(count);
    }
  });

  it('finds the dominant key', () => {
    const cms = new CountMinSketch(2048, 5, 20);
    for (let i = 0; i < 10_000; i += 1) cms.add('dominant');
    for (let i = 0; i < 5_000; i += 1) cms.add(`rare${i}`);
    expect(cms.heavyHitters(1)[0]![0]).toBe('dominant');
  });

  it('recovers most of the true top ten', () => {
    const cms = new CountMinSketch(4096, 5, 50);
    const truth = new Map<string, number>();
    const random = rng(11);
    for (let i = 0; i < 50_000; i += 1) {
      // Skewed distribution, so there are genuine heavy hitters to find.
      const key = `page${Math.floor(random() ** 3 * 2000)}`;
      truth.set(key, (truth.get(key) ?? 0) + 1);
      cms.add(key);
    }
    const trueTop = new Set(
      [...truth.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k]) => k),
    );
    const estTop = new Set(cms.heavyHitters(10).map(([k]) => k));
    const overlap = [...estTop].filter((k) => trueTop.has(k)).length;
    expect(overlap).toBeGreaterThanOrEqual(8);
  });

  it('returns zero for unseen keys', () => {
    expect(new CountMinSketch().estimate('never-added')).toBe(0);
  });
});

describe('TDigest', () => {
  it('tracks quantiles of a normal distribution', () => {
    const random = rng(3);
    const values: number[] = [];
    for (let i = 0; i < 20_000; i += 1) {
      // Box-Muller, so the distribution has a known shape.
      const u = Math.max(random(), 1e-9);
      values.push(100 + 15 * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random()));
    }
    const digest = new TDigest();
    for (const v of values) digest.add(v);

    const sorted = [...values].sort((a, b) => a - b);
    for (const q of [0.5, 0.9, 0.99]) {
      const expected = sorted[Math.floor(q * sorted.length)]!;
      expect(Math.abs(digest.quantile(q) - expected) / Math.abs(expected)).toBeLessThan(0.05);
    }
  });

  it('keeps the tail accurate on a skewed distribution', () => {
    const random = rng(5);
    const values = Array.from({ length: 20_000 }, () => Math.exp(random() * 6));
    const digest = new TDigest();
    for (const v of values) digest.add(v);
    const sorted = [...values].sort((a, b) => a - b);
    const p99 = sorted[Math.floor(0.99 * sorted.length)]!;
    expect(Math.abs(digest.quantile(0.99) - p99) / p99).toBeLessThan(0.1);
  });

  it('returns zero when empty', () => {
    expect(new TDigest().quantile(0.5)).toBe(0);
  });

  it('handles a single value', () => {
    const digest = new TDigest();
    digest.add(42);
    expect(digest.quantile(0.5)).toBe(42);
  });

  it('handles negative values', () => {
    const digest = new TDigest();
    for (let i = -500; i <= 500; i += 1) digest.add(i);
    expect(digest.quantile(0.5)).toBeGreaterThan(-30);
    expect(digest.quantile(0.5)).toBeLessThan(30);
  });
});
