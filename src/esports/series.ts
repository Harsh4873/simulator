/** Series math for independent maps. The page uses it only with a stated same-p assumption. */
export function seriesWinProbability(mapProbs: readonly number[], winsNeeded: number): number {
  const walk = (index: number, wins: number, losses: number): number => {
    if (wins >= winsNeeded) return 1;
    if (losses >= winsNeeded) return 0;
    if (index >= mapProbs.length) return 0;
    const chance = mapProbs[index] ?? 0;
    return chance * walk(index + 1, wins + 1, losses) + (1 - chance) * walk(index + 1, wins, losses + 1);
  };
  return walk(0, 0, 0);
}

export function overTwoAndAHalf(first: number, second: number): number {
  return first + second - 2 * first * second;
}

export function seriesFormat(label: string | null): { maps: number; wins: number } | null {
  const match = label?.match(/Bo([135])/i);
  if (!match) return null;
  const maps = Number(match[1]);
  return { maps, wins: (maps + 1) / 2 };
}
