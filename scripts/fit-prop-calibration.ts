// Fits a prop-probability map per stat group from live ledger rows of the card's simulation family. Each run fits on
// the older 70% of settled tip dates and scores the map on the newer 30%, which it never saw. A map ships only while
// it beats the raw simulation on those later games; otherwise its group goes back to the raw simulation. Replay rows
// are never fitted.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chicagoDate } from '../src/date.ts';
import { parseLedger } from '../src/pick-ledger.ts';
import type { LedgerFile } from '../src/picks.ts';
import {
  BLEND_PRIOR,
  SPEC_BRIER,
  SPEC_ECE_WIDTH10,
  SPEC_LOG_LOSS,
  SPEC_SETTLED_ROWS,
  SPEC_THROUGH,
  applyCalibration,
  blendWithMarket,
  calibrationMetrics,
  censusIsMaterial,
  eceNoise,
  expectedCalibrationError,
  fitBlendWeight,
  previousHeldOutBest,
  recordHeldOutBest,
  reliabilityBins,
  rowsFromLedger,
  selectWalkForward,
  shippingCheck,
  walkForwardFolds,
  type PropCalibrationArtifact,
  type PropCalibrationGroup,
  type PropCalibrationMetrics,
  type PropCalibrationRow,
  type WalkForwardFold,
  type WalkForwardSelection,
} from '../src/prop-calibration.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GROUPS: readonly PropCalibrationGroup[] = ['points', 'rebAst', 'tpm', 'defense'];
const GROUP_LABEL: Record<PropCalibrationGroup, string> = { points: 'Points and point combos', rebAst: 'Rebounds, assists, and R+A', tpm: 'Threes', defense: 'Steals and blocks' };
export const MIN_GROUP_FIT_ROWS = 300;
export const MIN_VALIDATION_CLUSTERS = 100;
const UNCONFIRMED_WEIGHT_CAP = 0.25;
const CONFIRMED_WEIGHT_ROWS = 2000;
const WEIGHT_MATCH = 1e-9;
const MEAN_BIAS_NOTE = 'Mean-bias checks were not run. The ledger stores no projection, and the sims archive is not used.';

export interface FileCensus {
  date: string;
  source: LedgerFile['source'];
  rows: number;
  settled: number;
  voids: number;
  pushes: number;
  unsettled: number;
}

export function describeFile(file: LedgerFile): FileCensus {
  let voids = 0;
  let pushes = 0;
  let unsettled = 0;
  let settled = 0;
  for (const row of file.rows) {
    if (!row.result) {
      unsettled += 1;
      continue;
    }
    if ('void' in row.result) {
      voids += 1;
      continue;
    }
    const snap = row.last ?? row.open;
    if (row.result.actual === snap.line) pushes += 1;
    else settled += 1;
  }
  return { date: file.date, source: file.source, rows: file.rows.length, settled, voids, pushes, unsettled };
}

export function refuseNonLive(files: readonly LedgerFile[]): void {
  for (const file of files) {
    if (file.source !== 'live') throw new Error(`Refusing prop calibration fit: ${file.date} is ${file.source}`);
  }
}

function median(values: readonly number[]): number | null {
  const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!finite.length) return null;
  const mid = Math.floor(finite.length / 2);
  return finite.length % 2 ? finite[mid] : (finite[mid - 1] + finite[mid]) / 2;
}

function inputHash(rows: readonly PropCalibrationRow[], modelVersion: string): string {
  const identities = rows.map((row) => `${row.date}:${row.key}:${row.market}`).sort();
  return createHash('sha256').update(`${identities.join('\n')}\n${modelVersion}`).digest('hex');
}

function fmt(value: number): string {
  return Number.isFinite(value) ? value.toFixed(4) : 'n/a';
}

const lastDate = (rows: readonly PropCalibrationRow[]) => rows.reduce((last, row) => (row.date > last ? row.date : last), rows[0].date);

export interface CalibrationRun {
  action: 'refused' | 'written';
  reportPath: string;
  artifacts: string[];
  qualifying: number;
  settledNonPush: number;
  metrics: PropCalibrationMetrics | null;
}

