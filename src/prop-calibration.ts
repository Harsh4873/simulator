import { chicagoDate } from './date.ts';
import type { LedgerFile } from './picks.ts';
import { LOGISTIC_PENALTIES, applyIsotonic, fitLogistic, isotonicKnots } from './participation-model.ts';
import { americanBreakEven, noVigFromBreakEven, type PropMarket } from './props.ts';
import { mulberry32 } from './rng.ts';

export type PropCalibrationGroup = 'points' | 'rebAst' | 'tpm';
export type PropCalibrationMethod = 'beta' | 'platt' | 'temperature' | 'isotonic';

export interface PropCalibrationRow {
  date: string;
  /** event_id:athlete_id. Every market for one player-game shares it and stays on one side of a split. */
  key: string;
  group: PropCalibrationGroup;
  market: PropMarket;
  /** Raw model P(over) from the ledger snapshot (last ?? open). */
  p: number;
  y: 0 | 1;
  noVig: number;
  lineAgeMinutes: number;
  lineMoved: boolean;
}

export interface PropCalibrationParams {
  method: PropCalibrationMethod;
  beta?: { a: number; b: number; c: number };
  platt?: { a: number; b: number };
  temperature?: number;
  isotonic?: { x: number[]; y: number[] };
  /** Fitted raw-p range. Output is clamped to this interval as well as [0.01, 0.99]. */
  support?: { lo: number; hi: number };
}

export interface PropCalibrationMetrics {
  n: number;
  clusters: number;
  eceWidth10: number;
  eceFreq10: number;
  mce: number;
  brier: number;
  brierNovig: number;
  logLoss: number;
  logLossNovig: number;
  slope: number;
  intercept: number;
  slopeLo: number;
  slopeHi: number;
  interceptLo: number;
  interceptHi: number;
  reliability: number;
  resolution: number;
}

export interface PropCalibrationArtifact {
  schema_version: 1;
  group: PropCalibrationGroup;
  method: PropCalibrationMethod;
  model_version: string;
  input_hash: string;
  fitted_through: string;
  validated_through: string;
  rows_fit: number;
  rows_validated: number;
  clusters_fit: number;
  params: PropCalibrationParams;
  w: number;
  metrics_fit: PropCalibrationMetrics;
  metrics_validated: PropCalibrationMetrics;
  status: 'fitted' | 'rejected';
  reason: string | null;
}

/** The fields a lean or a quote needs in order to apply a map. An artifact satisfies this. */
export interface PropCalibrationCard {
  group: PropCalibrationGroup;
  method: PropCalibrationMethod;
  status: 'fitted' | 'rejected';
  model_version: string;
  fitted_through: string;
  params: PropCalibrationParams;
  w: number;
}

export interface PropCalibrationTable {
  get(group: PropCalibrationGroup): PropCalibrationCard | undefined;
}

export interface PropQuoteCalibration {
  apply: (probability: number) => number;
  w: number;
  noVig: number | null;
}

export interface PropPanelCalibration {
  table: PropCalibrationTable;
  modelVersion: string | null;
  tipDate: string;
  artifacts?: readonly PropCalibrationArtifact[];
  cutoff?: string;
}

/** The §0 release note this tree is compared with. A material gap refuses the fit. */
export const SPEC_SETTLED_ROWS = 1986;
export const SPEC_ECE_WIDTH10 = 0.0704;
export const SPEC_BRIER = 0.2574;
export const SPEC_LOG_LOSS = 0.7093;
export const CENSUS_METRIC_TOLERANCE = 0.005;
export const CENSUS_ROW_TOLERANCE = 10;

const OUTPUT_FLOOR = 0.01;
const OUTPUT_CAP = 0.99;
const LOGIT_EPS = 1e-6;
const LOG_LOSS_EPS = 1e-12;
const ECE_BINS = 10;
const BOOTSTRAP_REPLICATES = 1000;
const BOOTSTRAP_SEED = 731;
const BOOTSTRAP_LO = 24;
const BOOTSTRAP_HI = 974;
const COX_PENALTY = 0;
const PENALTY_TRAIN_FRACTION = 0.7;
const METHOD_TIE = 0.001;
const TEMPERATURE_LO = 0.5;
const TEMPERATURE_HI = 10;
const TEMPERATURE_STEPS = 80;
const TEMPERATURE_TOLERANCE = 1e-6;
const GOLDEN_RATIO = (1 + Math.sqrt(5)) / 2;
const PROP_ISOTONIC_BLOCK = 100;
const PROP_ISOTONIC_MIN_BLOCKS = 10;
const BLEND_STEP = 0.05;
const BLEND_FLAT_GAP = 0.002;
export const BLEND_PRIOR = 0.2;
const MIN_CALIBRATION_PLAY = 0.5;
const MIN_FIT_ROWS = 2;
const WILSON_Z = 1.96;
const BIAS_HOLDOUT_FRACTION = 0.3;
const METHOD_PRIORITY: readonly PropCalibrationMethod[] = ['temperature', 'platt', 'beta', 'isotonic'];

