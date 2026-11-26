import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildPicks } from '../scripts/build-picks.ts';
import type { BookLine } from '../src/book-lines.ts';
import { dailyPropForGame, dailyPropOffer, unprovenEvidence, type DailyPropPick } from '../src/daily-prop.ts';
import { compareOffers, isDailyOffer } from '../src/daily-price.ts';
import { emptyDay, postDailyPicks } from '../src/daily-ledger.ts';
import { parsePicksFile } from '../src/picks.ts';
import { parsePublishedPropCalibration, type PropCalibrationArtifact } from '../src/prop-calibration.ts';
import type { RateCard, Slate } from '../src/types.ts';

const source = JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/rate-card.json', 'utf8')) as RateCard;
const slate = JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/slate.json', 'utf8')) as Slate;
const at = '2026-11-02T18:00:00Z';
const now = new Date('2026-11-02T18:20:00Z');
const rate = source.games[0];
const game = { ...slate.games.find(g => g.event_id === rate.event_id)!, date: '2026-11-02', start_time: '2026-11-02T22:00:00Z', completed: false, status_state: 'pre' };
const card = { ...source, date: game.date, generated_at: at };
const player = rate.players.find(p => p.evidence?.minutes.state === 'observed' && p.evidence?.shooting.state === 'observed' &&
  !p.evidence.role_changed && p.minutes_weight === 1 && !p.replacement_level && !p.thin_sample)!;
const stats = (fn: (i: number) => number) => Uint16Array.from({ length: 10000 }, (_, i) => fn(i % 20));
const sample = { min: stats(i => i < 18 ? 30 : 0), pts: stats(i => i < 12 ? 20 : i < 16 ? 10 : 15), reb: stats(() => 3), ast: stats(() => 1), tpm: stats(() => 2) };
const simulation = { playerDraws: new Map([[player.athlete_id, sample]]) };
const metrics = { n: 2000, clusters: 500, eceWidth10: .01, eceFreq10: .01, mce: .02, brier: .2, brierNovig: .22, logLoss: .61, logLossNovig: .64,
  slope: 1, intercept: 0, slopeLo: .95, slopeHi: 1.05, interceptLo: -.02, interceptHi: .02, reliability: 0, resolution: .02 };
const artifact: PropCalibrationArtifact = { schema_version: 1, group: 'points', method: 'temperature', params: { method: 'temperature', temperature: 1 }, w: .5, status: 'fitted', reason: null,
  model_version: card.model_version!, input_hash: 'a'.repeat(64), fitted_through: '2026-10-30', validated_through: '2026-11-01', rows_fit: 4000, rows_validated: 2000, clusters_fit: 800, metrics_fit: metrics, metrics_validated: metrics };
const calibration = parsePublishedPropCalibration(JSON.stringify({ schema_version: 1, groups: { points: artifact } }))!;
const offer: BookLine = { event_id: game.event_id, athlete_id: player.athlete_id, market: 'pts', line: 15, over_odds: -110, under_odds: -110, priced_at: at, tip: game.start_time, book: 'Book A' };

function build(feed: BookLine[]) {
  const result = buildPicks({ slate: { ...slate, games: [game] }, card, feed: [feed], ledgers: new Map(), events: new Map(), previous: null, now, draws: () => simulation.playerDraws });
  const picks = parsePicksFile(JSON.stringify(result.picks))!;
  // This fixture represents a live record with enough positive measured outcomes in each eligible tier.
  for (const tier of picks.record.tiersLive) Object.assign(tier, { n: 450, wins: 265, pooled: 450, edge: .035 });
  return picks;
}

