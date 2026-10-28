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
  odds: number | BookPrice,
  oppositeOdds?: number | BookPrice | null,
): PropQuote | null {
  if (!sample || sample.min.length === 0 || !Number.isFinite(line)) return null;
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
