/**
 * 32-bit MurmurHash3 for strings.
 *
 * The Python engine used 64-bit BLAKE2b digests, which do not survive the port:
 * JavaScript numbers are IEEE doubles with 53 bits of integer precision, so a
 * 64-bit hash would need BigInt, and BigInt in a per-row hot loop is roughly an
 * order of magnitude slower than plain arithmetic.
 *
 * 32 bits is enough here. The original HyperLogLog paper is specified against a
 * 32-bit hash, and the cardinalities this tracks (at most a few hundred thousand
 * distinct users in a 30-minute window) sit far below the range where 32-bit
 * collisions start to distort the estimate.
 */

export function murmur3(key: string, seed = 0): number {
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  let h = seed >>> 0;

  // Process the string two UTF-16 code units at a time to build 32-bit blocks.
  // Hashing charCodes rather than UTF-8 bytes is fine: the hash never leaves
  // this process, so it only has to be consistent, not standard.
  const len = key.length;
  const blocks = len >> 1;

  for (let i = 0; i < blocks; i += 1) {
    let k = (key.charCodeAt(i * 2) & 0xffff) | ((key.charCodeAt(i * 2 + 1) & 0xffff) << 16);
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }

  if (len & 1) {
    let k = key.charCodeAt(len - 1) & 0xffff;
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
  }

  // Finalization mix: without it, low-entropy inputs leave visible structure in
  // the low bits, which is exactly where HLL reads its register index.
  h ^= len;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;

  return h >>> 0;
}
