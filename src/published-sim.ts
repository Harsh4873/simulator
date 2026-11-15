import { valueAt, type PlayerSample } from './props.ts';
import type { ScenarioView, Simulation, ToneSeries } from './simulate.ts';

/**
 * One game's 10,000 draws, published by the deploy job so a phone does not have to run them.
 *
 * The summary holds every figure the simulation computes for itself (scores, means, ranges, the shown draw). The rest of
 * the page only ever asks one stat at a time how often it lands above, below or on a number, among the draws a player
 * played. Counts answer that exactly, so the per-draw arrays become the number of draws at each value. Draw order and
 * the pairing of two different stats are not kept, which is why a combined stat or a milestone is counted on its own.
 */
export const PUBLISHED_SIM_SCHEMA = 1;

/** Counts from a lowest value upward: `counts[i]` draws landed on `from + i`. */
export interface OffsetCounts {
  from: number;
  counts: number[];
}

/** Draws a player played and, among them, how many landed on each value of each stat (index = value). */
export interface PublishedPlayer {
  played: number;
  min: number[];
  pts: number[];
  reb: number[];
  ast: number[];
  tpm: number[];
  stl?: number[];
  blk?: number[];
  tov?: number[];
  pra: number[];
  pa: number[];
  pr: number[];
  ra: number[];
  /** Played draws with a double-double and with a triple-double. Present only when steals and blocks are simulated. */
  dd?: number;
  td?: number;
}

export type PublishedSummary = Omit<Simulation, 'playerDraws' | 'combinedTotals' | 'awayTotals' | 'homeTotals' | 'upside' | 'margins' | 'published'>;

export interface PublishedExpectation {
  event_id: string;
  generated_at: string | null;
  input_hash: string | null;
  model_hash: string | null;
  seed: number;
  iterations: number;
}

export interface PublishedSim extends PublishedExpectation {
  schema_version: 1;
  summary: PublishedSummary;
  /** Combined points, and home points minus away points. */
  totals: OffsetCounts;
  margins: OffsetCounts;
  players: Record<string, PublishedPlayer>;
}

export interface PublishedIndex extends Omit<PublishedExpectation, 'event_id' | 'seed'> {
  schema_version: 1;
  events: string[];
}

const COMBINED = ['pra', 'pa', 'pr', 'ra'] as const;
const DEFENSIVE = ['stl', 'blk', 'tov'] as const;

function tally(counts: number[], value: number): void {
  for (let i = counts.length; i <= value; i += 1) counts[i] = 0;
  counts[value] += 1;
}

function offsetCounts(values: ArrayLike<number>): OffsetCounts {
  if (!values.length) return { from: 0, counts: [] };
  let low = Infinity;
  let high = -Infinity;
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] < low) low = values[i];
    if (values[i] > high) high = values[i];
  }
  const counts = new Array<number>(high - low + 1).fill(0);
  for (let i = 0; i < values.length; i += 1) counts[values[i] - low] += 1;
  return { from: low, counts };
}

export function summarizePlayer(series: PlayerSample): PublishedPlayer {
  const row: PublishedPlayer = { played: 0, min: [], pts: [], reb: [], ast: [], tpm: [], pra: [], pa: [], pr: [], ra: [] };
  for (const key of DEFENSIVE) if (series[key]) row[key] = [];
  const milestones = Boolean(series.stl && series.blk);
  if (milestones) {
    row.dd = 0;
    row.td = 0;
  }
  for (let index = 0; index < series.min.length; index += 1) {
    if (!(series.min[index] > 0)) continue;
    row.played += 1;
    tally(row.min, series.min[index]);
    tally(row.pts, series.pts[index]);
    tally(row.reb, series.reb[index]);
    tally(row.ast, series.ast[index]);
    tally(row.tpm, series.tpm[index]);
    for (const key of DEFENSIVE) if (row[key]) tally(row[key]!, series[key]![index]);
    for (const market of COMBINED) tally(row[market], valueAt(series, index, market));
    if (milestones) {
      row.dd! += valueAt(series, index, 'dd');
      row.td! += valueAt(series, index, 'td');
    }
  }
  return row;
}