test('daily player prop uses the best current comparable offer and accounts for pushes and sit-outs', () => {
  const earlier = '2026-11-02T17:41:00Z';
  const feed = [offer, { ...offer, book: 'Book B', over_odds: 105 }, { ...offer, book: 'Book B', priced_at: earlier, over_odds: 150, line: 17.5 },
    { ...offer, book: 'Book B', priced_at: earlier, athlete_id: 'withdrawn' }];
  for (const quotes of [feed, [...feed].reverse()]) {
    const picks = build(quotes);
    assert.equal(picks.offers?.[game.event_id]?.length, 2);
    const top = dailyPropForGame(game, rate, simulation, picks, card, calibration, now)!;
    assert.deepEqual([top.grade, top.side, top.line, top.odds, top.book], ['LEAN', 'over', 15, 105, 'Book B']);
    assert.equal(top.evidence, 'Live-graded over leans this strong have beaten the posted price by 3.5 points across 450 leans.');
    const win = .5 * .75 + .5 * ((100 / 205) / (100 / 205 + 110 / 210));
    assert.ok(Math.abs(top.modelProbability - win) < 1e-10);
    assert.ok(Math.abs(top.expectedReturn - .8 * (win * 1.05 - (1 - win))) < 1e-10);
    assert.ok(Math.abs(top.projection - (12 * 20 + 4 * 10 + 2 * 15) / 18) < 1e-10);
  }
  const single = build([offer]);
  assert.equal(single.offers, undefined);
  assert.equal(dailyPropForGame(game, rate, simulation, single, card, calibration, now)?.book, 'Book A');
});

test('daily prop requires the current card, a pre-tip quote, current calibration and reliable player evidence', () => {
  const picks = build([offer]);
  const select = (file = picks, when = now, fixture = game, maps = calibration, rates = rate) => dailyPropForGame(fixture, rates, simulation, file, card, maps, when);
  assert.equal(select({ ...picks, input_hash: 'other' }), null);
  assert.equal(select({ ...picks, model_hash: 'other' }), null);
  assert.equal(select({ ...picks, generated_at: null }), null);
  assert.equal(select(build([{ ...offer, priced_at: '2026-11-02T18:45:00Z' }])), null);
  // A price stays current for six hours, then the offer drops even before the tip.
  const lateTip = { ...game, start_time: '2026-11-03T03:00:00Z' };
  assert.ok(select(picks, new Date('2026-11-03T00:00:00Z'), lateTip));
  assert.equal(select(picks, new Date('2026-11-03T00:00:01Z'), lateTip), null);
  assert.equal(select(picks, now, { ...game, status_state: 'in' }), null);
  assert.equal(select(picks, new Date(game.start_time)), null);
  assert.equal(select(picks, now, { ...game, date: '2026-11-01' }), null);
  // Without a live tier the same offer is no longer a lean, only the day's unproven edge.
  const unlisted = select({ ...picks, record: { ...picks.record, tiersLive: [] } })!;
  assert.deepEqual([unlisted.grade, unlisted.evidence], ['EDGE', 'Not a qualified pick: over leans this strong have no live-graded record yet.']);
  for (const changes of [{ drift: 'red' }, { validated_through: '2026-11-02' }, { fitted_through: '2026-10-01', validated_through: '2026-10-02' }]) {
    const invalid = parsePublishedPropCalibration(JSON.stringify({ schema_version: 1, groups: { points: { ...artifact, ...changes } } }))!;
    assert.equal(select(picks, now, game, invalid), null);
  }
  assert.equal(select(picks, now, game, calibration, { ...rate, players: [{ ...player, evidence: { ...player.evidence!, role_changed: true } }] }), null);
  const bad = { ...picks, offers: { [game.event_id]: [['', player.athlete_id, 'pts', 15, -110, -110, at]] } };
  assert.equal(parsePicksFile(JSON.stringify(bad)), null);
});

test('a daily player lean can become a bet only with released calibration', () => {
  const released = { model_version: card.model_version!, input_hash: 'a'.repeat(64), training_cutoff: '2026-10-01', evaluated_through: '2026-10-30',
    games: 600, settled_markets: 2200, margin_bias: 0, total_bias: 0, coverage80: .8, coverage90: .9, ece: .01, baseline_improvement: true, market_noninferiority: true, markets: ['pts'], status: 'passed' as const };
  const rated = { ...rate, players: [{ ...player, as_of: at, model_version: card.model_version, calibration: released }] };
  assert.equal(dailyPropForGame(game, rated, simulation, build([offer]), card, calibration, now)?.grade, 'BET');
});

