export type PropMarket = 'pts' | 'reb' | 'ast' | 'pra' | 'tpm' | 'stl' | 'blk' | 'tov';
export type PropSide = 'over' | 'under';

export interface PlayerSample {
  min: ArrayLike<number>;
  pts: ArrayLike<number>;
  reb: ArrayLike<number>;
  ast: ArrayLike<number>;
  tpm: ArrayLike<number>;
  stl?: ArrayLike<number>;
  blk?: ArrayLike<number>;
  tov?: ArrayLike<number>;
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

export type PriceStyle = 'american' | 'multiplier' | 'percent';

export interface BookPrice {
  breakEven: number;
  profit: number;
  style: PriceStyle;
  label: string;
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
  if (side === null || other === null) return null;
  return noVigFromBreakEven(side, other);
}

export function noVigFromBreakEven(side: number, other: number): number | null {
  if (!Number.isFinite(side) || !Number.isFinite(other) || side <= 0 || other <= 0) return null;
  return side / (side + other);
}

function trimNumber(value: number): string {
  return String(Number(value.toFixed(4)));
}

function markedStyle(compact: string): PriceStyle | null {
  if (compact.endsWith('%')) return 'percent';
  if (compact.endsWith('×') || /x$/i.test(compact) || /^x/i.test(compact)) return 'multiplier';
  if (compact.startsWith('+') || compact.startsWith('-')) return 'american';
  return null;
}

export function statedPriceStyle(raw: string, fallback: PriceStyle): PriceStyle {
  const compact = raw.trim().replace(/[$,\s]/g, '');
  return markedStyle(compact) ?? fallback;
}

function americanLabel(odds: number): string {
  return odds > 0 ? `+${trimNumber(odds)}` : trimNumber(odds);
}

function parseAmerican(text: string): BookPrice | null {
  const odds = Number(text);
  const breakEven = americanBreakEven(odds);
  const profit = profitPerStake(odds);
  if (breakEven === null || profit === null) return null;
  return { breakEven, profit, style: 'american', label: americanLabel(odds) };
}

function parseMultiplier(text: string): BookPrice | null {
  let body = text;
  if (body.endsWith('×')) body = body.slice(0, -1);
  else if (/x$/i.test(body)) body = body.slice(0, -1);
  else if (/^x/i.test(body)) body = body.slice(1);
  const decimal = Number(body);
  if (!Number.isFinite(decimal) || decimal <= 1) return null;
  return {
    breakEven: 1 / decimal,
    profit: decimal - 1,
    style: 'multiplier',
    label: `${trimNumber(decimal)}x`,
  };
}

function parsePercent(text: string): BookPrice | null {
  const marked = text.endsWith('%');
  const body = marked ? text.slice(0, -1) : text;
  const value = Number(body);
  if (!Number.isFinite(value)) return null;
  const probability = marked || value > 1 ? value / 100 : value;
  if (probability <= 0 || probability >= 1) return null;
  return {
    breakEven: probability,
    profit: (1 - probability) / probability,
    style: 'percent',
    label: `${trimNumber(probability * 100)}%`,
  };
}

export function parseBookPrice(raw: string, style: PriceStyle = 'american'): BookPrice | null {
  const compact = raw.trim().replace(/[$,\s]/g, '');
  if (compact === '') return null;
  const used = markedStyle(compact) ?? style;
  if (used === 'multiplier') return parseMultiplier(compact);
  if (used === 'percent') return parsePercent(compact);
  return parseAmerican(compact);
}

export function priceError(raw: string, fallback: PriceStyle): string {
  const style = statedPriceStyle(raw, fallback);
  if (style === 'multiplier') return 'A multiplier is the decimal return on $1, such as 1.91, and has to be greater than 1.';
  if (style === 'percent') return 'A percent is the book break-even chance and has to sit between 0 and 100.';
  return 'American odds must be -100 or lower, or +100 or higher.';
}

export function formatFairPrice(probability: number, style: PriceStyle): string | null {
  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) return null;
  if (style === 'multiplier') return `${trimNumber(1 / probability)}x`;
  if (style === 'percent') return `${trimNumber(probability * 100)}%`;
  const american = fairAmericanOdds(probability);
  if (american === null) return null;
  return american > 0 ? `+${american}` : `${american}`;
}

