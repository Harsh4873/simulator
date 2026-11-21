import assert from 'node:assert/strict';
import test from 'node:test';
import { MIN_GAMES } from '../src/esports/config.ts';
import {
  cargoCount,
  cs2PerMapMean,
  earlierMean,
  esportsDocument,
  formatStat,
  meanOf,
  parseEsportsDocument,
  renderEsports,
  resultText,
  type EsportsTitle,
} from '../src/esports/props.ts';
import { csResult, likelyLineup } from '../scripts/build-esports-slate.ts';

test('the mean uses earlier games and leaves the displayed game out', () => {
  const earlier = Array.from({ length: MIN_GAMES }, (_, index) => ({ id: `m${index}`, start: index + 1, value: 2 }));
  const rows = [...earlier, { id: 'shown', start: 100, value: 50 }, { id: 'later', start: 200, value: 50 }];
  assert.equal(earlierMean(rows, 'shown', 100), 2);
  assert.equal(meanOf(earlier.map((row) => row.value)), 2);
  const oneMissing = earlier.map((row, index) => (index === 0 ? { ...row, value: null } : row));
  assert.equal(earlierMean([...oneMissing, { id: 'shown', start: 100, value: 9 }], 'shown', 100), null);
  const short = earlier.slice(0, MIN_GAMES - 1);
  assert.equal(earlierMean([...short, { id: 'shown', start: 100, value: 50 }], 'shown', 100), null);
});

test('a CS2 series contributes its total divided by its map count', () => {
  const rows = [
    ...Array.from({ length: MIN_GAMES - 1 }, (_, index) => ({ id: `s${index}`, start: index + 1, total: 10, maps: 1 })),
    { id: 'long', start: MIN_GAMES, total: 40, maps: 2 },
    { id: 'unplayed', start: MIN_GAMES + 1, total: 100, maps: 0 },
    { id: 'shown', start: 100, total: 90, maps: 3 },
  ];
  assert.equal(cs2PerMapMean(rows, 'shown', 100), 11.25);
  assert.equal(cs2PerMapMean(rows.filter((row) => row.id !== 'long'), 'shown', 100), null);
});

test('cargo CS keeps a zero and drops an empty string', () => {
  assert.equal(cargoCount(''), null);
  assert.equal(cargoCount('0'), 0);
  assert.equal(cargoCount('247'), 247);
  const present = ['1', '2', '3', '4', '5', '6', '7', ''].map((value) => cargoCount(value));
  assert.equal(meanOf(present), null);
  const withZero = ['1', '2', '3', '4', '5', '6', '7', '0'].map((value) => cargoCount(value));
  assert.equal(meanOf(withZero), 3.5);
});

test('fewer than 8 earlier values is null and renders with no digit', () => {
  const short = Array.from({ length: MIN_GAMES - 1 }, (_, index) => index + 1);
  assert.equal(meanOf(short), null);
  assert.equal(meanOf([...short, 8]), 4.5);
  assert.equal(formatStat(null), 'not fitted');
  assert.equal(/\d/.test(formatStat(null)), false);
  assert.equal(formatStat(11.25), '11.3');
});

function title(mean: number | null, start: string): EsportsTitle {
  return {
    title: 'Dota 2',
    source: 'OpenDota',
    matches: [{
      id: 'm1',
      start_time: start,
      teams: ['Alpha', 'Beta'],
      competition: 'League',
      players: [{ name: 'ace', team: 'Alpha', props: [{ stat: 'kills', mean }, { stat: 'deaths', mean: null }] }],
    }],
  };
}

test('a price or a win chance is rejected', () => {
  const now = new Date('2026-11-20T18:00:00Z');
  const doc = esportsDocument([title(11.25, '2026-11-20T18:00:00Z')], now);
  assert.equal(doc.model.name, 'esports-player-projections-v2');
  assert.ok(parseEsportsDocument(JSON.stringify({ ...doc, model: { ...doc.model, name: 'esports-player-means-v1' } })), 'files from before projections still parse');
  assert.ok(parseEsportsDocument(JSON.stringify({ ...doc, model: { ...doc.model, name: 'esports-player-projections-v1' } })), 'files from before the opponent adjustment still parse');
  assert.equal(doc.model.fitted, true);
  assert.match(doc.model.note, /own rate in his earlier games/);
  assert.match(doc.model.note, /each team is rated from its earlier results/);
  assert.match(doc.model.note, /CS2 is per map/);
  assert.match(doc.model.note, /calibrated/);
  assert.match(doc.model.note, /never part of its own projection/);
  assert.match(doc.model.note, /posted line/);
  const raw = JSON.stringify(doc);
  const parsed = parseEsportsDocument(raw);
  assert.ok(parsed);
  assert.equal(parsed.titles[0]?.matches[0]?.players[0]?.props[0]?.mean, 11.25);
  const html = renderEsports(parsed, now);
  assert.match(html, /11\.3/);
  assert.match(html, />not fitted</);
  assert.equal(/\d/.test(formatStat(null)), false);
  const old = renderEsports(parseEsportsDocument(JSON.stringify(esportsDocument([title(null, '2026-01-05T18:00:00Z')], now)))!, now);
  assert.equal(/Today/.test(old), false);
  assert.match(old, /Jan/);
  assert.equal(esportsDocument([title(null, now.toISOString())], now).model.fitted, false);
  for (const key of ['price', 'away_win', 'home_win', 'odds', 'spread', 'moneyline', 'line']) {
    const priced = JSON.parse(raw) as { titles: Record<string, unknown>[] };
    priced.titles[0]![key] = key === 'away_win' || key === 'home_win' ? 0.5 : -110;
    assert.equal(parseEsportsDocument(JSON.stringify(priced)), null, key);
  }
});