const sigmoid = (value: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));
const logit = (p: number) => {
  const q = Math.min(1 - LOGIT_EPS, Math.max(LOGIT_EPS, p));
  return Math.log(q / (1 - q));
};
const logLoss = (p: number, y: number) => {
  const q = Math.min(1 - LOG_LOSS_EPS, Math.max(LOG_LOSS_EPS, p));
  return -(y * Math.log(q) + (1 - y) * Math.log(1 - q));
};
const mean = (values: readonly number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.NaN);

export function groupOf(market: PropMarket): PropCalibrationGroup | null {
  switch (market) {
    case 'pts':
    case 'pra':
    case 'pa':
    case 'pr':
      return 'points';
    case 'reb':
    case 'ast':
    case 'ra':
      return 'rebAst';
    case 'tpm':
      return 'tpm';
    default:
      return null;
  }
}

function tipDate(iso: string, fallback: string): string {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? chicagoDate(new Date(parsed)) : fallback;
}

/**
 * One calibration row per settled live lean. The target is P(over | played, not pushed): a void has no stat,
 * and a push is neither side. Replay files are ignored. Line age is kept, including rows older than 30 minutes.
 */
export function rowsFromLedger(files: readonly LedgerFile[]): PropCalibrationRow[] {
  const rows: PropCalibrationRow[] = [];
  for (const file of files) {
    if (file.source !== 'live') continue;
    for (const row of file.rows) {
      if (!row.result || 'void' in row.result) continue;
      const snap = row.last ?? row.open;
      if (row.result.actual === snap.line || !(snap.play >= MIN_CALIBRATION_PLAY)) continue;
      const group = groupOf(row.m);
      if (!group) continue;
      const over = americanBreakEven(snap.over);
      const under = americanBreakEven(snap.under);
      if (over === null || under === null) continue;
      const noVig = noVigFromBreakEven(over, under);
      if (noVig === null || !(noVig > 0 && noVig < 1)) continue;
      const at = Date.parse(snap.at);
      const priced = Date.parse(snap.priced_at);
      rows.push({
        date: tipDate(row.tip, file.date),
        key: `${row.e}:${row.a}`,
        group,
        market: row.m,
        p: snap.p,
        y: row.result.actual > snap.line ? 1 : 0,
        noVig,
        lineAgeMinutes: Number.isFinite(at) && Number.isFinite(priced) ? (at - priced) / 60000 : Number.NaN,
        lineMoved: Boolean(row.close) && row.close!.line !== row.open.line,
      });
    }
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key) || a.market.localeCompare(b.market));
  return rows;
}

export function splitChronological(
  rows: readonly PropCalibrationRow[],
  fitThrough: string,
): { fit: PropCalibrationRow[]; validation: PropCalibrationRow[] } {
  const fit = rows.filter((row) => row.date <= fitThrough);
  const validation = rows.filter((row) => row.date > fitThrough);
  const fitKeys = new Set(fit.map((row) => row.key));
  for (const row of validation) {
    if (fitKeys.has(row.key)) throw new Error(`Cluster ${row.key} is on both sides of ${fitThrough}`);
  }
  return { fit, validation };
}

function ordered(rows: readonly PropCalibrationRow[]): PropCalibrationRow[] {
  return [...rows].sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key) || a.market.localeCompare(b.market));
}

function innerSlice(rows: readonly PropCalibrationRow[]): { train: PropCalibrationRow[]; select: PropCalibrationRow[] } {
  const sorted = ordered(rows);
  const dates = [...new Set(sorted.map((row) => row.date))];
  if (dates.length >= 2) {
    const cut = Math.min(Math.max(1, Math.floor(dates.length * PENALTY_TRAIN_FRACTION)), dates.length - 1);
    const trainDates = new Set(dates.slice(0, cut));
    return {
      train: sorted.filter((row) => trainDates.has(row.date)),
      select: sorted.filter((row) => !trainDates.has(row.date)),
    };
  }
  const cut = Math.min(Math.max(1, Math.floor(sorted.length * PENALTY_TRAIN_FRACTION)), Math.max(0, sorted.length - 1));
  return { train: sorted.slice(0, cut), select: sorted.slice(cut) };
}

function design(rows: readonly PropCalibrationRow[], features: (p: number) => number[]): { x: number[]; y: number }[] {
  return rows.map((row) => ({ x: features(row.p), y: row.y }));
}

