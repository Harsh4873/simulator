// Fits a prop-probability map from live ledger rows only. A census that misses the release note
// writes a report and no group file. Replay rows are never fitted.
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
  applyCalibration,
  blendWithMarket,
  calibrationMetrics,
  censusIsMaterial,
  expectedCalibrationError,
  fitBlendWeight,
  reliabilityBins,
  rowsFromLedger,
  selectMethod,
  splitChronological,
  splitTipDates,
  type PropCalibrationArtifact,
  type PropCalibrationGroup,
  type PropCalibrationMetrics,
  type PropCalibrationRow,
} from '../src/prop-calibration.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GROUPS: readonly PropCalibrationGroup[] = ['points', 'rebAst', 'tpm'];
const MIN_GROUP_FIT_ROWS = 300;
const MIN_VALIDATION_CLUSTERS = 100;
const MIN_VALIDATION_ROWS = 500;
const UNCONFIRMED_WEIGHT_CAP = 0.25;
const CONFIRMED_WEIGHT_ROWS = 2000;
const WEIGHT_MATCH = 1e-9;

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

export interface CalibrationRun {
  action: 'mismatch' | 'refused' | 'written';
  reportPath: string;
  artifacts: string[];
  qualifying: number;
  settledNonPush: number;
  metrics: PropCalibrationMetrics | null;
}

export function executeCalibration(
  files: readonly LedgerFile[],
  options: { outDir: string; directory?: readonly LedgerFile[]; modelVersion?: string | null; force?: boolean; now?: Date },
): CalibrationRun {
  refuseNonLive(files);
  const directory = options.directory ?? files;
  const qualifying = rowsFromLedger(files);
  const settledNonPush = files.reduce((sum, file) => sum + describeFile(file).settled, 0);
  const metrics = qualifying.length ? calibrationMetrics(qualifying, (row) => row.p) : null;
  const today = chicagoDate(options.now ?? new Date());
  mkdirSync(options.outDir, { recursive: true });
  const reportPath = join(options.outDir, `report-${today}.md`);
  if (censusIsMaterial(settledNonPush, metrics)) {
    writeFileSync(reportPath, mismatchReport(directory, qualifying, settledNonPush, metrics, today));
    return { action: 'mismatch', reportPath, artifacts: [], qualifying: qualifying.length, settledNonPush, metrics };
  }
  return fitGroups(qualifying, directory, settledNonPush, metrics, { ...options, reportPath, today });
}

function censusMarkdown(
  directory: readonly LedgerFile[],
  qualifying: readonly PropCalibrationRow[],
  settledNonPush: number,
  metrics: PropCalibrationMetrics | null,
): string[] {
  const counts = { points: 0, rebAst: 0, tpm: 0 };
  for (const row of qualifying) counts[row.group] += 1;
  const age = median(qualifying.map((row) => row.lineAgeMinutes));
  const lines = directory.map(describeFile);
  const bins = qualifying.length ? reliabilityBins(qualifying, (row) => row.p) : [];
  return [
    `The release note measured ${SPEC_SETTLED_ROWS.toLocaleString('en-US')} settled non-push live rows, with 10-bin equal-width ECE ${SPEC_ECE_WIDTH10}, Brier ${SPEC_BRIER}, and log loss ${SPEC_LOG_LOSS}.`,
    `This tree has ${settledNonPush} settled non-push live rows and ${qualifying.length} qualifying calibration rows.`,
    '',
    '## Census',
    '',
    '| File | Source | Rows | Settled | Voids | Pushes | Unsettled |',
    '|---|---|---:|---:|---:|---:|---:|',
    ...lines.map((row) => `| ${row.date} | ${row.source} | ${row.rows} | ${row.settled} | ${row.voids} | ${row.pushes} | ${row.unsettled} |`),
    '',
    '| Group | Qualifying rows |',
    '|---|---:|',
    `| points | ${counts.points} |`,
    `| rebAst | ${counts.rebAst} |`,
    `| tpm | ${counts.tpm} |`,
    '',
    '| Score | ECE width 10 | ECE freq 10 | Brier | Log loss |',
    '|---|---:|---:|---:|---:|',
    `| Raw model | ${fmt(metrics?.eceWidth10 ?? Number.NaN)} | ${fmt(metrics?.eceFreq10 ?? Number.NaN)} | ${fmt(metrics?.brier ?? Number.NaN)} | ${fmt(metrics?.logLoss ?? Number.NaN)} |`,
    `| No-vig price | ${fmt(qualifying.length ? expectedCalibrationError(qualifying, (row) => row.noVig, 10, 'width') : Number.NaN)} | ${fmt(qualifying.length ? expectedCalibrationError(qualifying, (row) => row.noVig, 10, 'frequency') : Number.NaN)} | ${fmt(metrics?.brierNovig ?? Number.NaN)} | ${fmt(metrics?.logLossNovig ?? Number.NaN)} |`,
    '',
    `Median line age of the qualifying rows: ${age === null ? 'n/a' : `${age.toFixed(1)} minutes`}.`,
    '',
    'Reliability of the raw model, 10 equal-width bins:',
    '',
    '| Bin | n | Mean p | Actual rate |',
    '|---|---:|---:|---:|',
    ...bins.filter((bin) => bin.n > 0).map((bin) => `| ${bin.lo.toFixed(1)}–${bin.hi.toFixed(1)} | ${bin.n} | ${bin.meanP.toFixed(3)} | ${bin.rate.toFixed(3)} |`),
    '',
  ];
}

