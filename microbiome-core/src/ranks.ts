/**
 * Rank utilities shared by the non-parametric tests.
 *
 * Tie handling is the part that gets quietly wrong in hand-rolled versions:
 * tied values must receive the *average* of the ranks they span, and the
 * resulting tie group sizes are needed later to correct the test statistics'
 * variance. Both are returned together so a caller cannot forget the second.
 */

export interface RankResult {
  /** Average ranks, 1-based, in the same order as the input. */
  ranks: number[];
  /** Sizes of each group of tied values (groups of size 1 are omitted). */
  tieGroupSizes: number[];
}

export function rankWithTies(values: number[]): RankResult {
  const n = values.length;
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => values[a] - values[b],
  );

  const ranks = new Array<number>(n);
  const tieGroupSizes: number[] = [];

  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && values[order[j + 1]] === values[order[i]]) {
      j++;
    }

    const groupSize = j - i + 1;
    // Ranks are 1-based, so positions i..j map to ranks (i+1)..(j+1).
    const averageRank = (i + 1 + j + 1) / 2;

    for (let k = i; k <= j; k++) {
      ranks[order[k]] = averageRank;
    }

    if (groupSize > 1) {
      tieGroupSizes.push(groupSize);
    }

    i = j + 1;
  }

  return { ranks, tieGroupSizes };
}

/** Sum of (t^3 - t) over tie groups — the correction term used by both tests. */
export function tieCorrectionSum(tieGroupSizes: number[]): number {
  return tieGroupSizes.reduce((acc, t) => acc + (t * t * t - t), 0);
}
