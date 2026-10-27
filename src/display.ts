export interface WinCounts {
  away: number;
  tie: number;
  home: number;
}

export type TypicalityBucket = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export function empiricalPercent(sortedAsc: readonly number[], value: number): number {
  let lo = 0;
  let hi = sortedAsc.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedAsc[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return sortedAsc.length === 0 ? 50 : (100 * lo) / sortedAsc.length;
}

export function shownPercent(sortedAsc: readonly number[], value: number): number {
  return Math.round(empiricalPercent(sortedAsc, value));
}

export function typicalityBucket(percent: number, constant: boolean): TypicalityBucket {
  if (constant) return 0;
  const distance = Math.abs(percent - 50);
  if (distance < 8) return 0;
  if (distance < 16) return 1;
  if (distance < 24) return 2;
  if (distance < 32) return 3;
  if (distance < 40) return 4;
  if (distance < 46) return 5;
  return 6;
}

export function winCounts(awayPoints: ArrayLike<number>, homePoints: ArrayLike<number>): WinCounts {
  if (awayPoints.length !== homePoints.length) throw new Error('team point arrays differ in length');
  let away = 0;
  let tie = 0;
  let home = 0;
  for (let i = 0; i < awayPoints.length; i += 1) {
    if (awayPoints[i] > homePoints[i]) away += 1;
    else if (homePoints[i] > awayPoints[i]) home += 1;
    else tie += 1;
  }
  return { away, tie, home };
}

export function nextPanelAthlete(current: string | null, clicked: string | null): string | null {
  if (clicked === null) return null;
  if (current === clicked) return null;
  return clicked;
}