interface RunContext {
  outDir: string;
  reportPath: string;
  today: string;
  family: string;
  directory: readonly LedgerFile[];
  qualifying: readonly PropCalibrationRow[];
  settledNonPush: number;
  metrics: PropCalibrationMetrics | null;
  noteLine: string;
}

/**
 * Whether this tree still reproduces the release note on the days the note measured. Report only: a mismatch here
 * means the census code or those ledger days changed, which the report should say, but later days never block a fit.
 */
function releaseNoteLine(files: readonly LedgerFile[]): string {
  const window = files.filter((file) => file.date <= SPEC_THROUGH);
  const settled = window.reduce((sum, file) => sum + describeFile(file).settled, 0);
  // The note measured the three groups it had; steals and blocks were added after it.
  const rows = rowsFromLedger(window).filter((row) => row.group !== 'defense');
  const metrics = rows.length ? calibrationMetrics(rows, (row) => row.p) : null;
  const material = censusIsMaterial(settled, metrics);
  return `Release note through ${SPEC_THROUGH}: ${SPEC_SETTLED_ROWS.toLocaleString('en-US')} settled non-push live rows, ECE ${SPEC_ECE_WIDTH10}, Brier ${SPEC_BRIER}, log loss ${SPEC_LOG_LOSS}. This tree on those days: ${settled.toLocaleString('en-US')} rows, ECE ${fmt(metrics?.eceWidth10 ?? Number.NaN)}, Brier ${fmt(metrics?.brier ?? Number.NaN)}, log loss ${fmt(metrics?.logLoss ?? Number.NaN)}. ${material ? 'It does not reproduce the note.' : 'It reproduces the note.'}`;
}

export function executeCalibration(
  files: readonly LedgerFile[],
  options: { outDir: string; directory?: readonly LedgerFile[]; modelVersion?: string | null; now?: Date },
): CalibrationRun {
  refuseNonLive(files);
  const directory = options.directory ?? files;
  const today = chicagoDate(options.now ?? new Date());
  mkdirSync(options.outDir, { recursive: true });
  const reportPath = join(options.outDir, `report-${today}.md`);
  const settledNonPush = files.reduce((sum, file) => sum + describeFile(file).settled, 0);
  const noteLine = releaseNoteLine(files);
  if (!options.modelVersion) {
    const qualifying = rowsFromLedger(files);
    const metrics = qualifying.length ? calibrationMetrics(qualifying, (row) => row.p) : null;
    const context: RunContext = { outDir: options.outDir, reportPath, today, family: 'none', directory, qualifying, settledNonPush, metrics, noteLine };
    return refuse(context, 'The rate card has no model_version, so a map cannot be keyed to a simulation family.');
  }
  const qualifying = rowsFromLedger(files, options.modelVersion);
  const metrics = qualifying.length ? calibrationMetrics(qualifying, (row) => row.p) : null;
  return fitGroups({ outDir: options.outDir, reportPath, today, family: options.modelVersion, directory, qualifying, settledNonPush, metrics, noteLine });
}