function mismatchReport(
  directory: readonly LedgerFile[],
  qualifying: readonly PropCalibrationRow[],
  settledNonPush: number,
  metrics: PropCalibrationMetrics | null,
  today: string,
): string {
  return [
    `# Prop calibration ${today}`,
    '',
    '## Census mismatch',
    '',
    ...censusMarkdown(directory, qualifying, settledNonPush, metrics),
    'The gap is material, so no map was fitted and selectMethod was not called.',
    '',
    '## §7.5 items not met',
    '',
    '- No held-out day. Live logging on this tree does not have a later validation block.',
    '- No group has a later validation block of at least 100 clusters.',
    '- Mean-bias checks were not run. The ledger stores no projection, and there is no sims archive to join.',
    `- Settled non-push live rows are ${settledNonPush}, below 2,000.`,
    '- PROP_POLICY.calibrated stays false.',
    '- No map was fitted. No group JSON was written.',
    '',
  ].join('\n');
}

function refusalReport(
  directory: readonly LedgerFile[],
  qualifying: readonly PropCalibrationRow[],
  settledNonPush: number,
  metrics: PropCalibrationMetrics | null,
  today: string,
  detail: string,
): string {
  return [
    `# Prop calibration ${today}`,
    '',
    '## Fit refused',
    '',
    ...censusMarkdown(directory, qualifying, settledNonPush, metrics),
    detail,
    '',
    '## §7.5 items not met',
    '',
    '- No group has a later validation block of at least 100 clusters, so selectMethod was not called.',
    '- Mean-bias checks were not run. The ledger stores no projection, and there is no sims archive to join.',
    '- PROP_POLICY.calibrated stays false.',
    '- No map was fitted. No group JSON was written.',
    '',
  ].join('\n');
}

