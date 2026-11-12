import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {publishedHealth, readPublishedHealth} from '../scripts/write-health.mjs';

const card = {input_hash: 'input', model_hash: 'model'};
const health = {checked_at: '2026-11-12T14:30:27Z', input_hash: 'input', model_hash: 'model'};
const now = Date.parse('2026-11-12T18:00:00Z');

test('a source check publishes only when it matches the card and is not in the future', () => {
  assert.deepEqual(publishedHealth(card, health, now), health);
  assert.equal(publishedHealth(card, {...health, model_hash: 'other'}, now), null);
  assert.equal(publishedHealth(card, {...health, checked_at: '2026-11-12T18:10:00Z'}, now), null);
  assert.equal(publishedHealth(card, null, now), null);
});

test('health is read from an extracted directory or a Pages artifact tar', () => {
  const root = mkdtempSync(join(tmpdir(), 'health-publish-'));
  try {
    mkdirSync(join(root, 'plain', 'data'), {recursive: true});
    writeFileSync(join(root, 'plain', 'data', 'health.json'), JSON.stringify(health));
    assert.deepEqual(readPublishedHealth(join(root, 'plain')), health);

    const packed = join(root, 'packed');
    mkdirSync(join(root, 'stage', 'data'), {recursive: true});
    writeFileSync(join(root, 'stage', 'data', 'health.json'), JSON.stringify(health));
    mkdirSync(packed);
    execFileSync('tar', ['-cf', join(packed, 'artifact.tar'), '-C', join(root, 'stage'), 'data']);
    assert.deepEqual(readPublishedHealth(packed), health);
    const empty = mkdtempSync(join(root, 'empty-'));
    assert.equal(readPublishedHealth(empty), null);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('an explicit source check is written only when it matches the built card', () => {
  const root = mkdtempSync(join(tmpdir(), 'health-script-'));
  const previous = process.cwd();
  try {
    mkdirSync(join(root, 'dist', 'data'), {recursive: true});
    writeFileSync(join(root, 'dist', 'data', 'rate-card.json'), JSON.stringify(card));
    process.chdir(root);
    execFileSync('node', [join(previous, 'scripts/write-health.mjs')], {
      stdio: 'pipe',
      env: {...process.env, CHECKED_AT: health.checked_at, INPUT_HASH: 'nope', MODEL_HASH: health.model_hash},
    });
    assert.equal(readFileSync(join(root, 'dist', 'data', 'health.json'), 'utf8'), '', 'script should have thrown before writing');
  } catch (error) {
    assert.match(String(error), /Health attestation does not match deployed inputs/);
  } finally {
    process.chdir(previous);
    rmSync(root, {recursive: true, force: true});
  }
  const ok = mkdtempSync(join(tmpdir(), 'health-script-'));
  try {
    mkdirSync(join(ok, 'dist', 'data'), {recursive: true});
    writeFileSync(join(ok, 'dist', 'data', 'rate-card.json'), JSON.stringify(card));
    process.chdir(ok);
    execFileSync('node', [join(previous, 'scripts/write-health.mjs')], {
      env: {...process.env, CHECKED_AT: health.checked_at, INPUT_HASH: health.input_hash, MODEL_HASH: health.model_hash, GITHUB_REPOSITORY: ''},
    });
    assert.equal(readFileSync(join(ok, 'dist', 'data', 'health.json'), 'utf8'), JSON.stringify(health));
  } finally {
    process.chdir(previous);
    rmSync(ok, {recursive: true, force: true});
  }
});
