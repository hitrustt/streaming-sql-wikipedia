import { murmur3 } from './hash';

/**
 * Probabilistic sketches, implemented from the papers rather than pulled from a
 * library.
 *
 * The ring buffer holds a bounded window exactly. Anything longer is answered
 * from these, because retaining hours of raw events in a browser tab is not an
 * option while the questions asked of that horizon ("roughly how many distinct
 * editors?", "which pages were hottest?") tolerate 1-2% error.
 */

/**
 * Distinct-count estimation in fixed memory.
 *
 * Standard HLL with the corrections from Flajolet et al.: linear counting on the
 * low end where the raw estimate is badly biased, and the large-range correction
 * near the 32-bit hash ceiling. p=12 uses 4KB per sketch for ~1.6% standard
 * error, which is the right trade in a browser where several of these exist per
 * rollup bucket.
 */
export class HyperLogLog {
  readonly p: number;
  readonly m: number;
  private registers: Uint8Array;
  private alpha: number;

  constructor(p = 12) {
    if (p < 4 || p > 16) throw new Error('p must be between 4 and 16');
    this.p = p;
    this.m = 1 << p;
    this.registers = new Uint8Array(this.m);
    this.alpha =
      this.m === 16 ? 0.673 :
      this.m === 32 ? 0.697 :
      this.m === 64 ? 0.709 :
      0.7213 / (1 + 1.079 / this.m);
  }

  add(value: string): void {
    const h = murmur3(value);
    const index = h >>> (32 - this.p);
    // Rank is the position of the leftmost 1 in the remaining bits. Shifting
    // the index bits out and counting leading zeros gives it directly.
    const rest = (h << this.p) >>> 0;
    const rank = rest === 0 ? 32 - this.p + 1 : Math.clz32(rest) + 1;
    if (rank > this.registers[index]!) this.registers[index] = rank;
  }

  count(): number {
    let sum = 0;
    let zeros = 0;
    for (let i = 0; i < this.m; i += 1) {
      const r = this.registers[i]!;
      sum += 2 ** -r;
      if (r === 0) zeros += 1;
    }

    const raw = (this.alpha * this.m * this.m) / sum;

    // Linear counting is far more accurate while registers are still sparse.
    if (raw <= 2.5 * this.m && zeros > 0) {
      return Math.round(this.m * Math.log(this.m / zeros));
    }

    // Large-range correction for hash saturation near 2^32.
    const limit = 2 ** 32 / 30;
    if (raw > limit) {
      return Math.round(-(2 ** 32) * Math.log(1 - raw / 2 ** 32));
    }

    return Math.round(raw);
  }

  merge(other: HyperLogLog): void {
    if (other.p !== this.p) throw new Error('cannot merge HLLs with different precision');
    for (let i = 0; i < this.m; i += 1) {
      const r = other.registers[i]!;
      if (r > this.registers[i]!) this.registers[i] = r;
    }
  }
}

/**
 * Frequency estimation for heavy hitters.
 *
 * Paired with an explicit candidate map: the sketch answers "how often has this
 * key been seen" in constant space, and the map remembers which keys are worth
 * reporting. Count-Min only ever overestimates, so a genuine heavy hitter can
 * never be missed by the candidate set.
 */
export class CountMinSketch {
  private readonly width: number;
  private readonly depth: number;
  private readonly table: Int32Array[];
  private readonly seeds: number[];
  private readonly k: number;
  private top = new Map<string, number>();

  constructor(width = 2048, depth = 5, k = 100) {
    this.width = width;
    this.depth = depth;
    this.k = k;
    this.table = Array.from({ length: depth }, () => new Int32Array(width));
    this.seeds = Array.from({ length: depth }, (_, i) => Math.imul(i + 1, 0x9e3779b1) >>> 0);
  }

  private index(key: string, row: number): number {
    return murmur3(key, this.seeds[row]!) % this.width;
  }

  add(key: string, count = 1): number {
    let estimate = Infinity;
    for (let d = 0; d < this.depth; d += 1) {
      const idx = this.index(key, d);
      const next = this.table[d]![idx]! + count;
      this.table[d]![idx] = next;
      if (next < estimate) estimate = next;
    }

    this.top.set(key, estimate);
    if (this.top.size > this.k * 4) {
      const kept = [...this.top.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, this.k * 2);
      this.top = new Map(kept);
    }
    return estimate;
  }

  estimate(key: string): number {
    let min = Infinity;
    for (let d = 0; d < this.depth; d += 1) {
      const v = this.table[d]![this.index(key, d)]!;
      if (v < min) min = v;
    }
    return min === Infinity ? 0 : min;
  }

  heavyHitters(n: number): Array<[string, number]> {
    return [...this.top.keys()]
      .map((key) => [key, this.estimate(key)] as [string, number])
      .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))
      .slice(0, n);
  }
}

/**
 * Rank-accurate quantile estimation over a stream.
 *
 * A simplified t-digest: values are kept as weighted centroids, compressed when
 * the buffer grows, with a scale function that keeps centroids small at the
 * tails and coarse in the middle. That is what makes p99 accurate while using
 * bounded memory. A fixed-bucket histogram gets the tail badly wrong, which is
 * the part anyone actually cares about.
 */
export class TDigest {
  private centroids: Array<[number, number]> = []; // [mean, weight]
  private buffer: number[] = [];
  private readonly compression: number;

  constructor(compression = 100) {
    this.compression = compression;
  }

  add(value: number): void {
    this.buffer.push(value);
    if (this.buffer.length > 1000) this.flush();
  }

  private flush(): void {
    if (this.buffer.length === 0) return;
    for (const v of this.buffer) this.centroids.push([v, 1]);
    this.buffer.length = 0;
    this.compress();
  }

  private compress(): void {
    if (this.centroids.length === 0) return;
    this.centroids.sort((a, b) => a[0] - b[0]);

    let total = 0;
    for (const [, w] of this.centroids) total += w;
    if (total === 0) return;

    const merged: Array<[number, number]> = [];
    let q0 = 0;
    let current: [number, number] = [this.centroids[0]![0], this.centroids[0]![1]];

    for (let i = 1; i < this.centroids.length; i += 1) {
      const [mean, weight] = this.centroids[i]!;
      const proposed = current[1] + weight;
      const q = q0 + proposed / total;
      // Bound from the k-scale function: a centroid may only grow as large as
      // the local quantile density allows, which keeps the tails fine-grained.
      const limit = (4 * total * q * (1 - q)) / this.compression;

      if (proposed <= Math.max(limit, 1)) {
        current[0] = (current[0] * current[1] + mean * weight) / proposed;
        current[1] = proposed;
      } else {
        merged.push(current);
        q0 += current[1] / total;
        current = [mean, weight];
      }
    }
    merged.push(current);
    this.centroids = merged;
  }

  /** q in [0, 1]. Returns 0 for an empty digest. */
  quantile(q: number): number {
    this.flush();
    if (this.centroids.length === 0) return 0;

    let total = 0;
    for (const [, w] of this.centroids) total += w;

    const target = q * total;
    let acc = 0;

    for (let i = 0; i < this.centroids.length; i += 1) {
      const [mean, weight] = this.centroids[i]!;
      if (acc + weight >= target) {
        if (i === 0 || i === this.centroids.length - 1) return mean;
        const prevMean = this.centroids[i - 1]![0];
        const frac = weight ? (target - acc) / weight : 0;
        return prevMean + (mean - prevMean) * frac;
      }
      acc += weight;
    }

    return this.centroids[this.centroids.length - 1]![0];
  }
}