const plattFeatures = (p: number) => [1, logit(p)];
const betaFeatures = (p: number) => [1, Math.log(Math.max(LOGIT_EPS, p)), -Math.log(Math.max(LOGIT_EPS, 1 - p))];

function choosePenalty(rows: readonly PropCalibrationRow[], features: (p: number) => number[]): number {
  const { train, select } = innerSlice(rows);
  if (!train.length || !select.length) return LOGISTIC_PENALTIES[0];
  let best = LOGISTIC_PENALTIES[0];
  let bestLoss = Number.POSITIVE_INFINITY;
  for (const penalty of LOGISTIC_PENALTIES) {
    const coefficients = fitLogistic(design(train, features), penalty);
    const loss = mean(select.map((row) => logLoss(sigmoid(coefficients.reduce((sum, value, index) => sum + value * features(row.p)[index], 0)), row.y)));
    if (loss < bestLoss || (loss === bestLoss && penalty < best)) {
      best = penalty;
      bestLoss = loss;
    }
  }
  return best;
}

function requireRows(rows: readonly PropCalibrationRow[], label: string): void {
  if (rows.length < MIN_FIT_ROWS) throw new Error(`${label} needs at least two rows`);
}

const interceptOnly = () => [1];
const lnP = (p: number) => Math.log(Math.max(LOGIT_EPS, p));
const negLn1m = (p: number) => -Math.log(Math.max(LOGIT_EPS, 1 - p));

function fitCoefficients(rows: readonly PropCalibrationRow[], features: (p: number) => number[], penalty: number): number[] {
  return fitLogistic(design(ordered(rows), features), penalty);
}

/** A negative slope would reverse the ranking. Clamp it at 0 and keep the intercept. */
function plattMember(rows: readonly PropCalibrationRow[]): { a: number; b: number; clamped: boolean } {
  requireRows(rows, 'Platt scaling');
  const penalty = choosePenalty(rows, plattFeatures);
  const [a, b] = fitCoefficients(rows, plattFeatures, penalty);
  if (b >= 0) return { a, b, clamped: false };
  const [intercept] = fitCoefficients(rows, interceptOnly, penalty);
  return { a: intercept, b: 0, clamped: true };
}

export function fitPlatt(rows: readonly PropCalibrationRow[]): { a: number; b: number } {
  const member = plattMember(rows);
  return { a: member.a, b: member.b };
}

/**
 * Beta is monotone only for a, b >= 0. A negative coefficient is clamped at 0 and the rest are refit.
 * The result is not a copy of a negative Platt slope.
 */
function betaMember(rows: readonly PropCalibrationRow[]): { a: number; b: number; c: number; clamped: boolean } {
  requireRows(rows, 'Beta calibration');
  const penalty = choosePenalty(rows, betaFeatures);
  const [c, a, b] = fitCoefficients(rows, betaFeatures, penalty);
  if (a >= 0 && b >= 0) return { a, b, c, clamped: false };
  if (a < 0 && b < 0) {
    const [intercept] = fitCoefficients(rows, interceptOnly, penalty);
    return { a: 0, b: 0, c: intercept, clamped: true };
  }
  if (a < 0) {
    const [nextC, nextB] = fitCoefficients(rows, (p) => [1, negLn1m(p)], penalty);
    if (nextB < 0) {
      const [intercept] = fitCoefficients(rows, interceptOnly, penalty);
      return { a: 0, b: 0, c: intercept, clamped: true };
    }
    return { a: 0, b: nextB, c: nextC, clamped: true };
  }
  const [nextC, nextA] = fitCoefficients(rows, (p) => [1, lnP(p)], penalty);
  if (nextA < 0) {
    const [intercept] = fitCoefficients(rows, interceptOnly, penalty);
    return { a: 0, b: 0, c: intercept, clamped: true };
  }
  return { a: nextA, b: 0, c: nextC, clamped: true };
}

export function fitBeta(rows: readonly PropCalibrationRow[]): { a: number; b: number; c: number } {
  const member = betaMember(rows);
  return { a: member.a, b: member.b, c: member.c };
}

export function fitTemperature(rows: readonly PropCalibrationRow[]): number {
  requireRows(rows, 'Temperature scaling');
  const loss = (temperature: number) => mean(rows.map((row) => logLoss(sigmoid(logit(row.p) / temperature), row.y)));
  let lo = TEMPERATURE_LO;
  let hi = TEMPERATURE_HI;
  for (let step = 0; step < TEMPERATURE_STEPS && hi - lo > TEMPERATURE_TOLERANCE; step += 1) {
    const left = hi - (hi - lo) / GOLDEN_RATIO;
    const right = lo + (hi - lo) / GOLDEN_RATIO;
    if (loss(left) < loss(right)) hi = right;
    else lo = left;
  }
  return Math.min(TEMPERATURE_HI, Math.max(TEMPERATURE_LO, (lo + hi) / 2));
}

