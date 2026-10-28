export type PropMarket = 'pts' | 'reb' | 'ast' | 'pra' | 'tpm';
export type PropSide = 'over' | 'under';

export interface PlayerSample {
  min: ArrayLike<number>;
  pts: ArrayLike<number>;
  reb: ArrayLike<number>;
  ast: ArrayLike<number>;
  tpm: ArrayLike<number>;
}

export interface PropGrade {
  wins: number;
  losses: number;
  pushes: number;
  voids: number;
}

export interface PropQuote {
  grade: PropGrade;
  modelProbability: number | null;
  breakEven: number | null;
  edge: number | null;
  expectedReturn: number | null;
  fairAmerican: number | null;
  noVig: number | null;
  standardError: number | null;
}

export function americanBreakEven(odds: number): number | null {
  if (!Number.isFinite(odds) || Math.abs(odds) < 100) return null;
  if (odds < 0) return -odds / (-odds + 100);
  return 100 / (odds + 100);
}

export function profitPerStake(odds: number): number | null {
  if (!Number.isFinite(odds) || Math.abs(odds) < 100) return null;
  if (odds < 0) return 100 / -odds;
  return odds / 100;
}

export function noVigProbability(odds: number, oppositeOdds: number): number | null {
  const side = americanBreakEven(odds);
  const other = americanBreakEven(oppositeOdds);
  if (side === null || other === null || side + other === 0) return null;
  return side / (side + other);
}

export function fairAmericanOdds(probability: number): number | null {
  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) return null;
  if (probability >= 0.5) return -Math.round((100 * probability) / (1 - probability));
  return Math.round((100 * (1 - probability)) / probability);
}

function valueAt(sample: PlayerSample, index: number, market: PropMarket): number {
  if (market === 'pts') return sample.pts[index];
  if (market === 'reb') return sample.reb[index];
  if (market === 'ast') return sample.ast[index];
  if (market === 'tpm') return sample.tpm[index];
  return sample.pts[index] + sample.reb[index] + sample.ast[index];
}

export function gradeProp(sample: PlayerSample, market: PropMarket, side: PropSide, line: number): PropGrade {
  const count = sample.min.length;
  const grade: PropGrade = { wins: 0, losses: 0, pushes: 0, voids: 0 };
  for (let index = 0; index < count; index += 1) {
    if (!(sample.min[index] > 0)) {
      grade.voids += 1;
      continue;
    }
    const value = valueAt(sample, index, market);
    if (value === line) {
      grade.pushes += 1;
      continue;
    }
    const hit = side === 'over' ? value > line : value < line;
    if (hit) grade.wins += 1;
    else grade.losses += 1;
  }
  return grade;
}

export function quoteProp(
  sample: PlayerSample | null,
  market: PropMarket,
  side: PropSide,
  line: number,
  odds: number,
  oppositeOdds?: number | null,
): PropQuote | null {
  if (!sample || sample.min.length === 0 || !Number.isFinite(line)) return null;
  const grade = gradeProp(sample, market, side, line);
  const decided = grade.wins + grade.losses;
  const modelProbability = decided === 0 ? null : grade.wins / decided;
  const breakEven = americanBreakEven(odds);
  const profit = profitPerStake(odds);
  const total = grade.wins + grade.losses + grade.pushes + grade.voids;
  const expectedReturn = profit === null || total === 0 ? null : (grade.wins * profit - grade.losses) / total;
  const edge = modelProbability === null || breakEven === null ? null : modelProbability - breakEven;
  const standardError =
    modelProbability === null || decided === 0 ? null : Math.sqrt((modelProbability * (1 - modelProbability)) / decided);
  const noVig =
    oppositeOdds === undefined || oppositeOdds === null ? null : noVigProbability(odds, oppositeOdds);
  return {
    grade,
    modelProbability,
    breakEven,
    edge,
    expectedReturn,
    fairAmerican: modelProbability === null ? null : fairAmericanOdds(modelProbability),
    noVig,
    standardError,
  };
}