test('a CS2 lineup is the five who played most recently, and a result names the winner by team id', () => {
  const roster = ['coach', 'a', 'b', 'c', 'd', 'e', 'bench'].map((slug) => ({ slug, name: slug }));
  const last: Record<string, number> = { a: 50, b: 40, c: 30, d: 20, e: 10, bench: 1, coach: Number.NEGATIVE_INFINITY };
  assert.deepEqual(likelyLineup(roster, (slug) => last[slug]!).map((player) => player.slug), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(likelyLineup(roster.slice(0, 3), (slug) => last[slug]!).length, 3);
  const teams: [{ name: string; slug: string; id: number | null }, { name: string; slug: string; id: number | null }] = [
    { name: 'GamerLegion', slug: 'gl', id: 7 },
    { name: 'BIG', slug: 'big', id: 9 },
  ];
  assert.deepEqual(csResult({ status: 'finished', teams, score: [1, 2], winnerId: 9 }), { status: 'finished', winner: 'BIG', score: [1, 2] });
  assert.deepEqual(csResult({ status: 'current', teams, score: [1, 0], winnerId: null }), { status: 'live', winner: null, score: [1, 0] });
  assert.deepEqual(csResult({ status: 'upcoming', teams, score: null, winnerId: null }), { status: 'upcoming', winner: null, score: null });
  assert.equal(csResult({ status: 'finished', teams, score: [2, 0], winnerId: 12 }).winner, null);
  // The card shows players, not a team result: a status word and nothing about who won.
  assert.equal(resultText({ status: 'finished' }), 'Final');
  assert.equal(resultText({ status: 'live' }), 'Live');
  assert.equal(resultText({ status: 'upcoming' }), 'Upcoming');
  assert.equal(resultText({}), null);
});

test('a title whose feed returned no player history says so once instead of rows of "not fitted"', () => {
  const now = new Date('2026-11-20T18:00:00Z');
  const blank: EsportsTitle = {
    title: 'Dota 2',
    source: 'OpenDota',
    matches: [{
      id: 'd1',
      start_time: '2026-11-20T17:00:00Z',
      teams: ['Team A', 'Team B'],
      competition: 'League',
      status: 'finished',
      players: [{ name: 'one', team: 'Team A', props: [{ stat: 'kills', mean: null, projection: null }] }],
    }],
  };
  const html = renderEsports(esportsDocument([blank], now, [{ title: 'Dota 2', stat: 'kills', rows: 0, coverage: 0, mae: 0, dispersion: 1.5, bias: 1 }]), now);
  assert.match(html, /data-no-history>OpenDota returned no player history this run, so Dota 2 has no projections or averages until the next refresh\./);
  assert.doesNotMatch(html, /<table/);
  assert.doesNotMatch(html, /0 earlier games/);
});

test('team ratings use only earlier results, count each result once, and favor the side that keeps winning', async () => {
  const { eloRatings, winChance, ELO_BASE } = await import('../src/esports/projection.ts');
  const results = Array.from({ length: 12 }, (_, index) => ({ id: `g${index}`, at: index * 10, a: 'Strong', b: index % 2 ? 'Weak' : 'Middle', score: 1 }));
  const ratings = eloRatings([...results, ...results]);
  assert.equal(ratings.before('Strong', 0), ELO_BASE, 'nothing before the first result');
  assert.equal(ratings.played('Strong', 1_000), 12, 'a result listed twice counts once');
  assert.ok(ratings.before('Strong', 1_000) > ratings.before('Middle', 1_000));
  assert.ok(ratings.before('Strong', 55) < ratings.before('Strong', 1_000), 'a rating before a time leaves out later results');
  assert.ok(winChance(ratings.before('Strong', 1_000), ratings.before('Weak', 1_000)) > 0.7);
  assert.equal(winChance(1500, 1500), 0.5);
});

test('the opponent adjustment ships only when it beats the rate alone on earlier games', async () => {
  const { adjustedRate, fitOpponentModel } = await import('../src/esports/projection.ts');
  assert.equal(adjustedRate(6, 1, null, 0.5), 6, 'no chance, no adjustment');
  assert.equal(adjustedRate(6, 1, 0.8, 0.5), 6 * 1.3);
  assert.equal(adjustedRate(6, 1.5, 0, 0.9), 6 * 0.35, 'a floor keeps a count from collapsing');
  // Each player's count follows his side's chance: favorites score more, underdogs less, around a rate of 6.
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const players = (dependent: boolean) =>
    Array.from({ length: 30 }, (_, player) =>
      Array.from({ length: 24 }, (_, game) => {
        const expected = 0.15 + 0.7 * random();
        const won = random() < expected ? 1 : 0;
        const mean = dependent ? 6 * (1 + 1.2 * (expected - 0.5)) : 6;
        let count = 0;
        for (let draw = 0; draw < 12; draw += 1) count += random() < mean / 12 ? 1 : 0;
        return { id: `p${player}g${game}`, start: game, units: 1, value: count, outcome: won, expected };
      }),
    );
  const helped = fitOpponentModel(players(true), 6, 3);
  assert.ok(helped.sensitivity > 0, `sensitivity ${helped.sensitivity}`);
  assert.ok(helped.calibration.mae < helped.rateMae, 'the adjustment beat the rate alone');
  assert.ok(helped.calibration.mae < helped.baselineMae, 'and the plain ten-game average');
  assert.ok(helped.calibration.coverage >= 0.8);
  const ignored = fitOpponentModel(players(false), 6, 3);
  assert.equal(ignored.sensitivity, 0, 'a count that does not follow the opponent gets no adjustment');
});

test('CS2 reads a map at a time with maps 1-2 beside it, and a result reads against the projection on its own scale', () => {
  const now = new Date('2026-11-20T18:00:00Z');
  const doc = esportsDocument(
    [
      {
        title: 'CS2',
        source: 'BO3.gg',
        matches: [
          {
            id: 'cs1',
            start_time: '2026-11-20T15:00:00Z',
            teams: ['Alpha', 'Beta'],
            competition: 'Cup',
            status: 'finished',
            winner: 'Alpha',
            score: [2, 0],
            best_of: 3,
            players: [
              { name: 'ace', team: 'Alpha', props: [{ stat: 'kills', mean: 15.2, actual: 18.5, projection: { scope: 'map', mean: 15.6, p10: 10, p50: 15, p90: 21, maps12: { mean: 31.2, p10: 22, p50: 31, p90: 40 } } }] },
              { name: 'old', team: 'Beta', props: [{ stat: 'kills', mean: 14, actual: 9.5, projection: { scope: 'maps12', mean: 29, p10: 20, p50: 29, p90: 40 } }] },
            ],
          },
        ],
      },
    ],
    now,
    [{ title: 'CS2', stat: 'kills', rows: 900, coverage: 0.81, mae: 9, dispersion: 1.5, bias: 1, baseline_mae: 10, opponent: true }],
  );
  const parsed = parseEsportsDocument(JSON.stringify(doc));
  assert.ok(parsed);
  assert.equal(parsed.titles[0]?.matches[0]?.best_of, 3);
  const html = renderEsports(parsed, now);
  assert.match(html, /<span class="th-sub">a map<\/span>/);
  assert.match(html, /data-maps12>Maps 1–2 31 · 22–40</);
  assert.match(html, /data-actual data-result="over">Played 18\.5</);
  // An older file's maps 1-2 number does not read against a map's average.
  assert.match(html, /<span class="pct" data-actual>Played 9\.5</);
  assert.match(html, /title="Plain average 15\.2 a map"/);
  assert.match(html, /kills 10% closer than his plain average, 81% inside the range/);
  // A maps 1-2 band on a per-game number, or a broken band, fails the file.
  const broken = JSON.parse(JSON.stringify(doc));
  broken.titles[0].matches[0].players[0].props[0].projection.maps12.p10 = 50;
  assert.equal(parseEsportsDocument(JSON.stringify(broken)), null);
  const misplaced = JSON.parse(JSON.stringify(doc));
  misplaced.titles[0].matches[0].players[0].props[0].projection.scope = 'game';
  assert.equal(parseEsportsDocument(JSON.stringify(misplaced)), null);
});