export function fitIsotonic(rows: readonly PropCalibrationRow[]): { x: number[]; y: number[] } | null {
  const pairs = rows.filter((row) => Number.isFinite(row.p) && (row.y === 0 || row.y === 1)).map((row) => ({ p: row.p, y: row.y }));
  if (Math.floor(pairs.length / PROP_ISOTONIC_BLOCK) < PROP_ISOTONIC_MIN_BLOCKS) return null;
  return isotonicKnots(pairs, PROP_ISOTONIC_BLOCK);
}

function supportOf(rows: readonly PropCalibrationRow[]): { lo: number; hi: number } {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    if (row.p < lo) lo = row.p;
    if (row.p > hi) hi = row.p;
  }
  return lo < hi ? { lo, hi } : { lo: OUTPUT_FLOOR, hi: OUTPUT_CAP };
}

function clampOutput(value: number, support?: { lo: number; hi: number }): number {
  let lo = OUTPUT_FLOOR;
  let hi = OUTPUT_CAP;
  if (support && Number.isFinite(support.lo) && Number.isFinite(support.hi) && support.lo < support.hi) {
    lo = Math.max(lo, support.lo);
    hi = Math.min(hi, support.hi);
  }
  if (!(lo < hi)) return Math.min(OUTPUT_CAP, Math.max(OUTPUT_FLOOR, value));
  return Math.min(hi, Math.max(lo, value));
}

export function applyCalibration(params: PropCalibrationParams, p: number): number {
  let mapped = p;
  if (params.method === 'temperature') {
    if (params.temperature && params.temperature > 0) mapped = sigmoid(logit(p) / params.temperature);
  } else if (params.method === 'platt') {
    const a = params.platt?.a ?? 0;
    const b = params.platt?.b ?? 1;
    mapped = sigmoid(a + b * logit(p));
  } else if (params.method === 'beta') {
    const a = params.beta?.a ?? 1;
    const b = params.beta?.b ?? 1;
    const c = params.beta?.c ?? 0;
    const q = Math.min(1 - LOGIT_EPS, Math.max(LOGIT_EPS, p));
    mapped = sigmoid(c + a * Math.log(q) - b * Math.log(1 - q));
  } else {
    mapped = applyIsotonic(params.isotonic, p);
  }
  return clampOutput(mapped, params.support);
}

export function blendWithMarket(pCal: number, noVig: number, w: number): number {
  if (!Number.isFinite(w) || w < 0 || w > 1) throw new Error('Blend weight must be between 0 and 1');
  if (!Number.isFinite(pCal) || !Number.isFinite(noVig) || !(pCal > 0 && pCal < 1) || !(noVig > 0 && noVig < 1)) {
    throw new Error('Blend inputs must be probabilities between 0 and 1');
  }
  return w * pCal + (1 - w) * noVig;
}

export function blendWeightCurve(
  rows: readonly PropCalibrationRow[],
  pCal: (row: PropCalibrationRow) => number,
): { w: number; loss: number }[] {
  const curve: { w: number; loss: number }[] = [];
  for (let step = 0; step <= Math.round(1 / BLEND_STEP); step += 1) {
    const w = Number((step * BLEND_STEP).toFixed(2));
    const loss = mean(rows.map((row) => logLoss(blendWithMarket(pCal(row), row.noVig, w), row.y)));
    curve.push({ w, loss });
  }
  return curve;
}

export function fitBlendWeight(rows: readonly PropCalibrationRow[], pCal: (row: PropCalibrationRow) => number): number {
  if (!rows.length) return BLEND_PRIOR;
  const curve = blendWeightCurve(rows, pCal);
  console.log(`prop blend weight ${JSON.stringify(curve.map((point) => ({ w: point.w, logLoss: Number(point.loss.toFixed(6)) })))}`);
  const losses = curve.map((point) => point.loss);
  if (!losses.every((loss) => Number.isFinite(loss))) return BLEND_PRIOR;
  const span = Math.max(...losses) - Math.min(...losses);
  if (span < BLEND_FLAT_GAP) return BLEND_PRIOR;
  return curve.reduce((best, point) => (point.loss < best.loss ? point : best)).w;
}

interface CountBin {
  n: number;
  sumP: number;
  sumY: number;
}

function emptyBins(bins: number): CountBin[] {
  return Array.from({ length: bins }, () => ({ n: 0, sumP: 0, sumY: 0 }));
}