function censusMarkdown(context: RunContext): string[] {
  const { directory, qualifying, settledNonPush, metrics } = context;
  const counts = { points: 0, rebAst: 0, tpm: 0, defense: 0 };
  for (const row of qualifying) counts[row.group] += 1;
  const age = median(qualifying.map((row) => row.lineAgeMinutes));
  const bins = qualifying.length ? reliabilityBins(qualifying, (row) => row.p) : [];
  return [
    `Simulation family ${context.family}. ${settledNonPush.toLocaleString('en-US')} settled non-push live rows, ${qualifying.length.toLocaleString('en-US')} of them qualifying calibration rows from this family.`,
    '',
    context.noteLine,
    '',
    '## Census',
    '',
    '| File | Source | Rows | Settled | Voids | Pushes | Unsettled |',
    '|---|---|---:|---:|---:|---:|---:|',
    ...directory.map(describeFile).map((row) => `| ${row.date} | ${row.source} | ${row.rows} | ${row.settled} | ${row.voids} | ${row.pushes} | ${row.unsettled} |`),
    '',
    '| Group | Qualifying rows |',
    '|---|---:|',
    `| points | ${counts.points} |`,
    `| rebAst | ${counts.rebAst} |`,
    `| tpm | ${counts.tpm} |`,
    `| defense | ${counts.defense} |`,
    '',
    '| Score, every qualifying row | ECE width 10 | ECE freq 10 | Brier | Log loss |',
    '|---|---:|---:|---:|---:|',
    `| Raw simulation | ${fmt(metrics?.eceWidth10 ?? Number.NaN)} | ${fmt(metrics?.eceFreq10 ?? Number.NaN)} | ${fmt(metrics?.brier ?? Number.NaN)} | ${fmt(metrics?.logLoss ?? Number.NaN)} |`,
    `| No-vig price | ${fmt(qualifying.length ? expectedCalibrationError(qualifying, (row) => row.noVig, 10, 'width') : Number.NaN)} | ${fmt(qualifying.length ? expectedCalibrationError(qualifying, (row) => row.noVig, 10, 'frequency') : Number.NaN)} | ${fmt(metrics?.brierNovig ?? Number.NaN)} | ${fmt(metrics?.logLossNovig ?? Number.NaN)} |`,
    '',
    `Median line age of the qualifying rows: ${age === null ? 'n/a' : `${age.toFixed(1)} minutes`}.`,
    '',
    'Reliability of the raw simulation, 10 equal-width bins:',
    '',
    '| Bin | n | Mean p | Actual rate |',
    '|---|---:|---:|---:|',
    ...bins.filter((bin) => bin.n > 0).map((bin) => `| ${bin.lo.toFixed(1)}–${bin.hi.toFixed(1)} | ${bin.n} | ${bin.meanP.toFixed(3)} | ${bin.rate.toFixed(3)} |`),
    '',
  ];
}

function refuse(context: RunContext, detail: string): CalibrationRun {
  writeFileSync(
    context.reportPath,
    [`# Prop calibration ${context.today}`, '', '## No map fitted', '', detail, '', ...censusMarkdown(context)].join('\n'),
  );
  return { action: 'refused', reportPath: context.reportPath, artifacts: [], qualifying: context.qualifying.length, settledNonPush: context.settledNonPush, metrics: context.metrics };
}

function readArtifact(path: string): PropCalibrationArtifact | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PropCalibrationArtifact;
  } catch {
    return null;
  }
}

function scoresRow(label: string, metrics: PropCalibrationMetrics): string {
  return `| ${label} | ${fmt(metrics.logLoss)} | ${fmt(metrics.brier)} | ${fmt(metrics.eceWidth10)} | ${fmt(metrics.eceFreq10)} |`;
}