function asPrice(odds: number | BookPrice): BookPrice | null {
  if (typeof odds === 'number') return parseAmerican(String(odds));
  if (!Number.isFinite(odds.breakEven) || !Number.isFinite(odds.profit)) return null;
  if (odds.breakEven <= 0 || odds.breakEven >= 1 || odds.profit <= 0) return null;
  return odds;
}

export function fairAmericanOdds(probability: number): number | null {
  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) return null;
  if (probability >= 0.5) return -Math.round((100 * probability) / (1 - probability));
  return Math.round((100 * (1 - probability)) / probability);
}

function valueAt(sample: PlayerSample, index: number, market: PropMarket): number {
  if (market === 'stl' || market === 'blk' || market === 'tov') return sample[market]?.[index] ?? NaN;
  if (market === 'pts') return sample.pts[index];
  if (market === 'reb') return sample.reb[index];
  if (market === 'ast') return sample.ast[index];
  if (market === 'tpm') return sample.tpm[index];
  return sample.pts[index] + sample.reb[index] + sample.ast[index];
}

export function gradeProp(sample: PlayerSample, market: PropMarket, side: PropSide, line: number): PropGrade {
  if(!Number.isFinite(line)||line<0||!Number.isInteger(line*2))throw new Error('Line must be a nonnegative whole or half point');
  const count = sample.min.length;
  const series=market==='pra'?[sample.pts,sample.reb,sample.ast]:[sample[market]];
  if(series.some(xs=>!xs||xs.length!==count||Array.from(xs).some(v=>!Number.isFinite(v)||v<0)))throw new Error('Missing or invalid stat samples');
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

/**
 * Decision policy for the prop panel.
 *
 * The sportsbook price is applied only after the simulations exist. It does not
 * change who plays, the rates, or the 10,000 draws.
 *
 * A verdict needs more than a large edge. The win rate has to beat the price,
 * the expected return has to survive pushes and games not played, the gap has
 * to clear sampling noise, and the player data has to be usable.
 *
 * `calibrated` stays false until a walk-forward backtest has checked these
 * probabilities. While it is false the panel can say LEAN or PASS, never BET.
 * A gap of `extremeEdge` or more is a reliability problem, not a recommendation,
 * even after calibration is turned on.
 */
export const PROP_POLICY = {
  calibrated: false,
  leanEdge: 0.03,
  leanReturn: 0.01,
  betEdge: 0.08,
  betReturn: 0.05,
  extremeEdge: 0.25,
  maxVoidShare: 0.35,
  minDecided: 200,
  noiseMultiple: 1.96,
} as const;

export interface PropPolicy {
  calibrated: boolean;
  leanEdge: number;
  leanReturn: number;
  betEdge: number;
  betReturn: number;
  extremeEdge: number;
  maxVoidShare: number;
  minDecided: number;
  noiseMultiple: number;
}

export type PropVerdict = 'BET' | 'LEAN' | 'PASS';

export interface PropContext {
  available: boolean;
  missingShooting: boolean;
  thinSample: boolean;
  onCard: boolean;
}

export interface VerdictResult {
  verdict: PropVerdict;
  text: string;
}

export function propContextFromPlayer(player: {
  minutes_weight?: number;
  missing_shooting?: boolean;
  shooting_games?: number;
  thin_sample?: boolean;
} | null): PropContext {
  if (!player) return { available: false, missingShooting: true, thinSample: true, onCard: false };
  return {
    available: player.minutes_weight !== 0,
    missingShooting: player.missing_shooting === true || player.shooting_games === 0,
    thinSample: player.thin_sample === true,
    onCard: true,
  };
}

function usesShooting(market: PropMarket): boolean {
  return market === 'pts' || market === 'pra' || market === 'tpm';
}

function pass(text: string): VerdictResult {
  return { verdict: 'PASS', text };
}

export function decideVerdict(
  quote: PropQuote,
  context: PropContext,
  market: PropMarket,
  policy: PropPolicy = PROP_POLICY,
): VerdictResult | null {
  if (quote.breakEven === null || quote.expectedReturn === null) return null;
  const decided = quote.grade.wins + quote.grade.losses;
  const total = decided + quote.grade.pushes + quote.grade.voids;
  const voidShare = total === 0 ? 1 : quote.grade.voids / total;
  if (!context.available) {
    return pass('This player does not play in the simulations, so the prop is not graded.');
  }
  if (total === 0 || voidShare > policy.maxVoidShare) {
    return pass('This player sits out of too many simulations for the price to be useful.');
  }
  if (quote.modelProbability === null || quote.edge === null || decided < policy.minDecided) {
    return pass('Too few simulated games decide this prop, so the price comparison is not useful.');
  }
  if (Math.abs(quote.edge) >= policy.extremeEdge) {
    return pass('The simulations and the sportsbook price disagree by too much to trust. That gap needs a reliability check before it is a recommendation.');
  }
  const noise = quote.standardError === null ? Number.POSITIVE_INFINITY : policy.noiseMultiple * quote.standardError;
  const favored = quote.edge >= policy.leanEdge && quote.expectedReturn >= policy.leanReturn && quote.edge > noise;
  if (!favored) {
    if (quote.edge >= policy.leanEdge && quote.expectedReturn < policy.leanReturn) {
      return pass('The win rate beats the sportsbook price, but pushes and missed games take the return away.');
    }
    if (quote.edge >= policy.leanEdge && quote.edge <= noise) {
      return pass('The gap is inside the sampling noise, so it is not an advantage yet.');
    }
    return pass('The simulations do not clear this line often enough to beat the sportsbook price.');
  }
  if (!context.onCard) {
    return pass('This player is not on the rate card, so the price is hard to trust.');
  }
  if (usesShooting(market) && context.missingShooting) {
    return pass('Shot rates for this player are a prior, so this price is hard to trust.');
  }
  const strong =
    policy.calibrated &&
    !context.thinSample &&
    quote.edge >= policy.betEdge &&
    quote.expectedReturn >= policy.betReturn;
  if (strong) {
    return {
      verdict: 'BET',
      text: 'The simulations clear this price by a wide margin, the player data is in place, and the probabilities have been checked against past games.',
    };
  }
  if (context.thinSample) {
    return {
      verdict: 'LEAN',
      text: 'The simulations favor this price, but the player sample is thin, so this is not a confident recommendation.',
    };
  }
  if (!policy.calibrated) {
    return {
      verdict: 'LEAN',
      text: 'The simulations hit this line more often than the sportsbook price requires, but the model has not yet been historically calibrated.',
    };
  }
  return {
    verdict: 'LEAN',
    text: 'The simulations favor this price, but the advantage is modest.',
  };
}

export function quoteProp(
  sample: PlayerSample | null,
  market: PropMarket,
  side: PropSide,
  line: number,
  odds: number | BookPrice,
  oppositeOdds?: number | BookPrice | null,
): PropQuote | null {
  if (!sample || sample.min.length === 0 || !Number.isFinite(line) || line < 0 || !Number.isInteger(line*2)) return null;
  if ((market === 'stl' || market === 'blk' || market === 'tov') && !sample[market]) return null;
  const grade = gradeProp(sample, market, side, line);
  const decided = grade.wins + grade.losses;
  const modelProbability = decided === 0 ? null : grade.wins / decided;
  const price = asPrice(odds);
  const breakEven = price?.breakEven ?? null;
  const profit = price?.profit ?? null;
  const total = grade.wins + grade.losses + grade.pushes + grade.voids;
  const expectedReturn = profit === null || total === 0 ? null : (grade.wins * profit - grade.losses) / total;
  const edge = modelProbability === null || breakEven === null ? null : modelProbability - breakEven;
  const standardError =
    modelProbability === null || decided === 0 ? null : Math.sqrt((modelProbability * (1 - modelProbability)) / decided);
  const opposite = oppositeOdds === undefined || oppositeOdds === null ? null : asPrice(oppositeOdds);
  const noVig =
    price === null || opposite === null ? null : noVigFromBreakEven(price.breakEven, opposite.breakEven);
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