function scored(rows: readonly PropCalibrationRow[], pOf: (row: PropCalibrationRow) => number): { p: number; y: number }[] {
  return rows.map((row) => ({ p: pOf(row), y: row.y }));
}

function widthBins(values: readonly { p: number; y: number }[], bins: number): CountBin[] {
  const out = emptyBins(bins);
  for (const row of values) {
    const index = Math.min(bins - 1, Math.max(0, Math.floor(row.p * bins)));
    const bin = out[index];
    bin.n += 1;
    bin.sumP += row.p;
    bin.sumY += row.y;
  }
  return out;
}

function frequencyBins(values: readonly { p: number; y: number }[], bins: number): CountBin[] {
  const sorted = [...values].sort((a, b) => a.p - b.p);
  const out = emptyBins(bins);
  const n = sorted.length;
  for (let index = 0; index < bins; index += 1) {
    const start = Math.floor((index * n) / bins);
    const end = Math.floor(((index + 1) * n) / bins);
    const bin = out[index];
    for (let cursor = start; cursor < end; cursor += 1) {
      bin.n += 1;
      bin.sumP += sorted[cursor].p;
      bin.sumY += sorted[cursor].y;
    }
  }
  return out;
}

function eceOf(bins: readonly CountBin[], n: number): number {
  if (!n) return 0;
  let total = 0;
  for (const bin of bins) {
    if (!bin.n) continue;
    total += (bin.n / n) * Math.abs(bin.sumY / bin.n - bin.sumP / bin.n);
  }
  return total;
}

function mceOf(bins: readonly CountBin[]): number {
  let worst = 0;
  for (const bin of bins) {
    if (!bin.n) continue;
    worst = Math.max(worst, Math.abs(bin.sumY / bin.n - bin.sumP / bin.n));
  }
  return worst;
}

export function expectedCalibrationError(
  rows: readonly PropCalibrationRow[],
  pOf: (row: PropCalibrationRow) => number,
  bins: number,
  kind: 'width' | 'frequency',
): number {
  const values = scored(rows, pOf);
  const counts = kind === 'width' ? widthBins(values, bins) : frequencyBins(values, bins);
  return eceOf(counts, values.length);
}

