import { chicagoDate } from './date.ts';
import type { LedgerFile } from './picks.ts';
import { LOGISTIC_PENALTIES, applyIsotonic, fitLogistic, isotonicKnots } from './participation-model.ts';
import { americanBreakEven, noVigFromBreakEven, type PropMarket } from './props.ts';
import { mulberry32 } from './rng.ts';

export type PropCalibrationGroup = 'points' | 'rebAst' | 'tpm';
export type PropCalibrationMethod = 'beta' | 'platt' | 'temperature' | 'isotonic';
export type DriftLevel = 'green' | 'amber' | 'red';

/**
 * A prop map is keyed to the simulation family (`RateCard.model_version`), not to the hash of every source file. A page,
 * feed, or fitter change does not move the simulated probabilities, and bumping the family retires every map.
 * Snapshots logged before the family was stamped on them were all made by possessions-v9: it went live on Nov 14, 2026,
 * and live logging began on Nov 15.
 */
export const LEGACY_LEDGER_FAMILY = 'possessions-v9';

export function snapshotFamily(snap: { v?: string }): string {
  return typeof snap.v === 'string' && snap.v ? snap.v : LEGACY_LEDGER_FAMILY;
}

/** A map whose held-out block ended this many days before today is not applied. A healthy refresh refits every run. */
export const MAP_MAX_AGE_DAYS = 7;

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
  /** First scored day of the walk-forward check. `validated_through` is the last. */
  validated_from?: string;
  params: PropCalibrationParams;
  w: number;
  metrics_fit: PropCalibrationMetrics;
  metrics_validated: PropCalibrationMetrics;
  status: 'fitted' | 'rejected';
  reason: string | null;
  /** Raw-model scores on the same held-out rows, so the gain can be read off the artifact. */
  metrics_raw?: PropCalibrationMetrics;
  /** Release checks this map does not meet yet. They gate a BET verdict, not the map. */
  notes?: string[];
  /** Noise-aware drift on the held-out block. Red suspends listing for the group. */
  drift?: DriftLevel;
  /** Best weight over [0, 1] before the cap. A weight above the cap needs two different held-out blocks to agree on it. */
  w_open?: number;
  /** Winner of each held-out block, oldest first. Isotonic ships only after it wins two different blocks in a row. */
  held_out_best?: { validated_through: string; method: PropCalibrationMethod }[];
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
  /** Red suspends listing for the group. The map still applies. */
  drift?: DriftLevel;
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

/**
 * The §0 release note: the live ledger through Nov 17, 2026. The fit report checks that this tree still reproduces it
 * on those days. Later days only add rows, so the check never blocks a fit.
 */
export const SPEC_THROUGH = '2026-11-17';
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
 * With a family, only snapshots that family made are kept: a map is never fitted on another model's probabilities.
 */
