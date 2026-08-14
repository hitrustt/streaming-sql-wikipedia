"""Probabilistic sketches for the long-horizon rollups.

The ring buffer holds ~30 minutes exactly. Anything longer than that is
answered from these, because retaining 24 hours of raw events costs gigabytes
while the questions people actually ask of that horizon ("roughly how many
distinct editors?", "which pages were hottest?") tolerate 1-2% error.

Implemented from the papers rather than pulled from a library -- these are the
part of the system worth being asked about.
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass, field


def _hash64(value: str) -> int:
    return int.from_bytes(hashlib.blake2b(value.encode("utf-8"), digest_size=8).digest(), "big")


class HyperLogLog:
    """Distinct-count estimation in fixed memory.

    Standard HLL with the bias corrections from Flajolet et al.: linear
    counting on the low end where the raw estimate is badly biased, and the
    large-range correction near the 32-bit hash ceiling. With p=14 this uses
    16KB per sketch for ~0.8% standard error.
    """

    __slots__ = ("p", "m", "registers", "_alpha")

    def __init__(self, p: int = 14):
        if not 4 <= p <= 18:
            raise ValueError("p must be between 4 and 18")
        self.p = p
        self.m = 1 << p
        self.registers = bytearray(self.m)
        # Bias constant; the general form is inaccurate for small m.
        if self.m == 16:
            self._alpha = 0.673
        elif self.m == 32:
            self._alpha = 0.697
        elif self.m == 64:
            self._alpha = 0.709
        else:
            self._alpha = 0.7213 / (1.0 + 1.079 / self.m)

    def add(self, value: str) -> None:
        h = _hash64(value)
        idx = h >> (64 - self.p)
        # Number of leading zeros in the remaining bits, plus one.
        rest = (h << self.p) & ((1 << 64) - 1)
        rank = 1 if rest == 0 else 64 - rest.bit_length() + 1
        rank = min(rank, 64 - self.p + 1)
        if rank > self.registers[idx]:
            self.registers[idx] = rank

    def count(self) -> int:
        raw = self._alpha * self.m * self.m / sum(2.0 ** -r for r in self.registers)
        if raw <= 2.5 * self.m:
            zeros = self.registers.count(0)
            if zeros:
                # Linear counting is far more accurate when registers are sparse.
                return int(round(self.m * math.log(self.m / zeros)))
        return int(round(raw))

    def merge(self, other: "HyperLogLog") -> None:
        if other.p != self.p:
            raise ValueError("cannot merge HLLs with different precision")
        for i, r in enumerate(other.registers):
            if r > self.registers[i]:
                self.registers[i] = r


class CountMinSketch:
    """Frequency estimation for heavy hitters.

    Paired with an explicit top-K heap: the sketch answers "how often has this
    key been seen" in constant space, and the heap remembers which keys are
    worth reporting. Count-Min only ever overestimates, so the heap can be
    trusted not to miss a genuine heavy hitter.
    """

    __slots__ = ("width", "depth", "table", "_seeds", "top", "k")

    def __init__(self, width: int = 2048, depth: int = 5, k: int = 100):
        self.width = width
        self.depth = depth
        self.k = k
        self.table = [[0] * width for _ in range(depth)]
        self._seeds = [i * 0x9E3779B1 for i in range(depth)]
        self.top: dict[str, int] = {}

    def _indexes(self, key: str):
        h = _hash64(key)
        for d, seed in enumerate(self._seeds):
            yield d, ((h ^ seed) * 0x100000001B3) % self.width

    def add(self, key: str, count: int = 1) -> int:
        estimate = None
        for d, idx in self._indexes(key):
            self.table[d][idx] += count
            v = self.table[d][idx]
            estimate = v if estimate is None else min(estimate, v)
        assert estimate is not None

        # Maintain the candidate set for top-K.
        self.top[key] = estimate
        if len(self.top) > self.k * 4:
            keep = sorted(self.top.items(), key=lambda kv: kv[1], reverse=True)[: self.k * 2]
            self.top = dict(keep)
        return estimate

    def estimate(self, key: str) -> int:
        return min(self.table[d][idx] for d, idx in self._indexes(key))

    def heavy_hitters(self, n: int) -> list[tuple[str, int]]:
        items = ((k, self.estimate(k)) for k in self.top)
        return sorted(items, key=lambda kv: (-kv[1], kv[0]))[:n]


@dataclass
class TDigest:
    """Rank-accurate quantile estimation over a stream.

    A simplified t-digest: values are kept as weighted centroids, compressed
    when the buffer grows, with a scale function that keeps centroids tiny at
    the tails and coarse in the middle. That is what makes p99 accurate while
    still using bounded memory -- a plain histogram with fixed buckets gets the
    tail badly wrong, which is exactly the part anyone cares about.
    """

    compression: float = 100.0
    centroids: list[list[float]] = field(default_factory=list)  # [mean, weight]
    count: float = 0.0
    _buffer: list[float] = field(default_factory=list)

    def add(self, value: float, weight: float = 1.0) -> None:
        self._buffer.append(value)
        self.count += weight
        if len(self._buffer) > 1000:
            self._flush()

    def _flush(self) -> None:
        if not self._buffer:
            return
        for v in self._buffer:
            self.centroids.append([v, 1.0])
        self._buffer.clear()
        self._compress()

    def _compress(self) -> None:
        if not self.centroids:
            return
        self.centroids.sort(key=lambda c: c[0])
        total = sum(c[1] for c in self.centroids)
        if total == 0:
            return

        merged: list[list[float]] = []
        q0 = 0.0
        cur = list(self.centroids[0])
        for mean, weight in self.centroids[1:]:
            proposed = cur[1] + weight
            q = q0 + proposed / total
            # Bound derived from the k-scale function; centroids may only grow
            # as large as the local quantile density allows.
            limit = 4 * total * q * (1 - q) / self.compression
            if proposed <= max(limit, 1.0):
                cur[0] = (cur[0] * cur[1] + mean * weight) / proposed
                cur[1] = proposed
            else:
                merged.append(cur)
                q0 += cur[1] / total
                cur = [mean, weight]
        merged.append(cur)
        self.centroids = merged

    def quantile(self, q: float) -> float:
        """q in [0, 1]. Returns 0.0 for an empty digest."""
        self._flush()
        if not self.centroids:
            return 0.0
        total = sum(c[1] for c in self.centroids)
        target = q * total
        acc = 0.0
        for i, (mean, weight) in enumerate(self.centroids):
            if acc + weight >= target:
                if i == 0 or i == len(self.centroids) - 1:
                    return mean
                # Interpolate between neighbouring centroid means.
                prev_mean = self.centroids[i - 1][0]
                frac = (target - acc) / weight if weight else 0.0
                return prev_mean + (mean - prev_mean) * frac
            acc += weight
        return self.centroids[-1][0]