function fitGroups(
  qualifying: readonly PropCalibrationRow[],
  directory: readonly LedgerFile[],
  settledNonPush: number,
  metrics: PropCalibrationMetrics | null,
  options: { outDir: string; reportPath: string; today: string; modelVersion?: string | null; force?: boolean },
): CalibrationRun {
  const dates = [...new Set(qualifying.map((row) => row.date))].sort();
  const days = splitTipDates(dates);
  if (!days) {
    writeFileSync(options.reportPath, refusalReport(directory, qualifying, settledNonPush, metrics, options.today, 'One settled day cannot be both the fit and the validation.'));
    return { action: 'refused', reportPath: options.reportPath, artifacts: [], qualifying: qualifying.length, settledNonPush, metrics };
  }
  let split: { fit: PropCalibrationRow[]; validation: PropCalibrationRow[] };
  try {
    split = splitChronological(qualifying, days.fit[days.fit.length - 1]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeFileSync(options.reportPath, refusalReport(directory, qualifying, settledNonPush, metrics, options.today, `Refused: ${message}`));
    return { action: 'refused', reportPath: options.reportPath, artifacts: [], qualifying: qualifying.length, settledNonPush, metrics };
  }
  const prepared: {
    group: PropCalibrationGroup;
    fit: PropCalibrationRow[];
    validation: PropCalibrationRow[];
    selected: ReturnType<typeof selectMethod>;
  }[] = [];
  const skipped: string[] = [];
  for (const group of GROUPS) {
    const fit = split.fit.filter((row) => row.group === group);
    const validation = split.validation.filter((row) => row.group === group);
    const clusters = new Set(validation.map((row) => row.key)).size;
    if (fit.length < MIN_GROUP_FIT_ROWS || clusters < MIN_VALIDATION_CLUSTERS) {
      skipped.push(`${group}: fit rows ${fit.length}, validation clusters ${clusters}`);
      continue;
    }
    prepared.push({ group, fit, validation, selected: selectMethod(fit, validation) });
  }
  if (!options.modelVersion) {
    writeFileSync(options.reportPath, refusalReport(directory, qualifying, settledNonPush, metrics, options.today, 'Refused: the rate card has no model_hash, so a map cannot be versioned.'));
    return { action: 'refused', reportPath: options.reportPath, artifacts: [], qualifying: qualifying.length, settledNonPush, metrics };
  }
  if (!prepared.length) {
    writeFileSync(options.reportPath, refusalReport(directory, qualifying, settledNonPush, metrics, options.today, `Refused before a map was written.\n\n${skipped.join('\n')}`));
    return { action: 'refused', reportPath: options.reportPath, artifacts: [], qualifying: qualifying.length, settledNonPush, metrics };
  }
  const pooled = prepared.flatMap((item) => item.validation);
  const weightOf = (row: PropCalibrationRow) => {
    const item = prepared.find((candidate) => candidate.group === row.group);
    return item ? applyCalibration(item.selected.params, row.p) : row.p;
  };
  let weight = fitBlendWeight(pooled, weightOf);
  const previous = prepared.map((item) => previousWeight(options.outDir, item.group));
  const mature = prepared.some((item) => item.fit.length >= CONFIRMED_WEIGHT_ROWS);
  const repeated = previous.every((value) => value !== null) && previous.every((value) => Math.abs((value ?? 0) - weight) < WEIGHT_MATCH);
  if (!(mature && repeated)) weight = Math.min(weight, UNCONFIRMED_WEIGHT_CAP);
  const written: string[] = [];
  const sections: string[] = [];
  for (const item of prepared) {
    const reasons = item.selected.reason ? [item.selected.reason] : [];
    reasons.push('Mean-bias checks were not run. The ledger stores no projection, and the sims archive is not used.');
    const raw = calibrationMetrics(item.validation, (row) => row.p);
    const blended = calibrationMetrics(item.validation, (row) => blendWithMarket(applyCalibration(item.selected.params, row.p), row.noVig, weight));
    if (!(item.selected.metrics.logLoss < raw.logLoss)) reasons.push('Calibrated validation log loss is not better than the raw model.');
    if (item.validation.length < MIN_VALIDATION_ROWS) reasons.push(`Validation rows ${item.validation.length} are below ${MIN_VALIDATION_ROWS}.`);
    if (!(Math.abs(blended.logLoss - blended.logLossNovig) <= 0.005 && blended.eceWidth10 < 0.03 && blended.eceFreq10 < 0.03 && blended.brier < blended.brierNovig)) {
      reasons.push('Calibrated-and-blended validation does not meet the log-loss, ECE, and Brier gates.');
    }
    if (!(item.selected.metrics.eceWidth10 < 0.05 && item.selected.metrics.eceFreq10 < 0.05)) reasons.push('Group validation ECE is not under 0.05.');
    if (!(item.selected.metrics.slopeLo <= 1 && item.selected.metrics.slopeHi >= 1 && item.selected.metrics.interceptLo <= 0 && item.selected.metrics.interceptHi >= 0)) {
      reasons.push('Cox slope or intercept confidence interval misses the target.');
    }
    const artifact: PropCalibrationArtifact = {
      schema_version: 1,
      group: item.group,
      method: item.selected.method,
      model_version: options.modelVersion,
      input_hash: inputHash(item.fit, options.modelVersion),
      fitted_through: item.fit.reduce((last, row) => (row.date > last ? row.date : last), item.fit[0].date),
      validated_through: item.validation.reduce((last, row) => (row.date > last ? row.date : last), item.validation[0].date),
      rows_fit: item.fit.length,
      rows_validated: item.validation.length,
      clusters_fit: new Set(item.fit.map((row) => row.key)).size,
      params: item.selected.params,
      w: weight,
      metrics_fit: calibrationMetrics(item.fit, (row) => applyCalibration(item.selected.params, row.p)),
      metrics_validated: item.selected.metrics,
      status: reasons.length ? 'rejected' : 'fitted',
      reason: reasons.length ? reasons.join(' ') : null,
    };
    const path = join(options.outDir, `${item.group}.json`);
    if (existsSync(path) && !options.force) {
      const previousArtifact = JSON.parse(readFileSync(path, 'utf8')) as { model_version?: string };
      if (previousArtifact.model_version && previousArtifact.model_version !== artifact.model_version) {
        console.warn(`skip ${item.group}: existing model_version differs; pass --force`);
        sections.push(`${item.group} was not overwritten because its model_version differs.`);
        continue;
      }
    }
    writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
    written.push(path);
    sections.push(`${item.group}: ${artifact.method}, status ${artifact.status}, validation log loss ${fmt(artifact.metrics_validated.logLoss)}, w ${weight}. ${artifact.reason ?? ''}`);
  }
  const flat = Math.abs(weight - BLEND_PRIOR) < WEIGHT_MATCH;
  writeFileSync(
    options.reportPath,
    [
      `# Prop calibration ${options.today}`,
      '',
      `Global blend weight ${weight}${flat ? ' (flat curve, prior 0.2)' : ''}. One validation block cannot confirm a second win, so a non-flat weight stays capped at ${UNCONFIRMED_WEIGHT_CAP} until a group has ${CONFIRMED_WEIGHT_ROWS} fit rows and the stored weight matches.`,
      '',
      ...sections,
      '',
      skipped.length ? `Skipped:\n\n${skipped.join('\n')}` : '',
      '',
    ].join('\n'),
  );
  return { action: 'written', reportPath: options.reportPath, artifacts: written, qualifying: qualifying.length, settledNonPush, metrics };
}

function previousWeight(dir: string, group: PropCalibrationGroup): number | null {
  const path = join(dir, `${group}.json`);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { w?: number };
    return typeof parsed.w === 'number' ? parsed.w : null;
  } catch {
    return null;
  }
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

function printCensus(directory: readonly LedgerFile[], result: CalibrationRun): void {
  console.log('file source rows settled voids pushes unsettled');
  for (const row of directory.map(describeFile)) {
    console.log(`${row.date} ${row.source} ${row.rows} ${row.settled} ${row.voids} ${row.pushes} ${row.unsettled}`);
  }
  console.log(`qualifying ${result.qualifying}`);
  console.log(`settled non-push live ${result.settledNonPush}`);
  console.log(`eceWidth10 ${fmt(result.metrics?.eceWidth10 ?? Number.NaN)} eceFreq10 ${fmt(result.metrics?.eceFreq10 ?? Number.NaN)} brier ${fmt(result.metrics?.brier ?? Number.NaN)} logLoss ${fmt(result.metrics?.logLoss ?? Number.NaN)}`);
  console.log(`brierNovig ${fmt(result.metrics?.brierNovig ?? Number.NaN)} logLossNovig ${fmt(result.metrics?.logLossNovig ?? Number.NaN)}`);
  console.log(`spec settled ${SPEC_SETTLED_ROWS} ece ${SPEC_ECE_WIDTH10} brier ${SPEC_BRIER} logLoss ${SPEC_LOG_LOSS}`);
  console.log(`action ${result.action}`);
  console.log(`report ${result.reportPath}`);
  console.log(`artifacts ${result.artifacts.length ? result.artifacts.join(',') : 'none'}`);
}

function main(): void {
  const root = process.env.PICKS_ROOT ?? ROOT;
  const directory = loadDirectory(join(root, 'data/pick-ledger'));
  const live = directory.filter((file) => file.source === 'live');
  let modelVersion: string | null = null;
  try {
    const card = JSON.parse(readFileSync(join(root, 'public/data/rate-card.json'), 'utf8')) as { model_hash?: string };
    modelVersion = card.model_hash ?? null;
  } catch {
    modelVersion = null;
  }
  const result = executeCalibration(live, {
    outDir: join(root, 'data/prop-calibration'),
    directory,
    modelVersion,
    force: process.argv.includes('--force'),
  });
  printCensus(directory, result);
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
