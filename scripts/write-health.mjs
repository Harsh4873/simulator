import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

/** A source check is published only when it belongs to this exact card and is not from the future. */
export function publishedHealth(card, health, now = Date.now()) {
  if (!health || health.input_hash !== card.input_hash || health.model_hash !== card.model_hash) return null;
  const checked = Date.parse(health.checked_at);
  if (!Number.isFinite(checked) || checked > now + 300000) return null;
  return {checked_at: health.checked_at, input_hash: health.input_hash, model_hash: health.model_hash};
}

function findFile(dir, name) {
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(path, name);
      if (found) return found;
    } else if (entry.name === name) return path;
  }
  return null;
}

/** Pages artifacts are a zip of artifact.tar, or an already extracted data directory. */
export function readPublishedHealth(dir) {
  const direct = findFile(dir, 'health.json');
  if (direct) return JSON.parse(readFileSync(direct, 'utf8'));
  const packed = findFile(dir, 'artifact.tar');
  if (!packed) return null;
  const dest = mkdtempSync(join(tmpdir(), 'pages-health-'));
  try {
    execFileSync('tar', ['-xf', packed, '-C', dest]);
    const inner = findFile(dest, 'health.json');
    return inner ? JSON.parse(readFileSync(inner, 'utf8')) : null;
  } finally {
    rmSync(dest, {recursive: true, force: true});
  }
}

function writeHealth(health) {
  writeFileSync('dist/data/health.json', JSON.stringify(health));
}

function carryForward(card) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) return null;
  const runs = JSON.parse(execFileSync('gh', ['api', `repos/${repo}/actions/workflows/deploy-pages.yml/runs?status=success&per_page=12`], {encoding: 'utf8'}));
  const current = process.env.GITHUB_RUN_ID;
  for (const run of runs.workflow_runs ?? []) {
    if (String(run.id) === current) continue;
    const dir = mkdtempSync(join(tmpdir(), 'carry-health-'));
    try {
      execFileSync('gh', ['run', 'download', String(run.id), '-R', repo, '-n', 'github-pages', '-D', dir], {stdio: ['ignore', 'ignore', 'pipe']});
      const health = publishedHealth(card, readPublishedHealth(dir));
      if (health) return {health, runId: run.id};
    } catch {
      // This deployment has no readable artifact. Keep looking.
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  }
  return null;
}

function main() {
  const card = JSON.parse(readFileSync('dist/data/rate-card.json', 'utf8'));
  if (process.env.CHECKED_AT) {
    const health = publishedHealth(card, {checked_at: process.env.CHECKED_AT, input_hash: process.env.INPUT_HASH, model_hash: process.env.MODEL_HASH});
    if (!health) throw new Error('Health attestation does not match deployed inputs');
    writeHealth(health);
    return;
  }
  const carried = carryForward(card);
  if (!carried) {
    console.log('No matching source check to carry forward');
    return;
  }
  writeHealth(carried.health);
  console.log(`Carried forward source check ${carried.health.checked_at} from deployment ${carried.runId}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