export function rowsFromLedger(files: readonly LedgerFile[], family?: string | null): PropCalibrationRow[] {
  const rows: PropCalibrationRow[] = [];
  for (const file of files) {
    if (file.source !== 'live') continue;
    for (const row of file.rows) {
      if (!row.result || 'void' in row.result) continue;
      const snap = row.last ?? row.open;
      if (family && snapshotFamily(snap) !== family) continue;
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
  cap = 1,
): { w: number; loss: number }[] {
  const curve: { w: number; loss: number }[] = [];
  for (let step = 0; step <= Math.round(cap / BLEND_STEP); step += 1) {
    const w = Number((step * BLEND_STEP).toFixed(2));
    const loss = mean(rows.map((row) => logLoss(blendWithMarket(pCal(row), row.noVig, w), row.y)));
    curve.push({ w, loss });
  }
  return curve;
}

/**
 * The weight in [0, cap] with the lowest log loss. When the curve over those weights varies by less than 0.002, the
 * data cannot tell them apart and the prior is kept: a curve that only climbs past the cap says nothing about the
 * weights the page can use.
 */
export function fitBlendWeight(rows: readonly PropCalibrationRow[], pCal: (row: PropCalibrationRow) => number, cap = 1): number {
  const prior = Math.min(BLEND_PRIOR, cap);
  if (!rows.length) return prior;
  const curve = blendWeightCurve(rows, pCal, cap);
  console.log(`prop blend weight ${JSON.stringify(curve.map((point) => ({ w: point.w, logLoss: Number(point.loss.toFixed(6)) })))}`);
  const losses = curve.map((point) => point.loss);
  if (!losses.every((loss) => Number.isFinite(loss))) return prior;
  const span = Math.max(...losses) - Math.min(...losses);
  if (span < BLEND_FLAT_GAP) return prior;
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

interface Candidate {
  method: PropCalibrationMethod;
  params: PropCalibrationParams;
}

/** Every method fitted on one block, with its clamping notes. A map that falls as the raw chance rises is dropped. */
function fitCandidates(fit: readonly PropCalibrationRow[]): { candidates: Candidate[]; notes: string[]; support: { lo: number; hi: number } } {
  const support = supportOf(fit);
  const beta = betaMember(fit);
  const platt = plattMember(fit);
  const temperature = fitTemperature(fit);
  const notes: string[] = [];
  if (beta.clamped) notes.push('Unconstrained beta had a negative coefficient and was clamped at 0 before the remaining parameters were refit.');
  if (platt.clamped) notes.push('Platt slope was negative and was clamped at 0.');
  const candidates: Candidate[] = [];
  if (temperature > 0) candidates.push({ method: 'temperature', params: { method: 'temperature', temperature, support } });
  candidates.push({ method: 'platt', params: { method: 'platt', platt: { a: platt.a, b: platt.b }, support } });
  candidates.push({ method: 'beta', params: { method: 'beta', beta: { a: beta.a, b: beta.b, c: beta.c }, support } });
  const knots = fit.length >= PROP_ISOTONIC_BLOCK * PROP_ISOTONIC_MIN_BLOCKS ? fitIsotonic(fit) : null;
  if (knots) candidates.push({ method: 'isotonic', params: { method: 'isotonic', isotonic: knots, support } });
  return { candidates: candidates.filter((candidate) => !mapDecreases(candidate.params)), notes, support };
}

/**
 * Fits every method on the fit block and scores it on the later validation block. A parametric map wins ties.
 * Isotonic replaces it only when it beats the best parametric map by more than the tie margin here and it also won
 * the previous, earlier held-out block (`previousBest`). `heldOutBest` is this block's winner, for the next fit.
 */
export function selectMethod(
  fit: readonly PropCalibrationRow[],
  validation: readonly PropCalibrationRow[],
  previousBest?: PropCalibrationMethod | null,
): {
  method: PropCalibrationMethod;
  params: PropCalibrationParams;
  metrics: PropCalibrationMetrics;
  reason: string | null;
  heldOutBest: PropCalibrationMethod;
} {
  if (!fit.length || !validation.length) throw new Error('Method selection needs a fit block and a later validation block');
  const { candidates, notes, support } = fitCandidates(fit);
  const monotone: ScoredMethod[] = candidates.map((candidate) => ({
    ...candidate,
    loss: mean(validation.map((row) => logLoss(applyCalibration(candidate.params, row.p), row.y))),
  }));
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
      heldOutBest: isotonic ? 'isotonic' : 'platt',
    };
  }
  const best = Math.min(...rest.map((candidate) => candidate.loss));
  const tied = rest.filter((candidate) => candidate.loss <= best + METHOD_TIE);
  tied.sort((a, b) => METHOD_PRIORITY.indexOf(a.method) - METHOD_PRIORITY.indexOf(b.method));
  let chosen = tied[0];
  const isotonicWins = Boolean(isotonic && isotonic.loss < best - METHOD_TIE);
  if (isotonic && isotonicWins && previousBest === 'isotonic') chosen = isotonic;
  const metrics = calibrationMetrics(validation, (row) => applyCalibration(chosen.params, row.p));
  return {
    method: chosen.method,
    params: chosen.params,
    metrics,
    reason: notes.length ? notes.join(' ') : null,
    heldOutBest: isotonicWins ? 'isotonic' : tied[0].method,
  };
}

/** The winner of the latest held-out block that ended before `validatedThrough`. A refit on the same block is not a second win. */
export function previousHeldOutBest(
  history: PropCalibrationArtifact['held_out_best'],
  validatedThrough: string,
): PropCalibrationMethod | null {
  if (!Array.isArray(history)) return null;
  let found: { validated_through: string; method: PropCalibrationMethod } | null = null;
  for (const entry of history) {
    if (!entry || typeof entry.validated_through !== 'string' || !(entry.validated_through < validatedThrough)) continue;
    if (!found || entry.validated_through > found.validated_through) found = entry;
  }
  return found?.method ?? null;
}

export interface WalkForwardFold {
  /** The settled tip date this fold scores. */
  day: string;
  /** Every qualifying row that tipped before `day`. */
  fit: PropCalibrationRow[];
  validation: PropCalibrationRow[];
}

/** Scored days kept: the most recent settled days decide, and an old slate stops counting after ten more. */
export const MAX_WALK_FORWARD_FOLDS = 10;

/**
 * Each settled day is scored by maps fitted on every earlier day, once those earlier days hold `minFitRows` rows.
 * No row is scored by a map that saw it, and a player-game never sits on both sides. Only the last
 * `MAX_WALK_FORWARD_FOLDS` days are kept.
 */
export function walkForwardFolds(rows: readonly PropCalibrationRow[], minFitRows: number): WalkForwardFold[] {
  const sorted = ordered(rows);
  const dates = [...new Set(sorted.map((row) => row.date))];
  const folds: WalkForwardFold[] = [];
  for (let index = 1; index < dates.length; index += 1) {
    const { fit, validation } = splitChronological(sorted.filter((row) => row.date <= dates[index]), dates[index - 1]);
    if (fit.length < minFitRows) continue;
    folds.push({ day: dates[index], fit, validation });
  }
  return folds.slice(-MAX_WALK_FORWARD_FOLDS);
}

export interface WalkForwardSelection {
  method: PropCalibrationMethod;
  /** The chosen method fitted on the last fold's fit block: every settled day before the last one. */
  params: PropCalibrationParams;
  fit: PropCalibrationRow[];
  /** Every fold's scored rows. */
  heldOut: PropCalibrationRow[];
  /** The chosen method's chance for each scored row, from the map fitted before that row's day. */
  predicted: Map<PropCalibrationRow, number>;
  metrics: PropCalibrationMetrics;
  /** Clamping notes for the shipped map. */
  reason: string | null;
  heldOutBest: PropCalibrationMethod;
  days: string[];
}

/**
 * Walk-forward method choice. Every method is refit at each fold and scored on that fold's day; the scores are pooled
 * over all folds, so the choice rests on every scored day rather than one block. A parametric map wins ties.
 * Isotonic is eligible only when it fitted in every fold, and replaces the parametric choice only when it wins here and
 * also won the previous, earlier evaluation (`previousBest`).
 */
export function selectWalkForward(folds: readonly WalkForwardFold[], previousBest?: PropCalibrationMethod | null): WalkForwardSelection {
  if (!folds.length) throw new Error('Walk-forward selection needs at least one fold');
  const predictions = new Map<PropCalibrationMethod, Map<PropCalibrationRow, number>>();
  const heldOut: PropCalibrationRow[] = [];
  let last: ReturnType<typeof fitCandidates> | null = null;
  for (const fold of folds) {
    last = fitCandidates(fold.fit);
    for (const candidate of last.candidates) {
      const map = predictions.get(candidate.method) ?? new Map<PropCalibrationRow, number>();
      for (const row of fold.validation) map.set(row, applyCalibration(candidate.params, row.p));
      predictions.set(candidate.method, map);
    }
    heldOut.push(...fold.validation);
  }
  const final = last!;
  const complete = (method: PropCalibrationMethod) =>
    predictions.get(method)?.size === heldOut.length && final.candidates.some((candidate) => candidate.method === method);
  const loss = (method: PropCalibrationMethod) => mean(heldOut.map((row) => logLoss(predictions.get(method)!.get(row)!, row.y)));
  const parametric = METHOD_PRIORITY.filter((method) => method !== 'isotonic' && complete(method)).map((method) => ({ method, loss: loss(method) }));
  if (!parametric.length) throw new Error('No monotone map was fitted in every fold');
  const best = Math.min(...parametric.map((candidate) => candidate.loss));
  const tied = parametric.filter((candidate) => candidate.loss <= best + METHOD_TIE);
  tied.sort((a, b) => METHOD_PRIORITY.indexOf(a.method) - METHOD_PRIORITY.indexOf(b.method));
  let chosen = tied[0].method;
  const isotonicWins = complete('isotonic') && loss('isotonic') < best - METHOD_TIE;
  if (isotonicWins && previousBest === 'isotonic') chosen = 'isotonic';
  const predicted = predictions.get(chosen)!;
  return {
    method: chosen,
    params: final.candidates.find((candidate) => candidate.method === chosen)!.params,
    fit: folds[folds.length - 1].fit,
    heldOut,
    predicted,
    metrics: calibrationMetrics(heldOut, (row) => predicted.get(row)!),
    reason: final.notes.length ? final.notes.join(' ') : null,
    heldOutBest: isotonicWins ? 'isotonic' : tied[0].method,
    days: folds.map((fold) => fold.day),
  };
}

/** Adds this block's winner. A refit of the same block replaces its entry. Five blocks are kept. */
export function recordHeldOutBest(
  history: PropCalibrationArtifact['held_out_best'],
  validatedThrough: string,
  method: PropCalibrationMethod,
): { validated_through: string; method: PropCalibrationMethod }[] {
  const kept = (Array.isArray(history) ? history : []).filter((entry) => entry && entry.validated_through !== validatedThrough);
  return [...kept, { validated_through: validatedThrough, method }]
    .sort((a, b) => a.validated_through.localeCompare(b.validated_through))
    .slice(-5);
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

/**
 * What 10-bin ECE a perfectly calibrated forecaster would show on these same probabilities, from outcomes redrawn at
 * each probability. On ~700 rows near 50%, sampling noise alone puts equal-frequency ECE near 0.05, so a fixed 0.03
 * bar fails even the no-vig price. Rows of one player-game are drawn independently here, which understates the noise,
 * so these floors are on the strict side.
 */
export interface EceNoise {
  width95: number;
  width99: number;
  freq95: number;
  freq99: number;
}

const NOISE_REPLICATES = 400;
const NOISE_SEED = 977;

export function eceNoise(probabilities: readonly number[], replicates = NOISE_REPLICATES, seed = NOISE_SEED): EceNoise {
  if (!probabilities.length) return { width95: 0, width99: 0, freq95: 0, freq99: 0 };
  const rng = mulberry32(seed);
  const width: number[] = [];
  const freq: number[] = [];
  for (let replicate = 0; replicate < replicates; replicate += 1) {
    const values = probabilities.map((p) => ({ p, y: rng() < p ? 1 : 0 }));
    width.push(eceOf(widthBins(values, ECE_BINS), values.length));
    freq.push(eceOf(frequencyBins(values, ECE_BINS), values.length));
  }
  width.sort((a, b) => a - b);
  freq.sort((a, b) => a - b);
  const at = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { width95: at(width, 0.95), width99: at(width, 0.99), freq95: at(freq, 0.95), freq99: at(freq, 0.99) };
}

/**
 * Red suspends a map, amber is reported. ECE is judged against the larger of the fixed bar and the noise floor for
 * this sample; without a floor the fixed bars apply. A NaN tier edge (no graded record) does not count.
 */
export function driftAction(
  signal: {
    eceWidth10: number;
    eceFreq10: number;
    slopeLo: number;
    slopeHi: number;
    interceptLo: number;
    interceptHi: number;
    tierEdge: number;
  },
  noise?: EceNoise,
): DriftLevel {
  const redWidth = Math.max(0.05, noise?.width99 ?? 0);
  const redFreq = Math.max(0.05, noise?.freq99 ?? 0);
  const amberWidth = Math.max(0.03, noise?.width95 ?? 0);
  const amberFreq = Math.max(0.03, noise?.freq95 ?? 0);
  if (signal.eceWidth10 > redWidth || signal.eceFreq10 > redFreq || signal.tierEdge < -0.01) return 'red';
  const slopeExcludesOne = signal.slopeLo > 1 || signal.slopeHi < 1;
  const interceptExcludesZero = signal.interceptLo > 0 || signal.interceptHi < 0;
  if (signal.eceWidth10 > amberWidth || signal.eceFreq10 > amberFreq || slopeExcludesOne || interceptExcludesZero || signal.tierEdge < 0) return 'amber';
  return 'green';
}

/** The blend may cost at most this much log loss against the no-vig price on the held-out block. */
export const BLEND_LOG_LOSS_TOLERANCE = 0.005;
const RELEASE_ECE = 0.03;
const RELEASE_VALIDATION_ROWS = 500;

/**
 * Whether a map ships, judged only on the later block it was not fitted on. Withholding a map means showing the raw
 * simulation, so the bar is relative: `issues` withhold the map when it does not beat the raw simulation on log loss,
 * Brier, and equal-width ECE, or when the blend falls more than 0.005 log loss behind the no-vig price.
 * `drift` red (ECE past the 99th-percentile noise floor) keeps the map, because it still beats the raw numbers, and
 * suspends listing for the group. `notes` are the release checks a BET verdict still needs; they hold nothing back.
 */
export function shippingCheck(input: {
  raw: PropCalibrationMetrics;
  calibrated: PropCalibrationMetrics;
  blended: PropCalibrationMetrics;
  noise: EceNoise;
  validationRows: number;
}): { issues: string[]; notes: string[]; drift: DriftLevel } {
  const { raw, calibrated, blended, noise } = input;
  const issues: string[] = [];
  const notes: string[] = [];
  if (!(calibrated.logLoss < raw.logLoss)) issues.push('Held-out log loss is not better than the raw simulation.');
  if (!(calibrated.brier < raw.brier)) issues.push('Held-out Brier score is not better than the raw simulation.');
  if (!(calibrated.eceWidth10 < raw.eceWidth10)) issues.push('Held-out equal-width ECE is not better than the raw simulation.');
  if (!(blended.logLoss <= blended.logLossNovig + BLEND_LOG_LOSS_TOLERANCE)) {
    issues.push('The blended probability trails the no-vig price by more than 0.005 log loss.');
  }
  const drift = driftAction({ ...calibrated, tierEdge: Number.NaN }, noise);
  if (drift === 'red') {
    notes.push(
      issues.length
        ? 'Drift is red: held-out ECE is past the 99th-percentile noise floor.'
        : 'Drift is red: held-out ECE is past the 99th-percentile noise floor, so leans in this group are not listed.',
    );
  }
  if (!(calibrated.slopeLo <= 1 && calibrated.slopeHi >= 1 && calibrated.interceptLo <= 0 && calibrated.interceptHi >= 0)) {
    notes.push('The held-out Cox slope or intercept interval misses 1 or 0.');
  }
  if (!(calibrated.eceWidth10 < RELEASE_ECE && calibrated.eceFreq10 < RELEASE_ECE)) notes.push('Held-out ECE is not under the 0.03 release bar.');
  if (!(blended.brier < blended.brierNovig)) notes.push('The blend does not beat the no-vig price on Brier score.');
  if (input.validationRows < RELEASE_VALIDATION_ROWS) notes.push(`Held-out rows ${input.validationRows} are below ${RELEASE_VALIDATION_ROWS}.`);
  return { issues, notes, drift };
}

function dayNumber(date: string): number {
  return Math.floor(Date.parse(`${date}T12:00:00Z`) / 86400000);
}

/** Applies only to the family it was fitted for, only while fitted, and only while its held-out block is recent. */
export function mapIsCurrent(card: Pick<PropCalibrationArtifact, 'status' | 'model_version' | 'validated_through'>, family: string | null | undefined, today: string): boolean {
  if (card.status !== 'fitted' || !family || card.model_version !== family) return false;
  const age = dayNumber(today) - dayNumber(card.validated_through);
  return Number.isFinite(age) && age <= MAP_MAX_AGE_DAYS;
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
    card.params.method === card.method &&
    (card.drift === undefined || card.drift === 'green' || card.drift === 'amber' || card.drift === 'red')
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