test('a prop pick reads as a book lists it, with yes/no wording for double- and triple-doubles', () => {
  const pick: DailyPropPick = {
    eventId: '1', athleteId: '2', player: 'Guard Name', matchup: 'AAA @ BBB', market: 'pts', side: 'over', line: 24.5, odds: -110, book: 'Book',
    pricedAt: at, tip: game.start_time, projection: 26.34, modelProbability: 0.58, breakEven: 0.5238, expectedReturn: 0.1, grade: 'LEAN', evidence: 'Record.',
  };
  const points = dailyPropOffer(pick);
  assert.deepEqual([points.title, points.projectionLabel], ['Guard Name Over 24.5 points', 'Model projection 26.3 points']);
  assert.equal(dailyPropOffer({ ...pick, side: 'under', market: 'pra', line: 35.5 }).title, 'Guard Name Under 35.5 points + rebounds + assists');
  const double = dailyPropOffer({ ...pick, market: 'dd', line: 0.5, projection: 0.4167 });
  assert.deepEqual([double.title, double.projectionLabel], ['Guard Name to record a double-double', 'Simulated double-double in 42% of games played']);
  assert.equal(dailyPropOffer({ ...pick, market: 'td', side: 'under', line: 0.5 }).title, 'Guard Name no triple-double');
  assert.equal(points.evidence, 'Record.');
});

function withTiers(changes: Partial<{ edge: number; pooled: number }>) {
  const picks = build([offer]);
  for (const tier of picks.record.tiersLive) Object.assign(tier, changes);
  return picks;
}

test('an unlisted prop that clears the price, noise and data checks is the unproven edge, with its live record', () => {
  const losing = dailyPropForGame(game, rate, simulation, withTiers({ edge: -0.018, pooled: 882 }), card, calibration, now)!;
  assert.equal(losing.grade, 'EDGE');
  assert.equal(losing.evidence, 'Not a qualified pick: live-graded over leans this strong have settled 1.8 points short of the posted price across 882 leans.');
  // Same line, price and chance as the listed lean: only the grade and its evidence change.
  const lean = dailyPropForGame(game, rate, simulation, build([offer]), card, calibration, now)!;
  assert.deepEqual([losing.line, losing.odds, losing.side, losing.modelProbability, losing.expectedReturn],
    [lean.line, lean.odds, lean.side, lean.modelProbability, lean.expectedReturn]);
  assert.equal(dailyPropForGame(game, rate, simulation, withTiers({ edge: 0.02, pooled: 150 }), card, calibration, now)?.evidence,
    'Not a qualified pick: only 150 live-graded over leans this strong so far, and listing needs 200.');
  assert.equal(dailyPropForGame(game, rate, simulation, withTiers({ edge: 0.005, pooled: 500 }), card, calibration, now)?.evidence,
    'Not a qualified pick: live-graded over leans this strong have beaten the posted price by 0.5 points across 500 leans, short of the 1.0 listing needs.');
  assert.equal(unprovenEvidence('under', null), 'Not a qualified pick: under leans this strong have no live-graded record yet.');
});

test('an unproven edge still needs every other check, never becomes a bet, and never outranks a qualified pick', () => {
  const losing = withTiers({ edge: -0.018, pooled: 882 });
  const select = (when = now, fixture = game, maps = calibration, rates = rate) => dailyPropForGame(fixture, rates, simulation, losing, card, maps, when);
  for (const changes of [{ drift: 'red' }, { validated_through: '2026-11-02' }, { fitted_through: '2026-10-01', validated_through: '2026-10-02' }]) {
    const invalid = parsePublishedPropCalibration(JSON.stringify({ schema_version: 1, groups: { points: { ...artifact, ...changes } } }))!;
    assert.equal(select(now, game, invalid), null);
  }
  assert.equal(select(now, game, calibration, { ...rate, players: [{ ...player, evidence: { ...player.evidence!, role_changed: true } }] }), null);
  assert.equal(select(new Date(game.start_time)), null);
  // Released calibration lets a listed lean become a BET. An unlisted one stays an unproven edge.
  const released = { model_version: card.model_version!, input_hash: 'a'.repeat(64), training_cutoff: '2026-10-01', evaluated_through: '2026-10-30',
    games: 600, settled_markets: 2200, margin_bias: 0, total_bias: 0, coverage80: .8, coverage90: .9, ece: .01, baseline_improvement: true, market_noninferiority: true, markets: ['pts'], status: 'passed' as const };
  const rated = { ...rate, players: [{ ...player, as_of: at, model_version: card.model_version, calibration: released }] };
  assert.equal(select(now, game, calibration, rated)?.grade, 'EDGE');

  // When a pick is posted, any qualified pick, however small its return, comes before an unproven edge.
  const edge = { ...dailyPropOffer(select()!), expectedReturn: 0.4 };
  const qualified = { ...dailyPropOffer(dailyPropForGame(game, rate, simulation, build([offer]), card, calibration, now)!), eventId: 'other', expectedReturn: 0.02 };
  assert.ok(compareOffers(qualified, edge) < 0);
  assert.deepEqual(postDailyPicks(emptyDay(game.date), { prop: [edge, qualified], spread: [] }, now).map((pick) => pick.grade), ['LEAN']);
  assert.deepEqual(postDailyPicks(emptyDay(game.date), { prop: [edge], spread: [] }, now).map((pick) => [pick.grade, pick.settle]),
    [['EDGE', { kind: 'prop', athlete_id: player.athlete_id, market: 'pts', side: 'over', line: 15 }]]);
});