function fitGroups(context: RunContext): CalibrationRun {
  const { qualifying, family, outDir } = context;
  if (new Set(qualifying.map((row) => row.date)).size < 2) {
    return refuse(context, 'Fewer than two settled tip dates: one day cannot be both the fit and the later check.');
  }
  const prepared: {
    group: PropCalibrationGroup;
    validatedThrough: string;
    previous: PropCalibrationArtifact | null;
    selected: WalkForwardSelection;
  }[] = [];
  const skipped: string[] = [];
  for (const group of GROUPS) {
    const rows = qualifying.filter((row) => row.group === group);
    let folds: WalkForwardFold[];
    try {
      folds = walkForwardFolds(rows, MIN_GROUP_FIT_ROWS);
    } catch (error) {
      skipped.push(`- ${GROUP_LABEL[group]}: ${error instanceof Error ? error.message : String(error)}. Stays raw.`);
      continue;
    }
    const clusters = new Set(folds.flatMap((fold) => fold.validation.map((row) => row.key))).size;
    if (!folds.length || clusters < MIN_VALIDATION_CLUSTERS) {
      const earliest = rows.length ? rows.reduce((first, row) => (row.date < first ? row.date : first), rows[0].date) : null;
      skipped.push(
        `- ${GROUP_LABEL[group]}: ${rows.length} settled rows${earliest ? ` since ${earliest}` : ''}. A day is scored once ${MIN_GROUP_FIT_ROWS} earlier rows exist, and the scored days need ${MIN_VALIDATION_CLUSTERS} player-games; they hold ${clusters}. Stays raw.`,
      );
      continue;
    }
    const stored = readArtifact(join(outDir, `${group}.json`));
    const previous = stored && stored.model_version === family ? stored : null;
    const validatedThrough = folds[folds.length - 1].day;
    try {
      const selected = selectWalkForward(folds, previousHeldOutBest(previous?.held_out_best, validatedThrough));
      prepared.push({ group, validatedThrough, previous, selected });
    } catch (error) {
      skipped.push(`- ${GROUP_LABEL[group]}: ${error instanceof Error ? error.message : String(error)}. Stays raw.`);
    }
  }
  if (!prepared.length) {
    return refuse(context, `No group has enough rows yet.\n\n${skipped.join('\n')}`);
  }
  const pooled = prepared.flatMap((item) => item.selected.heldOut);
  const owner = new Map<PropCalibrationRow, WalkForwardSelection>();
  for (const item of prepared) for (const row of item.selected.heldOut) owner.set(row, item.selected);
  const forecastOf = (row: PropCalibrationRow) => owner.get(row)!.predicted.get(row)!;
  const open = fitBlendWeight(pooled, forecastOf);
  // A weight past the cap needs a mature fit and an earlier held-out block that chose the same weight.
  const mature = prepared.some((item) => item.selected.fit.length >= CONFIRMED_WEIGHT_ROWS);
  const repeated = prepared.every(
    (item) => item.previous?.w_open !== undefined && Math.abs(item.previous.w_open - open) < WEIGHT_MATCH && item.previous.validated_through < item.validatedThrough,
  );
  const weight = mature && repeated ? open : fitBlendWeight(pooled, forecastOf, UNCONFIRMED_WEIGHT_CAP);
  const written: string[] = [];
  const sections: string[] = [];
  for (const item of prepared) {
    const { selected } = item;
    const heldOut = selected.heldOut;
    const forecast = (row: PropCalibrationRow) => selected.predicted.get(row)!;
    const raw = calibrationMetrics(heldOut, (row) => row.p);
    const blended = calibrationMetrics(heldOut, (row) => blendWithMarket(forecast(row), row.noVig, weight));
    const noise = eceNoise(heldOut.map(forecast));
    const check = shippingCheck({ raw, calibrated: selected.metrics, blended, noise, validationRows: heldOut.length });
    const notes = [...(selected.reason ? [selected.reason] : []), ...check.notes, MEAN_BIAS_NOTE];
    const artifact: PropCalibrationArtifact = {
      schema_version: 1,
      group: item.group,
      method: selected.method,
      model_version: family,
      input_hash: inputHash(selected.fit, family),
      fitted_through: lastDate(selected.fit),
      validated_through: item.validatedThrough,
      validated_from: selected.days[0],
      rows_fit: selected.fit.length,
      rows_validated: heldOut.length,
      clusters_fit: new Set(selected.fit.map((row) => row.key)).size,
      params: selected.params,
      w: weight,
      metrics_fit: calibrationMetrics(selected.fit, (row) => applyCalibration(selected.params, row.p)),
      metrics_validated: selected.metrics,
      status: check.issues.length ? 'rejected' : 'fitted',
      reason: check.issues.length ? check.issues.join(' ') : null,
      metrics_raw: raw,
      notes,
      drift: check.drift,
      w_open: open,
      held_out_best: recordHeldOutBest(item.previous?.held_out_best, item.validatedThrough, selected.heldOutBest),
    };
    const path = join(outDir, `${item.group}.json`);
    writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
    written.push(path);
    const sample = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8].map((p) => `${p.toFixed(1)} → ${applyCalibration(selected.params, p).toFixed(3)}`).join(', ');
    sections.push(
      [
        `## ${GROUP_LABEL[item.group]}: ${artifact.status === 'fitted' ? 'map applied' : 'map withheld'}`,
        '',
        `Walk-forward: each tip date from ${selected.days[0]} through ${item.validatedThrough} (${selected.days.length} days, ${heldOut.length} rows, ${selected.metrics.clusters} player-games) was scored by a ${artifact.method} map fitted only on earlier days. The shipped map is fitted on ${artifact.rows_fit} rows through ${artifact.fitted_through}. Drift ${artifact.drift}.`,
        '',
        '| Held-out score | Log loss | Brier | ECE width 10 | ECE freq 10 |',
        '|---|---:|---:|---:|---:|',
        scoresRow('Raw simulation', raw),
        scoresRow('Calibrated', item.selected.metrics),
        scoresRow(`Blended, w ${weight}`, blended),
        `| No-vig price | ${fmt(blended.logLossNovig)} | ${fmt(blended.brierNovig)} | | |`,
        '',
        `Raw to calibrated: ${sample}.`,
        `Sampling-noise ECE for these rows at the 95th percentile: width ${fmt(noise.width95)}, frequency ${fmt(noise.freq95)}.`,
        '',
        ...(artifact.reason ? [`Withheld: ${artifact.reason}`, ''] : []),
        ...notes.map((note) => `- ${note}`),
        '',
      ].join('\n'),
    );
  }
  const flat = Math.abs(weight - BLEND_PRIOR) < WEIGHT_MATCH;
  writeFileSync(
    context.reportPath,
    [
      `# Prop calibration ${context.today}`,
      '',
      'Every settled tip date is scored by a map fitted only on the days before it, and the scores are pooled over the last ten such days. A group is shown calibrated only while that pooled score beats the raw simulation. The shipped map is the one fitted on every day before the last, so it too was scored on a day it never saw.',
      '',
      `Blend weight ${weight}${flat ? ' (the curve is flat up to the cap, so the 0.2 prior stands)' : ''}: the page shows ${weight} of the calibrated chance plus ${Number((1 - weight).toFixed(2))} of the no-vig price. Over all weights the lowest log loss is at ${open}. A weight above ${UNCONFIRMED_WEIGHT_CAP} needs ${CONFIRMED_WEIGHT_ROWS} fit rows in a group and an earlier held-out block that chose the same weight.`,
      '',
      ...sections,
      ...(skipped.length ? ['## Not fitted yet', '', ...skipped, ''] : []),
      ...censusMarkdown(context),
    ].join('\n'),
  );
  return { action: 'written', reportPath: context.reportPath, artifacts: written, qualifying: qualifying.length, settledNonPush: context.settledNonPush, metrics: context.metrics };
}

