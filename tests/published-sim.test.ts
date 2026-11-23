import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { publishSims } from '../scripts/publish-sims.ts';
import { validateArtifact } from '../scripts/validate-artifact.mjs';
import { marginsOf, renderBoxScore } from '../src/boxscore.ts';
import {
  fetchPublishedIndex,
  fetchPublishedSimulation,
  hydrateSimulation,
  parsePublishedSim,
  publishedIndex,
  summarizeSimulation,
  type PublishedExpectation,
} from '../src/published-sim.ts';
import { playedMean, playedValues } from '../src/projections.ts';
import { gradeProp, quoteProp, type PropMarket } from '../src/props.ts';
import { fnv1a } from '../src/rng.ts';
import { simulate } from '../src/simulate.ts';
import type { RateCard, Slate } from '../src/types.ts';

const card = JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/rate-card.json', 'utf8')) as RateCard;
const slate = JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/slate.json', 'utf8')) as Slate;
const game = card.games[0];
const draws = 600;
const seed = fnv1a(`${game.event_id}:${card.generated_at ?? ''}`);
const expected: PublishedExpectation = {
  event_id: game.event_id,
  generated_at: card.generated_at,
  input_hash: card.input_hash ?? null,
  model_hash: card.model_hash ?? null,
  seed,
  iterations: draws,
};
const live = simulate(game, seed, draws);
const published = summarizeSimulation(live, { event_id: expected.event_id, generated_at: expected.generated_at, input_hash: expected.input_hash, model_hash: expected.model_hash, seed });
const text = JSON.stringify(published);
const MARKETS: PropMarket[] = ['pts', 'reb', 'ast', 'tpm', 'pra', 'pa', 'pr', 'ra', 'stl', 'blk', 'tov', 'dd', 'td'];

test('a published game answers every over, under and projection question exactly as the live draws do', () => {
  const file = parsePublishedSim(text, expected);
  assert.ok(file);
  const hydrated = hydrateSimulation(file);
  assert.equal(hydrated.published, true);
  assert.equal(hydrated.playerDraws.size, live.playerDraws.size);
  let compared = 0;
  for (const [athleteId, series] of live.playerDraws) {
    const rebuilt = hydrated.playerDraws.get(athleteId)!;
    assert.equal(rebuilt.min.length, draws);
    for (const market of MARKETS) {
      if ((market === 'stl' || market === 'blk' || market === 'tov') && !series[market]) {
        assert.equal(rebuilt[market], undefined);
        continue;
      }
      assert.deepEqual(
        Array.from(playedValues(rebuilt, market)).sort((a, b) => a - b),
        Array.from(playedValues(series, market)).sort((a, b) => a - b),
        `${athleteId} ${market}`,
      );
      assert.equal(playedMean(playedValues(rebuilt, market)), playedMean(playedValues(series, market)));
      for (const line of market === 'dd' || market === 'td' ? [0.5] : [0.5, 2.5, 5.5, 10.5, 19.5, 30.5]) {
        for (const side of ['over', 'under'] as const) {
          assert.deepEqual(gradeProp(rebuilt, market, side, line), gradeProp(series, market, side, line), `${athleteId} ${market} ${side} ${line}`);
          compared += 1;
        }
      }
    }
    const price = quoteProp(rebuilt, 'pra', 'over', 20.5, -115, -105);
    assert.deepEqual(price, quoteProp(series, 'pra', 'over', 20.5, -115, -105));
  }
  assert.ok(compared > 1000);
  // Everything the box score shows is carried as computed: scores, ranges, win shares, distributions, the shown draw.
  for (const key of ['away', 'home', 'wins', 'forecast', 'distributions', 'index', 'budget', 'overtime', 'regulationAwayPts', 'leaders'] as const) {
    assert.deepEqual(JSON.parse(JSON.stringify(hydrated[key])), JSON.parse(JSON.stringify(live[key])), key);
  }
  assert.deepEqual([...hydrated.combinedTotals].sort((a, b) => a - b), [...live.combinedTotals].sort((a, b) => a - b));
  const liveMargins = live.homeTotals.map((home, index) => home - live.awayTotals[index]).sort((a, b) => a - b);
  assert.deepEqual([...marginsOf(hydrated)].sort((a, b) => a - b), liveMargins);
  // The box score renders from the counts alone, charts included.
  const html = renderBoxScore(slate.games.find((item) => item.event_id === game.event_id)!, game, hydrated, new Date(card.generated_at!));
  assert.match(html, /class="charts"/);
  assert.match(html, /Home margin/);
});