export function summarizeSimulation(simulation: Simulation, meta: Omit<PublishedExpectation, 'iterations'>): PublishedSim {
  const { playerDraws, combinedTotals, awayTotals, homeTotals } = simulation;
  const summary: Partial<Simulation> = { ...simulation };
  for (const key of ['playerDraws', 'combinedTotals', 'awayTotals', 'homeTotals', 'upside', 'margins', 'published'] as const) delete summary[key];
  const players: Record<string, PublishedPlayer> = {};
  for (const [athleteId, series] of [...playerDraws].sort(([a], [b]) => a.localeCompare(b))) players[athleteId] = summarizePlayer(series);
  return {
    schema_version: PUBLISHED_SIM_SCHEMA,
    ...meta,
    iterations: combinedTotals.length,
    summary: summary as PublishedSummary,
    totals: offsetCounts(combinedTotals),
    margins: offsetCounts(homeTotals.map((home, index) => home - awayTotals[index])),
    players,
  };
}

function expandOffset(hist: OffsetCounts): number[] {
  const values: number[] = [];
  hist.counts.forEach((count, index) => {
    for (let k = 0; k < count; k += 1) values.push(hist.from + index);
  });
  return values;
}

/** Defines a property that computes itself once and is then an ordinary data property. */
function lazy(target: object, name: string, compute: () => unknown): void {
  Object.defineProperty(target, name, {
    enumerable: true,
    configurable: true,
    get() {
      const value = compute();
      Object.defineProperty(target, name, { value, enumerable: true, configurable: true, writable: true });
      return value;
    },
  });
}

/**
 * A player's draws rebuilt from counts. Every array lists the played draws first, so a draw is played at the same
 * indexes in each of them and the rest are zeros. Within a stat the values ascend. Two stats are not paired by draw, so
 * each combined stat and milestone is counted on its own and read through `markets`.
 */
export function createPublishedSample(row: PublishedPlayer, iterations: number): PlayerSample {
  const sample: Record<string, unknown> = {};
  const markets: Record<string, unknown> = {};
  const expand = (counts: readonly number[]): Uint16Array => {
    const values = new Uint16Array(iterations);
    let at = 0;
    counts.forEach((count, value) => {
      values.fill(value, at, at + count);
      at += count;
    });
    return values;
  };
  for (const key of ['min', 'pts', 'reb', 'ast', 'tpm'] as const) lazy(sample, key, () => expand(row[key]));
  for (const key of DEFENSIVE) lazy(sample, key, () => (row[key] ? expand(row[key]!) : undefined));
  for (const key of ['pts', 'reb', 'ast', 'tpm', ...DEFENSIVE] as const) lazy(markets, key, () => sample[key]);
  for (const key of COMBINED) lazy(markets, key, () => expand(row[key]));
  lazy(markets, 'dd', () => (row.dd === undefined ? undefined : expand([row.played - row.dd, row.dd])));
  lazy(markets, 'td', () => (row.td === undefined ? undefined : expand([row.played - row.td, row.td])));
  sample.markets = markets;
  return sample as unknown as PlayerSample;
}

/** The simulation the page works with, rebuilt from a published summary. It is marked so it is never stored again. */
export function hydrateSimulation(published: PublishedSim): Simulation {
  const playerDraws = new Map<string, ToneSeries>();
  for (const [athleteId, row] of Object.entries(published.players)) {
    playerDraws.set(athleteId, createPublishedSample(row, published.iterations) as unknown as ToneSeries);
  }
  const summary = published.summary;
  // The high-total draw is not shown anywhere, so the summary leaves it out and the shown draw stands in for it.
  const upside: ScenarioView = {
    overtime: summary.overtime,
    budget: summary.budget,
    overtimePeriods: summary.overtimePeriods,
    regulationAwayPts: summary.regulationAwayPts,
    regulationHomePts: summary.regulationHomePts,
    away: summary.away,
    home: summary.home,
  };
  return {
    ...summary,
    combinedTotals: expandOffset(published.totals),
    awayTotals: [],
    homeTotals: [],
    margins: expandOffset(published.margins),
    upside,
    playerDraws,
    published: true,
  };
}