function loadDirectory(dir: string): LedgerFile[] {
  if (!existsSync(dir)) return [];
  const files: LedgerFile[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) continue;
    files.push(parseLedger(readFileSync(join(dir, name), 'utf8')));
  }
  return files;
}

function main(): void {
  const root = process.env.PICKS_ROOT ?? ROOT;
  const directory = loadDirectory(join(root, 'data/pick-ledger'));
  const live = directory.filter((file) => file.source === 'live');
  let modelVersion: string | null = null;
  try {
    const card = JSON.parse(readFileSync(join(root, 'public/data/rate-card.json'), 'utf8')) as { model_version?: string };
    modelVersion = typeof card.model_version === 'string' && card.model_version ? card.model_version : null;
  } catch {
    modelVersion = null;
  }
  const result = executeCalibration(live, { outDir: join(root, 'data/prop-calibration'), directory, modelVersion });
  const groups = result.artifacts.map((path) => {
    const artifact = readArtifact(path);
    return artifact ? `${artifact.group}:${artifact.method}:${artifact.status}` : path;
  });
  console.log(
    JSON.stringify({
      action: result.action,
      family: modelVersion,
      settled_non_push_live: result.settledNonPush,
      qualifying: result.qualifying,
      raw_log_loss: result.metrics ? Number(result.metrics.logLoss.toFixed(4)) : null,
      groups,
      report: result.reportPath,
    }),
  );
}

function runningAsCli(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (runningAsCli()) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