test('a published file is used only for the same card, seed and draw count, and only when its counts add up', () => {
  assert.ok(parsePublishedSim(text, expected));
  const tamper = (edit: (file: typeof published) => void) => {
    const copy = structuredClone(published);
    edit(copy);
    return JSON.stringify(copy);
  };
  assert.equal(parsePublishedSim('{', expected), null);
  assert.equal(parsePublishedSim(text, { ...expected, seed: seed + 1 }), null);
  assert.equal(parsePublishedSim(text, { ...expected, generated_at: '2026-11-03T00:00:00Z' }), null);
  assert.equal(parsePublishedSim(text, { ...expected, model_hash: 'other' }), null);
  assert.equal(parsePublishedSim(text, { ...expected, input_hash: 'other' }), null);
  assert.equal(parsePublishedSim(text, { ...expected, iterations: 10000 }), null);
  assert.equal(parsePublishedSim(text, { ...expected, event_id: 'other' }), null);
  assert.equal(parsePublishedSim(tamper((file) => { (file as { schema_version: number }).schema_version = 2; }), expected), null);
  const [athleteId] = Object.keys(published.players);
  assert.equal(parsePublishedSim(tamper((file) => { file.players[athleteId].pts[0] += 1; }), expected), null);
  assert.equal(parsePublishedSim(tamper((file) => { file.players[athleteId].played += 1; }), expected), null);
  assert.equal(parsePublishedSim(tamper((file) => { file.players[athleteId].pra.push(-1); }), expected), null);
  assert.equal(parsePublishedSim(tamper((file) => { file.totals.counts[0] += 1; }), expected), null);
  assert.equal(parsePublishedSim(tamper((file) => { file.margins.counts = []; }), expected), null);
  assert.equal(parsePublishedSim(tamper((file) => { (file as { summary: unknown }).summary = null; }), expected), null);
  assert.equal(parsePublishedSim(tamper((file) => { file.players[athleteId].min[0] = 1; file.players[athleteId].min[1] = 0; }), expected), null);
});

test('the page asks for a published game and the games it lists, and draws its own whenever either does not match', async () => {
  const files = new Map<string, string>([[`sims/${game.event_id}.json`, text], ['sims/index.json', JSON.stringify(publishedIndex({ generated_at: expected.generated_at, input_hash: expected.input_hash, model_hash: expected.model_hash, iterations: draws }, [game.event_id, '2']))]]);
  const get = async (name: string) => files.get(name) ?? null;
  const sim = await fetchPublishedSimulation(get, expected);
  assert.equal(sim?.published, true);
  assert.equal(await fetchPublishedSimulation(get, { ...expected, seed: seed + 1 }), null);
  assert.equal(await fetchPublishedSimulation(get, { ...expected, event_id: '999' }), null);
  assert.equal(await fetchPublishedSimulation(async () => { throw new Error('offline'); }, expected), null);
  const base = { generated_at: expected.generated_at, input_hash: expected.input_hash, model_hash: expected.model_hash, iterations: draws };
  assert.deepEqual([...(await fetchPublishedIndex(get, base))].sort(), ['2', game.event_id].sort());
  assert.equal((await fetchPublishedIndex(get, { ...base, generated_at: '2026-11-03T00:00:00Z' })).size, 0);
  assert.equal((await fetchPublishedIndex(get, { ...base, iterations: 10000 })).size, 0);
  assert.equal((await fetchPublishedIndex(async () => null, base)).size, 0);
  assert.equal((await fetchPublishedIndex(async () => 'not json', base)).size, 0);
});

test('the deploy step writes one checked file per playable game, the index last, and a game it cannot draw is left out', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sim-published-'));
  try {
    const small = structuredClone(card);
    small.games = [structuredClone(card.games[0]), structuredClone(card.games[1]), structuredClone(card.games[2])];
    small.games[2].simulation_error = 'Simulation unavailable for team 1: fewer than five eligible players remain.';
    writeFileSync(join(dir, 'rate-card.json'), JSON.stringify(small));
    const lines: string[] = [];
    const result = publishSims({ dataDir: dir, iterations: 300, log: (line) => lines.push(line) });
    assert.deepEqual(result.written, [small.games[0].event_id, small.games[1].event_id]);
    assert.deepEqual(result.skipped, [small.games[2].event_id]);
    assert.deepEqual(readdirSync(join(dir, 'sims')).sort(), ['index.json', `${small.games[0].event_id}.json`, `${small.games[1].event_id}.json`].sort());
    const base = { generated_at: small.generated_at, input_hash: small.input_hash ?? null, model_hash: small.model_hash ?? null };
    const index = JSON.parse(readFileSync(join(dir, 'sims/index.json'), 'utf8'));
    assert.deepEqual(index, { schema_version: 1, ...base, iterations: 300, events: [...result.written].sort() });
    for (const event of result.written) {
      const file = readFileSync(join(dir, `sims/${event}.json`), 'utf8');
      // The seed is the one the page derives from the same card, so the page accepts the file as its own draw.
      assert.ok(parsePublishedSim(file, { event_id: event, ...base, seed: fnv1a(`${event}:${small.generated_at ?? ''}`), iterations: 300 }));
    }
    assert.equal(lines.length, 2);
    assert.match(lines[0], /KB in/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the artifact check allows published simulation files and still rejects anything else under data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sim-artifact-'));
  try {
    const put = (path: string, body = '{}') => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), body);
    };
    put('index.html', '<html></html>');
    put('favicon.svg', '<svg/>');
    put('assets/app.js', '');
    put('data/slate.json', JSON.stringify(slate));
    put('data/rate-card.json', JSON.stringify({ generator_sha: 'a'.repeat(40) }));
    put('data/sims/index.json');
    put('data/sims/401909980.json');
    assert.doesNotThrow(() => validateArtifact(dir));
    put('data/sims/401909980.json.bak');
    assert.throws(() => validateArtifact(dir), /Unexpected public artifact: data\/sims\/401909980\.json\.bak/);
    rmSync(join(dir, 'data/sims/401909980.json.bak'));
    put('data/sims/abc.json');
    assert.throws(() => validateArtifact(dir), /Unexpected public artifact: data\/sims\/abc\.json/);
    rmSync(join(dir, 'data/sims/abc.json'));
    put('data/ledger.json');
    assert.throws(() => validateArtifact(dir), /Unexpected public artifact: data\/ledger\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