function wilson(successes: number, n: number): { lo: number; hi: number } {
  if (!n) return { lo: 0, hi: 1 };
  const z2 = WILSON_Z * WILSON_Z;
  const p = successes / n;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (WILSON_Z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return { lo: Math.max(0, center - margin), hi: Math.min(1, center + margin) };
}

export interface ReliabilityBin {
  lo: number;
  hi: number;
  n: number;
  meanP: number;
  rate: number;
  wilsonLo: number;
  wilsonHi: number;
}

export function reliabilityBins(
  rows: readonly PropCalibrationRow[],
  pOf: (row: PropCalibrationRow) => number,
  bins = ECE_BINS,
): ReliabilityBin[] {
  const counts = widthBins(scored(rows, pOf), bins);
  return counts.map((bin, index) => {
    const interval = wilson(bin.sumY, bin.n);
    return {
      lo: index / bins,
      hi: (index + 1) / bins,
      n: bin.n,
      meanP: bin.n ? bin.sumP / bin.n : 0,
      rate: bin.n ? bin.sumY / bin.n : 0,
      wilsonLo: interval.lo,
      wilsonHi: interval.hi,
    };
  });
}

function coxFit(rows: readonly { p: number; y: number }[]): { intercept: number; slope: number } | null {
  if (rows.length < MIN_FIT_ROWS) return null;
  try {
    const [intercept, slope] = fitLogistic(
      rows.map((row) => ({ x: [1, logit(row.p)], y: row.y })),
      COX_PENALTY,
    );
    if (!Number.isFinite(intercept) || !Number.isFinite(slope)) return null;
    return { intercept, slope };
  } catch {
    return null;
  }
}

function emptyMetrics(): PropCalibrationMetrics {
  return {
    n: 0,
    clusters: 0,
    eceWidth10: Number.NaN,
    eceFreq10: Number.NaN,
    mce: Number.NaN,
    brier: Number.NaN,
    brierNovig: Number.NaN,
    logLoss: Number.NaN,
    logLossNovig: Number.NaN,
    slope: Number.NaN,
    intercept: Number.NaN,
    slopeLo: Number.NaN,
    slopeHi: Number.NaN,
    interceptLo: Number.NaN,
    interceptHi: Number.NaN,
    reliability: Number.NaN,
    resolution: Number.NaN,
  };
}

export function calibrationMetrics(rows: readonly PropCalibrationRow[], pOf: (row: PropCalibrationRow) => number): PropCalibrationMetrics {
  if (!rows.length) return emptyMetrics();
  const values = scored(rows, pOf);
  const width = widthBins(values, ECE_BINS);
  const frequency = frequencyBins(values, ECE_BINS);
  const base = mean(values.map((row) => row.y));
  let reliability = 0;
  let resolution = 0;
  for (const bin of width) {
    if (!bin.n) continue;
    const forecast = bin.sumP / bin.n;
    const rate = bin.sumY / bin.n;
    reliability += bin.n * (forecast - rate) ** 2;
    resolution += bin.n * (rate - base) ** 2;
  }
  const point = coxFit(values);
  const byKey = new Map<string, PropCalibrationRow[]>();
  for (const row of rows) {
    const list = byKey.get(row.key);
    if (list) list.push(row);
    else byKey.set(row.key, [row]);
  }
  const keys = [...byKey.keys()];
  const slopes: number[] = [];
  const intercepts: number[] = [];
  const rng = mulberry32(BOOTSTRAP_SEED);
  const fallbackSlope = point?.slope ?? Number.NaN;
  const fallbackIntercept = point?.intercept ?? Number.NaN;
  for (let replicate = 0; replicate < BOOTSTRAP_REPLICATES; replicate += 1) {
    const sample: { p: number; y: number }[] = [];
    for (let draw = 0; draw < keys.length; draw += 1) {
      const key = keys[Math.floor(rng() * keys.length)];
      const cluster = byKey.get(key);
      if (!cluster) continue;
      for (const row of cluster) sample.push({ p: pOf(row), y: row.y });
    }
    const fitted = coxFit(sample);
    slopes.push(fitted?.slope ?? fallbackSlope);
    intercepts.push(fitted?.intercept ?? fallbackIntercept);
  }
  slopes.sort((a, b) => a - b);
  intercepts.sort((a, b) => a - b);
  return {
    n: rows.length,
    clusters: keys.length,
    eceWidth10: eceOf(width, values.length),
    eceFreq10: eceOf(frequency, values.length),
    mce: mceOf(width),
    brier: mean(values.map((row) => (row.p - row.y) ** 2)),
    brierNovig: mean(rows.map((row) => (row.noVig - row.y) ** 2)),
    logLoss: mean(values.map((row) => logLoss(row.p, row.y))),
    logLossNovig: mean(rows.map((row) => logLoss(row.noVig, row.y))),
    slope: point?.slope ?? Number.NaN,
    intercept: point?.intercept ?? Number.NaN,
    slopeLo: slopes[BOOTSTRAP_LO],
    slopeHi: slopes[BOOTSTRAP_HI],
    interceptLo: intercepts[BOOTSTRAP_LO],
    interceptHi: intercepts[BOOTSTRAP_HI],
    reliability: reliability / values.length,
    resolution: resolution / values.length,
  };
}

interface ScoredMethod {
  method: PropCalibrationMethod;
  params: PropCalibrationParams;
  loss: number;
}

function probabilityGrid(): number[] {
  const values: number[] = [];
  for (let p = 0.01; p <= 0.991; p += 0.04) values.push(Number(p.toFixed(2)));
  return values;
}

/** True when the shipped map falls as p rises. A flat map is allowed. */
function mapDecreases(params: PropCalibrationParams): boolean {
  let previous = -1;
  for (const p of probabilityGrid()) {
    const value = applyCalibration(params, p);
    if (value + 1e-9 < previous) return true;
    previous = value;
  }
  return false;
}

export function selectMethod(
  fit: readonly PropCalibrationRow[],
  validation: readonly PropCalibrationRow[],
  previousMethod?: PropCalibrationMethod | null,
): { method: PropCalibrationMethod; params: PropCalibrationParams; metrics: PropCalibrationMetrics; reason: string | null } {
  if (!fit.length || !validation.length) throw new Error('Method selection needs a fit block and a later validation block');
  const support = supportOf(fit);
  const beta = betaMember(fit);
  const platt = plattMember(fit);
  const temperature = fitTemperature(fit);
  const notes: string[] = [];
  if (beta.clamped) notes.push('Unconstrained beta had a negative coefficient and was clamped at 0 before the remaining parameters were refit.');
  if (platt.clamped) notes.push('Platt slope was negative and was clamped at 0.');
  const scored: ScoredMethod[] = [];
  if (temperature > 0) scored.push({ method: 'temperature', params: { method: 'temperature', temperature, support }, loss: 0 });
  scored.push({ method: 'platt', params: { method: 'platt', platt: { a: platt.a, b: platt.b }, support }, loss: 0 });
  scored.push({ method: 'beta', params: { method: 'beta', beta: { a: beta.a, b: beta.b, c: beta.c }, support }, loss: 0 });
  const knots = fit.length >= PROP_ISOTONIC_BLOCK * PROP_ISOTONIC_MIN_BLOCKS ? fitIsotonic(fit) : null;
  if (knots) scored.push({ method: 'isotonic', params: { method: 'isotonic', isotonic: knots, support }, loss: 0 });
  for (const candidate of scored) {
    candidate.loss = mean(validation.map((row) => logLoss(applyCalibration(candidate.params, row.p), row.y)));
  }
  const monotone = scored.filter((candidate) => !mapDecreases(candidate.params));
  const isotonic = monotone.find((candidate) => candidate.method === 'isotonic');
  const rest = monotone.filter((candidate) => candidate.method !== 'isotonic');
  if (!rest.length) {
    const [intercept] = fitCoefficients(fit, interceptOnly, LOGISTIC_PENALTIES[0]);
    const params: PropCalibrationParams = { method: 'platt', platt: { a: intercept, b: 0 }, support };
    return {
      method: 'platt',
      params,
      metrics: calibrationMetrics(validation, (row) => applyCalibration(params, row.p)),
      reason: 'Slopes were clamped at 0.',
    };
  }
  const best = Math.min(...rest.map((candidate) => candidate.loss));
  const tied = rest.filter((candidate) => candidate.loss <= best + METHOD_TIE);
  tied.sort((a, b) => METHOD_PRIORITY.indexOf(a.method) - METHOD_PRIORITY.indexOf(b.method));
  let chosen = tied[0];
  if (isotonic && previousMethod === 'isotonic' && isotonic.loss < best - METHOD_TIE) chosen = isotonic;
  const metrics = calibrationMetrics(validation, (row) => applyCalibration(chosen.params, row.p));
  return { method: chosen.method, params: chosen.params, metrics, reason: notes.length ? notes.join(' ') : null };
}

export function meanBiasCorrection(
  rows: readonly { projection: number; actual: number; tier: string; date: string }[],
): Map<string, { alpha: number; beta: number }> {
  const byTier = new Map<string, { projection: number; actual: number; date: string }[]>();
  for (const row of rows) {
    const list = byTier.get(row.tier);
    if (list) list.push(row);
    else byTier.set(row.tier, [row]);
  }
  const out = new Map<string, { alpha: number; beta: number }>();
  for (const [tier, tierRows] of byTier) {
    const dates = [...new Set(tierRows.map((row) => row.date))].sort();
    let fit = tierRows;
    let hold = tierRows;
    if (dates.length >= 2) {
      const holdCount = Math.min(dates.length - 1, Math.max(1, Math.ceil(dates.length * BIAS_HOLDOUT_FRACTION)));
      const held = new Set(dates.slice(dates.length - holdCount));
      fit = tierRows.filter((row) => !held.has(row.date));
      hold = tierRows.filter((row) => held.has(row.date));
    } else if (tierRows.length >= 4) {
      const cut = Math.max(1, Math.floor(tierRows.length * (1 - BIAS_HOLDOUT_FRACTION)));
      fit = tierRows.slice(0, Math.min(cut, tierRows.length - 1));
      hold = tierRows.slice(fit.length);
    }
    const additive = ordinaryLeastSquares(fit);
    const ratios = fit.filter((row) => row.projection > 0).map((row) => row.actual / row.projection);
    const ratio = ratios.length ? mean(ratios) : additive.beta;
    const additiveError = meanAbsoluteError(hold, additive.alpha, additive.beta);
    const ratioError = meanAbsoluteError(hold, 0, ratio);
    out.set(tier, ratioError < additiveError ? { alpha: 0, beta: ratio } : additive);
  }
  return out;
}

function ordinaryLeastSquares(rows: readonly { projection: number; actual: number }[]): { alpha: number; beta: number } {
  const n = rows.length;
  if (!n) return { alpha: 0, beta: 1 };
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  for (const row of rows) {
    sumX += row.projection;
    sumY += row.actual;
    sumXX += row.projection * row.projection;
    sumXY += row.projection * row.actual;
  }
  const denom = n * sumXX - sumX * sumX;
  if (!(Math.abs(denom) > 1e-12)) return { alpha: 0, beta: sumX !== 0 ? sumY / sumX : 1 };
  const beta = (n * sumXY - sumX * sumY) / denom;
  return { alpha: (sumY - beta * sumX) / n, beta };
}

function meanAbsoluteError(rows: readonly { projection: number; actual: number }[], alpha: number, beta: number): number {
  if (!rows.length) return Number.POSITIVE_INFINITY;
  return mean(rows.map((row) => Math.abs(row.actual - (alpha + beta * row.projection))));
}

export function driftAction(signal: {
  eceWidth10: number;
  eceFreq10: number;
  slopeLo: number;
  slopeHi: number;
  interceptLo: number;
  interceptHi: number;
  tierEdge: number;
}): 'green' | 'amber' | 'red' {
  if (signal.eceWidth10 > 0.05 || signal.eceFreq10 > 0.05 || signal.tierEdge < -0.01) return 'red';
  const slopeExcludesOne = signal.slopeLo > 1 || signal.slopeHi < 1;
  const interceptExcludesZero = signal.interceptLo > 0 || signal.interceptHi < 0;
  if (signal.eceWidth10 > 0.03 || signal.eceFreq10 > 0.03 || slopeExcludesOne || interceptExcludesZero || signal.tierEdge < 0) return 'amber';
  return 'green';
}

export function censusIsMaterial(settledNonPush: number, metrics: PropCalibrationMetrics | null): boolean {
  if (Math.abs(settledNonPush - SPEC_SETTLED_ROWS) > CENSUS_ROW_TOLERANCE) return true;
  if (!metrics || !Number.isFinite(metrics.eceWidth10)) return true;
  return (
    Math.abs(metrics.eceWidth10 - SPEC_ECE_WIDTH10) > CENSUS_METRIC_TOLERANCE ||
    Math.abs(metrics.brier - SPEC_BRIER) > CENSUS_METRIC_TOLERANCE ||
    Math.abs(metrics.logLoss - SPEC_LOG_LOSS) > CENSUS_METRIC_TOLERANCE
  );
}

export const VALIDATION_DAY_FRACTION = 0.3;

/** Last 30% of tip dates, rounded up, and at least one day. One date cannot be both sides. */
export function splitTipDates(dates: readonly string[]): { fit: string[]; validation: string[] } | null {
  const unique = [...new Set(dates)].sort();
  if (unique.length < 2) return null;
  const hold = Math.max(1, Math.ceil(unique.length * VALIDATION_DAY_FRACTION));
  if (hold >= unique.length) return null;
  return { fit: unique.slice(0, unique.length - hold), validation: unique.slice(unique.length - hold) };
}

const PUBLISHED_GROUPS: readonly PropCalibrationGroup[] = ['points', 'rebAst', 'tpm'];

function isGroup(value: string): value is PropCalibrationGroup {
  return (PUBLISHED_GROUPS as readonly string[]).includes(value);
}

function isCard(value: unknown): value is PropCalibrationCard {
  if (!value || typeof value !== 'object') return false;
  const card = value as PropCalibrationCard;
  return (
    isGroup(String(card.group)) &&
    (card.status === 'fitted' || card.status === 'rejected') &&
    typeof card.model_version === 'string' &&
    typeof card.fitted_through === 'string' &&
    typeof card.method === 'string' &&
    typeof card.w === 'number' &&
    Boolean(card.params) &&
    card.params.method === card.method
  );
}

export function parsePublishedPropCalibration(text: string): { table: Map<PropCalibrationGroup, PropCalibrationCard>; artifacts: PropCalibrationArtifact[] } | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const body = value as { schema_version?: number; groups?: Record<string, unknown> } | null;
  if (!body || body.schema_version !== 1 || !body.groups || typeof body.groups !== 'object') return null;
  const table = new Map<PropCalibrationGroup, PropCalibrationCard>();
  const artifacts: PropCalibrationArtifact[] = [];
  for (const [name, raw] of Object.entries(body.groups)) {
    if (!isGroup(name) || !isCard(raw) || raw.group !== name) continue;
    table.set(name, raw);
    const full = raw as Partial<PropCalibrationArtifact>;
    if (full.schema_version === 1 && full.metrics_validated && typeof full.input_hash === 'string' && typeof full.rows_fit === 'number') {
      artifacts.push(full as PropCalibrationArtifact);
    }
  }
  return { table, artifacts };
}

/** Side-aware wrapper: the stored map is on P(over). The quote applies it to the side being priced. */
export function quoteCalibrationFor(
  panel: PropPanelCalibration | null | undefined,
  market: PropMarket,
  side: 'over' | 'under',
): PropQuoteCalibration | undefined {
  if (!panel?.modelVersion) return undefined;
  const group = groupOf(market);
  if (!group) return undefined;
  const card = panel.table.get(group);
  if (!card || card.status !== 'fitted' || card.model_version !== panel.modelVersion || !(card.fitted_through < panel.tipDate)) return undefined;
  return {
    apply: (probability: number) => {
      const over = side === 'over' ? probability : 1 - probability;
      const calibrated = applyCalibration(card.params, over);
      return side === 'over' ? calibrated : 1 - calibrated;
    },
    w: card.w,
    noVig: null,
  };
}