test('below the edge bar the best prop is still posted, as a thin edge or a top prop, with the reason it falls short', () => {
  const at = (over: number, under: number, picks = build([{ ...offer, over_odds: over, under_odds: under }])) => dailyPropForGame(game, rate, simulation, picks, card, calibration, now);
  // A 4-point claim inside the sampling noise, a 1.7-point claim, and a price the calibrated chance does not beat.
  const noisy = at(-180, 150)!;
  assert.equal(noisy.grade, 'THIN');
  assert.equal(noisy.evidence, 'Below the edge bar: the calibrated chance of 68.3% clears the 64.3% break-even by 4.0 points. The gap is inside the sampling noise, so it is not an advantage yet.');
  const thin = at(-220, 180)!;
  assert.equal(thin.grade, 'THIN');
  assert.equal(thin.evidence, 'Below the edge bar: the calibrated chance of 70.4% clears the 68.8% break-even by 1.7 points, short of the 3.0 a lean needs.');
  assert.ok(thin.expectedReturn > 0);
  const top = at(-300, 240)!;
  assert.deepEqual([top.grade, top.side, top.line], ['TOP', 'over', 15]);
  assert.ok(top.expectedReturn < 0 && top.modelProbability < top.breakEven);
  assert.equal(top.evidence, 'No edge at this price: the calibrated chance of 73.4% is under the 75.0% break-even. It was the closest player prop to an edge when posted, not a qualified pick.');

  // Posting takes a qualified lean first, then a thin edge, and a top prop only when nothing else is there.
  const lean = dailyPropOffer(at(-110, -110)!);
  const [thinOffer, topOffer] = [dailyPropOffer(thin), dailyPropOffer(top)];
  assert.equal(lean.grade, 'LEAN');
  const post = (props: ReturnType<typeof dailyPropOffer>[]) => postDailyPicks(emptyDay(game.date), { prop: props, spread: [] }, now)[0]?.grade;
  assert.equal(post([topOffer, thinOffer, lean]), 'LEAN');
  assert.equal(post([topOffer, { ...thinOffer, expectedReturn: 0.001 }]), 'THIN');
  assert.equal(post([topOffer]), 'TOP');
  // Only a top prop may be published at or under its break-even.
  assert.ok(isDailyOffer(topOffer));
  assert.equal(isDailyOffer({ ...topOffer, grade: 'THIN' }), false);
  assert.equal(isDailyOffer({ ...topOffer, expectedReturn: -1 }), false);

  // The data checks still turn a prop away below the bar.
  const topPriced = build([{ ...offer, over_odds: -300, under_odds: 240 }]);
  for (const changes of [{ drift: 'red' }, { validated_through: '2026-11-02' }, { fitted_through: '2026-10-01', validated_through: '2026-10-02' }]) {
    const invalid = parsePublishedPropCalibration(JSON.stringify({ schema_version: 1, groups: { points: { ...artifact, ...changes } } }))!;
    assert.equal(dailyPropForGame(game, rate, simulation, topPriced, card, invalid, now), null);
  }
  assert.equal(dailyPropForGame(game, { ...rate, players: [{ ...player, evidence: { ...player.evidence!, role_changed: true } }] }, simulation, topPriced, card, calibration, now), null);
  assert.equal(dailyPropForGame(game, rate, { playerDraws: new Map([[player.athlete_id, { ...sample, min: stats(i => i < 9 ? 30 : 0) }]]) }, topPriced, card, calibration, now), null,
    'a player who sits most draws is not posted');
});