const wholeCounts = (value: unknown): value is number[] => Array.isArray(value) && value.every((count) => Number.isInteger(count) && count >= 0);
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/**
 * A published file is used only when it is the same card, seed and draw count the page would simulate itself and its
 * counts add up. Anything else returns null and the page draws its own games.
 */
export function parsePublishedSim(text: string, expected: PublishedExpectation): PublishedSim | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const file = value as Partial<PublishedSim> | null;
  if (!file || file.schema_version !== PUBLISHED_SIM_SCHEMA || file.event_id !== expected.event_id) return null;
  if (file.generated_at !== expected.generated_at || (file.input_hash ?? null) !== expected.input_hash || (file.model_hash ?? null) !== expected.model_hash) return null;
  if (file.seed !== expected.seed || file.iterations !== expected.iterations) return null;
  const summary = file.summary as Partial<PublishedSummary> | undefined;
  if (!summary || !summary.away || !summary.home || !Array.isArray(summary.away.players) || !Array.isArray(summary.home.players) || !summary.wins) return null;
  for (const hist of [file.totals, file.margins]) {
    if (!hist || !Number.isInteger(hist.from) || !wholeCounts(hist.counts) || sum(hist.counts) !== expected.iterations) return null;
  }
  if (!file.players || typeof file.players !== 'object') return null;
  for (const row of Object.values(file.players)) {
    if (!row || !Number.isInteger(row.played) || row.played < 0 || row.played > expected.iterations) return null;
    for (const key of ['min', 'pts', 'reb', 'ast', 'tpm', 'pra', 'pa', 'pr', 'ra'] as const) {
      if (!wholeCounts(row[key]) || sum(row[key]) !== row.played) return null;
    }
    for (const key of DEFENSIVE) if (row[key] !== undefined && (!wholeCounts(row[key]) || sum(row[key]!) !== row.played)) return null;
    for (const key of ['dd', 'td'] as const) if (row[key] !== undefined && (!Number.isInteger(row[key]) || row[key]! < 0 || row[key]! > row.played)) return null;
    // A played draw has at least one minute, so nothing is counted at zero.
    if (row.min.length && row.min[0] !== 0) return null;
  }
  return file as PublishedSim;
}

export function parsePublishedIndex(text: string, expected: Omit<PublishedExpectation, 'event_id' | 'seed'>): Set<string> {
  try {
    const file = JSON.parse(text) as Partial<PublishedIndex> | null;
    if (!file || file.schema_version !== PUBLISHED_SIM_SCHEMA || !Array.isArray(file.events)) return new Set();
    if (file.generated_at !== expected.generated_at || (file.input_hash ?? null) !== expected.input_hash || (file.model_hash ?? null) !== expected.model_hash || file.iterations !== expected.iterations) return new Set();
    return new Set(file.events.filter((id): id is string => typeof id === 'string' && /^\d+$/.test(id)));
  } catch {
    return new Set();
  }
}

export type DataGetter = (name: string) => Promise<string | null>;

/** One game's published simulation, or null when it is missing, belongs to another card, or does not add up. */
export async function fetchPublishedSimulation(get: DataGetter, expected: PublishedExpectation): Promise<Simulation | null> {
  try {
    const text = await get(`sims/${expected.event_id}.json`);
    const file = text ? parsePublishedSim(text, expected) : null;
    return file ? hydrateSimulation(file) : null;
  } catch {
    return null;
  }
}

/** The games published for this card. Empty when there is no index or it belongs to another card. */
export async function fetchPublishedIndex(get: DataGetter, expected: Omit<PublishedExpectation, 'event_id' | 'seed'>): Promise<Set<string>> {
  try {
    const text = await get('sims/index.json');
    return text ? parsePublishedIndex(text, expected) : new Set();
  } catch {
    return new Set();
  }
}

export function publishedIndex(expected: Omit<PublishedExpectation, 'event_id' | 'seed'>, events: readonly string[]): PublishedIndex {
  return { schema_version: PUBLISHED_SIM_SCHEMA, ...expected, events: [...events].sort() };
}
