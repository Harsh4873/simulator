import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { parseHTML } from 'linkedom';
import { hashCanonical, loadArchiveSummaries } from '../scripts/build-rate-card.ts';
import { availabilityHistory } from '../src/availability-history.ts';
import { percent, renderPropResults, type PropFormState } from '../src/boxscore.ts';
import { propBarsSvg } from '../src/charts.ts';
import type { ForecastArchive } from '../src/forecast-archive.ts';
import { canonical, streamCanonical } from '../src/generation.ts';
import type { CompletedEvent } from '../src/parse-summary.ts';
import {
  buildProjectionContext,
  computeHitWindows,
  computeStreak,
  unpackOnOff,
  unpackPlayerGames,
  unpackTeamAllowed,
} from '../src/projection-context.ts';
import { gradeProp, quoteProp, type PlayerSample } from '../src/props.ts';
import {
  defaultMarketLine,
  gradedPropLine,
  modelChanceHtml,
  modelSidesInner,
  naturalHookLine,
  nearestHalfPoint,
  playedMean,
  playedValues,
  propEligible,
  projectionBoardHtml,
  renderProjections,
  slateLeans,
  searchHitsHtml,
  viewerLine,
  type ProjectionView,
} from '../src/projections.ts';
import { applyHealthyCalibration, calibrateHealthy, MIN_CALIBRATION_ROWS } from '../src/participation-model.ts';
import { hydrateSimulationCache, persistSimulationEntry } from '../src/simulation-cache.ts';
import { CAMEO_MINUTE_CAP, conditionalMinutes, ITERATIONS, simulate, type Simulation } from '../src/simulate.ts';
import { fitCurrentRoles, NEWCOMER_MINUTES_PRIOR } from '../src/team-model.ts';
import type { RateCard, RatePlayer, Slate } from '../src/types.ts';

const card = JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/rate-card.json', 'utf8')) as RateCard;
const slate = JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/slate.json', 'utf8')) as Slate;
const game = card.games[0];
const slateGame = slate.games.find((item) => item.event_id === game.event_id);
const seed = 55;
const draws = 200;

test('played means, model chances, and priced copy stay on the prop grader', () => {
  assert.ok(slateGame);
  assert.equal(ITERATIONS, 10000);
  assert.match(readFileSync('src/main.ts', 'utf8'), /iterations:\s*ITERATIONS/);
  const simulation = simulate(game, seed, draws);
  const ranked = game.players
    .map((player) => {
      const line = [...simulation.away.players, ...simulation.home.players].find((item) => item.athlete_id === player.athlete_id);
      return { player, played: line?.expectation?.played ?? null };
    })
    .filter((item) => item.played && item.played.ptsMean > 0)
    .sort((a, b) => (b.played?.ptsMean ?? 0) - (a.played?.ptsMean ?? 0));
  const picked = ranked[0];
  assert.ok(picked?.played);
  const player = picked.player;
  const sample = simulation.playerDraws.get(player.athlete_id);
  assert.ok(sample);
  const points = playedValues(sample, 'pts');
  assert.equal(playedMean(points), picked.played.ptsMean);
  assert.equal(playedMean(playedValues(sample, 'reb')), picked.played.rebMean);
  assert.equal(playedMean(playedValues(sample, 'ast')), picked.played.astMean);
  assert.equal(playedMean(playedValues(sample, 'tpm')), picked.played.counts?.tpm);
  assert.equal(playedMean(playedValues(sample, 'pra')), picked.played.praMean);
  const line = 15.5;
  const over = gradeProp(sample, 'pts', 'over', line);
  const under = gradeProp(sample, 'pts', 'under', line);
  const overRate = over.wins / (over.wins + over.losses);
  const underRate = under.wins / (under.wins + under.losses);
  const quote = quoteProp(sample, 'pts', 'over', line, -110);
  assert.ok(quote);
  assert.equal(overRate, quote.modelProbability);
  assert.equal(underRate, quoteProp(sample, 'pts', 'under', line, -110)?.modelProbability);
  assert.ok(overRate !== null && underRate !== null);
  assert.ok(Math.abs(overRate + underRate - 1) < 1e-12);

  const form: PropFormState = {
    market: 'pts',
    side: 'over',
    line: '15.5',
    style: 'american',
    odds: '-110',
    opposite: '',
  };
  const html = renderProjections({
    slate,
    card,
    now: new Date('2026-11-02T23:00:00Z'),
    query: player.name.split(' ')[0] ?? player.name,
    eventId: game.event_id,
    athleteId: player.athlete_id,
    form,
    simulation,
    drawing: false,
    overrides: {},
  });
  const priced = renderPropResults(simulation, player.athlete_id, form, player);
  const chance = /Model chance<\/dt><dd>([^<]+)<\/dd>/.exec(priced)?.[1];
  const edge = /Estimated edge<\/dt><dd[^>]*>([^<]+)<\/dd>/.exec(priced)?.[1];
  assert.ok(chance);
  assert.ok(edge);
  assert.equal(chance, percent(quote.modelProbability ?? Number.NaN));
  assert.equal(html.includes(chance), true);
  assert.equal(html.includes(edge), true);
  const chances = html.slice(html.indexOf('data-model-chances'), html.indexOf('data-prop-results'));
  assert.equal(chances.includes(chance), true);
  assert.match(html, new RegExp(player.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const phrase of ['L5', 'L10', 'usage %', 'fantasy', 'per 36', 'defense rank']) {
    assert.equal(html.toLowerCase().includes(phrase.toLowerCase()), false, phrase);
  }
  const mate = teammate(game.players, player);
  assert.ok(mate);
  const chips = /data-teammates[\s\S]*?<\/div>\s*<\/div>/.exec(html)?.[0] ?? '';
  assert.match(chips, new RegExp(mate.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(chips.includes('+2.0'), false);
  assert.match(html, /A simulator, not a betting ticket/);
  assert.match(html, /Means from the draws this player actually played/);
  const simulated = [...simulation.away.players, ...simulation.home.players].find((item) => item.athlete_id === player.athlete_id);
  const share = `${((simulated?.expectation?.playRate ?? Number.NaN) * 100).toFixed(1)}%`;
  assert.match(html, new RegExp(`play-meter-value">${share.replace('.', '\\.')}`));
  assert.equal(html.includes('data-event='), false);

  const half = nearestHalfPoint(points);
  assert.ok(half >= 0);
  assert.equal(Math.round(half * 2), half * 2);
  assert.equal(viewerLine('dd', points), 0.5);
  assert.equal(viewerLine('td', points), 0.5);
  assert.equal(modelChanceHtml(sample, 'pts', '').includes('%'), false);
  assert.equal(modelChanceHtml(sample, 'pts', '15.25').includes('%'), false);
  assert.equal(modelChanceHtml(sample, 'pts', '-3').includes('%'), false);
  const bars = propBarsSvg(points, line, 'Points');
  assert.match(bars, /class="bar (over|under|push|plain)"/);
  assert.equal(bars.includes('bar high'), false);
  assert.equal(bars.includes('bar low'), false);
  assert.equal(bars.includes('class="split"'), false);
});

test('search lists every matching player, and an invalid opposite hides the board edge', () => {
  assert.ok(slateGame);
  const needle = 'a';
  let expected = 0;
  for (const rate of card.games) {
    if (!slate.games.some((item) => item.event_id === rate.event_id)) continue;
    for (const player of rate.players) if (player.name.toLowerCase().includes(needle)) expected += 1;
  }
  assert.ok(expected > 12);
  const hits = searchHitsHtml(slate, card, needle);
  assert.equal(hits.match(/data-projection-player=/g)?.length ?? 0, expected);
  assert.equal(hits.includes('more matches'), false);

  const simulation = simulate(game, seed, draws);
  const player = game.players.find((item) => item.name === 'Shai Gilgeous-Alexander') ?? game.players[0];
  const base: PropFormState = { market: 'pts', side: 'over', line: '15.5', style: 'american', odds: '-110', opposite: '' };
  const view = (form: PropFormState): ProjectionView => ({
    slate,
    card,
    now: new Date('2026-11-02T23:00:00Z'),
    query: '',
    eventId: game.event_id,
    athleteId: player.athlete_id,
    form,
    simulation,
    drawing: false,
    overrides: {},
  });
  const board = (html: string) => {
    const start = html.indexOf('data-projection-board');
    return html.slice(start, html.indexOf('</section>', start));
  };
  const open = renderProjections(view(base));
  const closed = renderProjections(view({ ...base, opposite: 'nope' }));
  const kept = renderProjections(view({ ...base, opposite: '-120' }));
  const openEdge = /Estimated edge<\/dt><dd[^>]*>([^<]+)<\/dd>/.exec(renderPropResults(simulation, player.athlete_id, base, player))?.[1];
  assert.ok(openEdge);
  assert.equal(board(open).includes(openEdge), true);
  assert.equal(board(kept).includes(openEdge), true);
  assert.equal(board(closed).includes(openEdge), false);
  assert.equal(board(closed).includes(' pp'), false);
  assert.match(closed, /The opposite-side price is invalid/);
  assert.equal(closed.includes('Estimated edge'), false);
  const idle = renderProjections({ ...view(base), simulation: null, drawing: false });
  const busy = renderProjections({ ...view(base), simulation: null, drawing: true });
  assert.equal(idle.includes('Simulating'), false);
  assert.match(idle, /Not simulated yet/);
  assert.match(busy, /data-projection-status>Simulating/);
  const cached = renderProjections({ ...view(base), drawing: true });
  assert.match(cached, /Means from the draws this player actually played/);
  assert.equal(cached.includes('data-projection-status>Simulating'), false);
});

function teammate(players: RatePlayer[], player: RatePlayer): RatePlayer | undefined {
  return players
    .filter((item) => item.team_id === player.team_id && item.athlete_id !== player.athlete_id)
    .sort((a, b) => b.minutes_mean - a.minutes_mean)[0];
}

test('projection_context renders verified historical hit windows, reconstructed on/off splits, and positional defense', () => {
  const star = game.players.find((item) => item.team_id === game.home_team_id && item.minutes_mean > 25) ?? game.players[0];
  const homeRoster = game.players.filter((item) => item.team_id === star.team_id && !item.replacement_level).slice(0, 6);
  const awayRoster = game.players.filter((item) => item.team_id !== star.team_id && !item.replacement_level).slice(0, 5);
  assert.ok(homeRoster.length >= 6 && awayRoster.length >= 5);
  const mateA = homeRoster.find((p) => p.athlete_id !== star.athlete_id)!;
  const bench = homeRoster.filter((p) => p.athlete_id !== star.athlete_id && p.athlete_id !== mateA.athlete_id)[3]!;

  // Build 6 completed regular-season games with reconciled play-by-play where mateA plays Q1/Q3 with star and sits Q2/Q4 while star plays.
  const events: CompletedEvent[] = Array.from({ length: 6 }, (_, idx) => {
    const pts = idx < 3 ? 28 : 18;
    const isHome = idx % 2 === 0;
    const homeId = isHome ? star.team_id : game.away_team_id;
    const awayId = isHome ? game.away_team_id : star.team_id;
    const homeStarters = homeRoster.slice(0, 5);
    const players = [
      ...homeStarters.map((p, i) => ({
        athlete_id: p.athlete_id,
        team_id: star.team_id,
        starter: true,
        minutes: p.athlete_id === star.athlete_id ? 48 : p.athlete_id === mateA.athlete_id ? 24 : 48,
        fgm: p.athlete_id === star.athlete_id ? pts / 2 : 4,
        fga: p.athlete_id === star.athlete_id ? 18 : 8,
        tpm: 0,
        tpa: 2,
        ftm: 0,
        fta: p.athlete_id === star.athlete_id ? 4 : 0,
        reb: p.athlete_id === star.athlete_id ? 9 : 5,
        ast: p.athlete_id === star.athlete_id ? 6 : 3,
        pts: p.athlete_id === star.athlete_id ? pts : 8 + i,
        stl: 1,
        blk: 1,
        tov: p.athlete_id === star.athlete_id ? 2 : 1,
        orb: 2,
        drb: p.athlete_id === star.athlete_id ? 7 : 3,
      })),
      {
        athlete_id: bench.athlete_id,
        team_id: star.team_id,
        starter: false,
        minutes: 24,
        fgm: 3,
        fga: 6,
        tpm: 0,
        tpa: 1,
        ftm: 0,
        fta: 0,
        reb: 4,
        ast: 2,
        pts: 6,
        stl: 0,
        blk: 0,
        tov: 1,
        orb: 1,
        drb: 3,
      },
      ...awayRoster.map((p) => ({
        athlete_id: p.athlete_id,
        team_id: game.away_team_id,
        starter: true,
        minutes: 48,
        fgm: 9,
        fga: 18,
        tpm: 2,
        tpa: 6,
        ftm: 2,
        fta: 2,
        reb: 8,
        ast: 5,
        pts: 22,
        stl: 1,
        blk: 1,
        tov: 2,
        orb: 2,
        drb: 6,
      })),
    ];
    const starPtsTotal = players.filter((p) => p.team_id === star.team_id).reduce((s, p) => s + p.pts, 0);
    const oppPtsTotal = 110;
    const hPts = isHome ? starPtsTotal : oppPtsTotal;
    const aPts = isHome ? oppPtsTotal : starPtsTotal;
    let seq = 1;
    let curH = 0;
    let curA = 0;
    const plays: NonNullable<CompletedEvent['play_history']>['plays'] = [];
    const addScore = (period: number, seconds: number, team: string, shooter: string, amount: 2 | 3) => {
      if (team === homeId) curH += amount;
      else curA += amount;
      plays.push({
        id: `e${idx}_${seq}`,
        sequence: seq++,
        period,
        seconds,
        type: 'Jump Shot',
        team,
        athletes: [shooter],
        home: curH,
        away: curA,
        attempt: amount,
        made: true,
        trip_attempt: null,
        trip_size: null,
        wallclock: null,
      });
    };
    const addMiss = (period: number, seconds: number, team: string, shooter: string) => {
      plays.push({
        id: `e${idx}_${seq}`,
        sequence: seq++,
        period,
        seconds,
        type: 'Missed Jump Shot',
        team,
        athletes: [shooter],
        home: curH,
        away: curA,
        attempt: 2,
        made: false,
        trip_attempt: null,
        trip_size: null,
        wallclock: null,
      });
    };
    // Period 1 & 3: mateA ON with star (each starter listed via active play so Q2/Q3/Q4 starters resolve uniquely).
    for (const period of [1, 2, 3, 4]) {
      const lineup = period % 2 === 1 ? homeStarters : homeStarters.map((p) => (p.athlete_id === mateA.athlete_id ? bench : p));
      lineup.forEach((p, k) => addMiss(period, 700 - k * 5, star.team_id, p.athlete_id));
      awayRoster.forEach((p, k) => addMiss(period, 660 - k * 5, game.away_team_id, p.athlete_id));
      // When mateA is OFF (Q2/Q4), give star extra shots so usage clearly increases off-court.
      const starShots = period % 2 === 0 ? 6 : 2;
      for (let s = 0; s < starShots; s += 1) addMiss(period, 500 - s * 10, star.team_id, star.athlete_id);
      for (let s = 0; s < 4; s += 1) addMiss(period, 400 - s * 10, star.team_id, lineup[lineup.length - 1].athlete_id);
    }
    while (curH < hPts) addScore(4, 20, homeId, homeId === star.team_id ? star.athlete_id : awayRoster[0].athlete_id, hPts - curH >= 3 && (hPts - curH) % 2 === 1 ? 3 : 2);
    while (curA < aPts) addScore(4, 15, awayId, awayId === star.team_id ? star.athlete_id : awayRoster[0].athlete_id, aPts - curA >= 3 && (aPts - curA) % 2 === 1 ? 3 : 2);
    plays.push({
      id: `e${idx}_end`,
      sequence: seq++,
      period: 4,
      seconds: 0,
      type: 'End Game',
      team: null,
      athletes: [],
      home: hPts,
      away: aPts,
      attempt: 0,
      made: false,
      trip_attempt: null,
      trip_size: null,
      wallclock: `2026-10-${20 + idx}T04:00:00Z`,
    });
    return {
      event_id: `hist-${idx}`,
      start_time: `2026-10-${20 + idx}T01:30:00Z`,
      season: 2027,
      season_type: 2,
      neutral: false,
      periods: 4,
      home_team_id: homeId,
      away_team_id: awayId,
      home_pts: hPts,
      away_pts: aPts,
      players,
      play_history: {
        version: 1,
        status: 'complete',
        reason: null,
        final_reconciled: true,
        final_observed_at: `2026-10-${20 + idx}T04:00:00Z`,
        venue: { id: null, latitude: null, longitude: null, timezone: null },
        plays,
      },
    };
  });

  const enrichedCard: RateCard = structuredClone(card);
  enrichedCard.projection_context = buildProjectionContext({
    events,
    slate,
    games: [enrichedCard.games[0]],
    activeSeason: 2027,
  });

  const starEntry = enrichedCard.projection_context.players[star.athlete_id];
  assert.ok(starEntry);
  const unpackedGames = unpackPlayerGames(starEntry.games);
  assert.equal(unpackedGames.length, 6);
  // First 3 games had 28 pts, last 3 games had 18 pts -> at line 22.5 over: L5 is 2/5 (40%), SEASON is 3/6 (50%), streak is 3 unders!
  const windows = computeHitWindows(unpackedGames, 'pts', 'over', 22.5, 2027, game.away_team_id);
  assert.equal(windows.find((w) => w.key === 'L5')?.grade.wins, 2);
  assert.equal(windows.find((w) => w.key === 'L5')?.grade.decided, 5);
  assert.equal(windows.find((w) => w.key === 'HOME')?.grade.wins, 2);
  assert.equal(windows.find((w) => w.key === 'HOME')?.grade.decided, 3);
  assert.equal(windows.find((w) => w.key === 'AWAY')?.grade.wins, 1);
  assert.equal(windows.find((w) => w.key === 'AWAY')?.grade.decided, 3);
  assert.equal(windows.find((w) => w.key === 'SEASON')?.grade.wins, 3);
  assert.equal(windows.find((w) => w.key === 'H2H')?.grade.wins, 3);
  assert.equal(windows.some((w) => w.label === 'L15' || w.label === 'L20'), false);
  assert.deepEqual(computeStreak(unpackedGames, 'pts', 22.5), { count: 3, kind: 'under' });

  const onOff = unpackOnOff(starEntry.on_off);
  assert.ok(onOff);
  assert.equal(onOff.games, 6);
  const mateSplit = onOff.splits.find((s) => s.mate_id === mateA.athlete_id);
  assert.ok(mateSplit, 'mateA should have >= 20 min on and off');
  assert.equal(mateSplit.on[0], 144);
  assert.equal(mateSplit.off[0], 144);
  assert.ok(mateSplit.off[1] > mateSplit.on[1], 'usage should increase when mateA is off the floor');

  const oppDef = enrichedCard.projection_context.teams[game.away_team_id];
  assert.ok(oppDef);
  assert.equal(oppDef.games, 6);
  assert.ok(unpackTeamAllowed(oppDef, 'pts', 'all')[0] > 0);

  const listed = enrichedCard.games[0].players.find((p) => p.athlete_id === mateA.athlete_id);
  assert.ok(listed);
  listed.injury_status = 'out';
  listed.injury_note = 'Left knee inflammation — out Friday.';
  listed.injury_reported_at = '2026-11-02T18:00:00Z';
  const simulation = simulate(enrichedCard.games[0], seed, draws);
  const form: PropFormState = { market: 'pts', side: 'over', line: '22.5', style: 'american', odds: '-110', opposite: '' };
  const html = renderProjections({
    slate,
    card: enrichedCard,
    now: new Date('2026-11-02T23:00:00Z'),
    query: '',
    eventId: game.event_id,
    athleteId: star.athlete_id,
    form,
    simulation,
    drawing: false,
    overrides: { [mateA.athlete_id]: 'out' },
  });

  assert.match(html, /Who he shares the floor with/i);
  assert.match(html, /3 unders/);
  assert.match(html, /40%/);
  assert.match(html, />Home</);
  assert.equal(html.includes('>L15<') || html.includes('>L20<'), false);
  assert.match(html, /Injury report/);
  assert.match(html, /Left knee inflammation/);
  assert.match(html, /Game log/i);
  assert.match(html, /Per minute/i);
  assert.equal(html.toLowerCase().includes('fantasy'), false);
});

test('streamCanonical and loadArchiveSummaries match in-memory equivalents without large string or archive retention', () => {
  const sampleObj = {
    z: [1, undefined, null, true, false, 'hello "world"', { b: 2, a: 1, skip: undefined }],
    a: { nested: Array.from({ length: 4000 }, (_, i) => ({ k: `k${i}`, v: i })) },
  };
  let joined = '';
  let chunks = 0;
  streamCanonical(sampleObj, (chunk) => {
    joined += chunk;
    chunks += 1;
  });
  const direct = canonical(sampleObj);
  assert.equal(joined, direct);
  assert.ok(chunks >= 2, 'large canonical output streams across multiple bounded chunks');
  assert.equal(hashCanonical(sampleObj), createHash('sha256').update(direct).digest('hex'));

  // Build isolated forecast-archive snapshots on disk and confirm streaming reader matches availabilityHistory(allArchives).
  const dir = mkdtempSync(join(tmpdir(), 'sim-archive-stream-'));
  try {
    const dayDir = join(dir, '2026-11-02');
    mkdirSync(dayDir, { recursive: true });
    const baseSlate: Slate = structuredClone(slate);
    const baseCard: RateCard = structuredClone(card);
    const targetGame = baseSlate.games[0];
    const targetRate = baseCard.games.find((g) => g.event_id === targetGame.event_id)!;
    const tipMs = Date.parse(targetGame.start_time);
    const earlyAt = new Date(tipMs - 7200_000).toISOString();
    const lateAt = new Date(tipMs - 1800_000).toISOString();

    const makeArchive = (generatedAt: string, outAthleteId?: string): ForecastArchive => {
      const s: Slate = { ...structuredClone(baseSlate), generated_at: generatedAt, games: [structuredClone(targetGame)] };
      const c: RateCard = { ...structuredClone(baseCard), generated_at: generatedAt, games: [structuredClone(targetRate)] };
      return {
        slate: s,
        card: c,
        source_lineage: {
          input_hash: c.input_hash!,
          model_hash: c.model_hash!,
          maximum_event_start: '2026-11-01T05:00:00Z',
          training_event_ids: [],
          roster: targetRate.players.map((p) => ({
            athlete_id: p.athlete_id,
            name: p.name,
            team_id: p.team_id,
            position: p.position || 'G',
          })),
          injuries: outAthleteId ? [{ athlete_id: outAthleteId, status: 'out', reported_at: earlyAt }] : [],
        },
      };
    };

    const a1 = makeArchive(earlyAt);
    const a2 = makeArchive(lateAt, targetRate.players[0].athlete_id);
    writeFileSync(join(dayDir, '01-early.json'), JSON.stringify(a1));
    writeFileSync(join(dayDir, '02-late.json'), JSON.stringify(a2));

    const completed: CompletedEvent = {
      event_id: targetGame.event_id,
      start_time: targetGame.start_time,
      season: 2027,
      season_type: 2,
      neutral: false,
      periods: 4,
      home_team_id: targetRate.home_team_id,
      away_team_id: targetRate.away_team_id,
      home_pts: 110,
      away_pts: 105,
      players: targetRate.players.slice(1, 11).map((p) => ({
        athlete_id: p.athlete_id,
        team_id: p.team_id,
        minutes: 24,
        fgm: 4,
        fga: 8,
        tpm: 1,
        tpa: 3,
        ftm: 2,
        fta: 2,
        reb: 4,
        ast: 3,
        pts: 11,
      })),
      play_history: {
        version: 1,
        status: 'complete',
        reason: null,
        final_reconciled: true,
        final_observed_at: new Date(tipMs + 9000_000).toISOString(),
        venue: { id: null, latitude: null, longitude: null, timezone: null },
        plays: [],
      },
    };
    const cutoff = new Date(tipMs + 20_000_000).toISOString();
    const expected = availabilityHistory([a1, a2], [completed], cutoff);
    const streamed = loadArchiveSummaries(dir, [completed], cutoff);
    assert.ok(expected.length > 0);
    assert.deepEqual(streamed.availability, expected);
    assert.ok(streamed.archivedPositions.size > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DOM interactions on #projections drive search, markets, history splits, on/off mates, defense tabs, and lineup overrides', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sim-proj-dom-'));
  const { window, document } = parseHTML(readFileSync('index.html', 'utf8'));
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const key of [
    'window',
    'document',
    'HTMLElement',
    'HTMLButtonElement',
    'HTMLInputElement',
    'HTMLSelectElement',
    'HTMLImageElement',
    'HTMLDetailsElement',
    'Element',
    'Event',
  ]) {
    globals[key] = (window as unknown as Record<string, unknown>)[key];
  }
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false }) });
  window.scrollTo = () => {};
  const loc = { hash: '#projections' };
  Object.defineProperty(window, 'location', { configurable: true, value: loc });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: loc });
  globals.CSS = { escape: (x: string) => x };
  const store = new Map<string, string>();
  globals.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  const timer = globalThis.setInterval;
  globals.setInterval = () => 0;

  const domCard = JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/rate-card.json', 'utf8')) as RateCard;
  const domSlate = JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/slate.json', 'utf8')) as Slate;
  const now = new Date();
  domCard.generated_at = now.toISOString();
  domSlate.generated_at = domCard.generated_at;
  const chicago = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  domCard.date = chicago;
  domSlate.date = chicago;
  domSlate.games.forEach((g) => {
    g.date = chicago;
    g.status_state = 'pre';
    g.completed = false;
    g.start_time = new Date(now.getTime() + 3600000).toISOString();
  });
  delete domCard.model_hash;

  // Attach synthetic historical games + on/off splits for game 0 so every panel renders in DOM.
  const g0 = domCard.games[0];
  const star = g0.players.find((p) => p.team_id === g0.home_team_id && p.minutes_mean > 25) ?? g0.players[0];
  const homeFive = g0.players.filter((p) => p.team_id === star.team_id && !p.replacement_level).slice(0, 6);
  const awayFive = g0.players.filter((p) => p.team_id !== star.team_id && !p.replacement_level).slice(0, 5);
  const histEvents: CompletedEvent[] = [0, 1].map((idx) => ({
    event_id: `dom-h-${idx}`,
    start_time: `2026-10-${25 + idx}T01:00:00Z`,
    season: 2027,
    season_type: 2,
    neutral: false,
    periods: 4,
    home_team_id: idx === 0 ? star.team_id : g0.away_team_id,
    away_team_id: idx === 0 ? g0.away_team_id : star.team_id,
    home_pts: 100,
    away_pts: 100,
    players: [
      ...homeFive.slice(0, 5).map((p) => ({
        athlete_id: p.athlete_id,
        team_id: star.team_id,
        starter: true,
        minutes: 48,
        fgm: 10,
        fga: 20,
        tpm: 0,
        tpa: 2,
        ftm: 0,
        fta: 2,
        reb: 9,
        ast: 6,
        pts: 20,
        stl: 1,
        blk: 1,
        tov: 2,
        orb: 2,
        drb: 7,
      })),
      ...awayFive.map((p) => ({
        athlete_id: p.athlete_id,
        team_id: g0.away_team_id,
        starter: true,
        minutes: 48,
        fgm: 10,
        fga: 20,
        tpm: 0,
        tpa: 2,
        ftm: 0,
        fta: 2,
        reb: 7,
        ast: 4,
        pts: 20,
        stl: 1,
        blk: 1,
        tov: 2,
        orb: 2,
        drb: 5,
      })),
    ],
  }));
  domCard.projection_context = buildProjectionContext({
    events: histEvents,
    slate: domSlate,
    games: [g0],
    activeSeason: 2027,
  });

  const simResult = simulate(g0, 55, 80);
  let workers = 0;
  class FakeWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    constructor() {
      workers += 1;
    }
    postMessage() {
      queueMicrotask(() => this.onmessage?.({ data: { result: simResult } }));
    }
    terminate() {}
  }
  globals.Worker = FakeWorker;
  globals.fetch = async (url: string) =>
    new Response(url.endsWith('/slate.json') ? JSON.stringify(domSlate) : url.endsWith('/rate-card.json') ? JSON.stringify(domCard) : '', {
      status: url.endsWith('/slate.json') || url.endsWith('/rate-card.json') ? 200 : 404,
    });

  const flush = () => new Promise((r) => setTimeout(r, 25));
  try {
    await build({ entryPoints: ['src/main.ts'], bundle: true, format: 'esm', outfile: join(dir, 'app.mjs'), loader: { '.css': 'empty' }, logLevel: 'silent' });
    await import(pathToFileURL(join(dir, 'app.mjs')).href);
    await flush();

    assert.equal(document.querySelector('#desk')?.getAttribute('data-mode'), 'projections');
    const searchInput = document.querySelector<HTMLInputElement>('[data-projection-search]');
    assert.ok(searchInput);
    searchInput.value = star.name.split(' ')[0]!;
    searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    const hitBtn = document.querySelector<HTMLButtonElement>(`[data-projection-hits] button[data-projection-player="${star.athlete_id}"]`);
    assert.ok(hitBtn);
    hitBtn.click();
    // On Projections, no full-screen modal clock opens — the page stays interactive while drawing inline!
    assert.equal(document.querySelector('.sim-screen'), null);
    assert.match(document.querySelector('[data-projection-status]')?.textContent ?? '', /Simulating 10,000 games/);
    await flush();

    // Search hits auto-closed, 1 worker ran, and the game rail shows 10k ready
    assert.equal(workers, 1);
    assert.equal(document.querySelector('.sim-screen'), null);
    assert.ok(document.querySelector('.ready-dot'));
    assert.equal(document.querySelector('[data-projection-hits]')?.innerHTML, '');
    assert.match(document.querySelector('.who-name')?.textContent ?? '', new RegExp(star.name.split(' ')[0]!));

    // Switch market to DD -> line locks at 0.5 and defense header shows PRA
    document.querySelector<HTMLButtonElement>('[data-projection-market="dd"]')?.click();
    assert.equal(document.querySelector<HTMLInputElement>('#projections [data-prop-line]')?.value, '0.5');
    assert.match(document.querySelector('[aria-label="Opponent defense"] h3')?.textContent ?? '', /PRA defense/);

    // Switch market to REB, nudge +0.5, toggle Away split, toggle Median supporting stats, switch defense slot
    document.querySelector<HTMLButtonElement>('[data-projection-market="reb"]')?.click();
    const beforeLine = Number(document.querySelector<HTMLInputElement>('#projections [data-prop-line]')?.value);
    document.querySelector<HTMLButtonElement>('[data-line-nudge="0.5"]')?.click();
    assert.equal(Number(document.querySelector<HTMLInputElement>('#projections [data-prop-line]')?.value), beforeLine + 0.5);

    document.querySelector<HTMLButtonElement>('[data-history-split="away"]')?.click();
    assert.equal(document.querySelector('[data-history-split="away"]')?.getAttribute('aria-pressed'), 'true');

    document.querySelector<HTMLButtonElement>('[data-support-mode="med"]')?.click();
    assert.match(document.querySelector('[data-supporting-stats]')?.textContent ?? '', /Median per game/);

    document.querySelector<HTMLButtonElement>('[data-defense-slot="C"]')?.click();
    assert.equal(document.querySelector('[data-defense-slot="C"]')?.getAttribute('aria-pressed'), 'true');

    // Edit lineups round-trip from Projections -> rule a teammate out -> Back -> Simulate 10,000 games
    document.querySelector<HTMLButtonElement>('#projections button[data-lineup]')?.click();
    assert.equal(document.querySelector('#desk')?.getAttribute('data-mode'), 'lineups');
    const outRadio = document.querySelector<HTMLInputElement>(`input[data-lineup-choice="${homeFive[1].athlete_id}"][value="out"]`);
    assert.ok(outRadio);
    outRadio.checked = true;
    outRadio.dispatchEvent(new window.Event('change', { bubbles: true }));
    document.querySelector<HTMLButtonElement>('[data-back]')?.click();
    assert.equal(document.querySelector('#desk')?.getAttribute('data-mode'), 'projections');
    const rerun = document.querySelector<HTMLButtonElement>('[data-projection-rerun]');
    assert.ok(rerun, 'changing lineups invalidates cache and shows rerun button');
    rerun.click();
    await flush();
    assert.equal(workers, 2);
  } finally {
    delete (globalThis as Record<string, unknown>).location;
    globals.setInterval = timer;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('model and board accuracy fixes: .5 hook lines, per-player board lines, cameo transfer cap, orb_share, and context healthy calibration', () => {
  // 1. Default lines snap to .5 hooks (never whole integers) so push mass does not distort prop chances.
  assert.equal(naturalHookLine('pts', [20, 20, 20]), 19.5);
  assert.equal(naturalHookLine('pts', [20, 21]), 20.5);
  assert.equal(naturalHookLine('dd', [0, 1]), 0.5);
  const sim = simulate(game, seed, draws);
  const sorted = [...game.players].sort(
    (a, b) =>
      (playedMean(playedValues(sim.playerDraws.get(b.athlete_id)!, 'pts')) ?? 0) -
      (playedMean(playedValues(sim.playerDraws.get(a.athlete_id)!, 'pts')) ?? 0),
  );
  const top = sorted[0]!;
  const auto = defaultMarketLine('pts', sim.playerDraws.get(top.athlete_id) ?? null, undefined, top.athlete_id);
  assert.ok(auto !== null && auto % 1 === 0.5, `expected .5 hook, got ${auto}`);

  // 2. Game Props Board grades each non-selected player against their own .5 line while preserving the viewer's line for the selected player.
  const rolePlayer = sorted.find((p) => {
    const m = playedMean(playedValues(sim.playerDraws.get(p.athlete_id)!, 'pts')) ?? 0;
    return m > 4 && m < 14;
  });
  assert.ok(rolePlayer);
  const boardHtml = projectionBoardHtml(
    game,
    sim,
    { market: 'pts', side: 'over', line: '29.5', style: 'american', odds: '-110', opposite: '' },
    game.event_id,
    top.athlete_id,
  );
  assert.match(boardHtml, /<th>Line<\/th>/);
  assert.match(boardHtml, /29\.5/);
  const roleSample = sim.playerDraws.get(rolePlayer.athlete_id)!;
  const roleHook = naturalHookLine('pts', playedValues(roleSample, 'pts'));
  assert.ok(roleHook < 20);
  assert.equal(boardHtml.includes(`<td>${roleHook}</td>`), gradedPropLine('pts', roleHook) !== null);
  const overHtml = projectionBoardHtml(
    game,
    sim,
    { market: 'pts', side: 'over', line: '', style: 'american', odds: '', opposite: '' },
    game.event_id,
    null,
    undefined,
    'over',
  );
  assert.match(overHtml, /data-board-sort="over" aria-pressed="true"/);
  let bestName = '';
  let bestRate = -1;
  for (const player of game.players) {
    const sample = sim.playerDraws.get(player.athlete_id);
    if (!sample || !propEligible(sample, 'pts')) continue;
    const values = playedValues(sample, 'pts');
    if (!values.length) continue;
    const hook = naturalHookLine('pts', values);
    const grade = gradeProp(sample, 'pts', 'over', hook);
    const decided = grade.wins + grade.losses;
    if (!decided) continue;
    const rate = grade.wins / decided;
    if (rate > bestRate || (rate === bestRate && (bestName === '' || player.name.localeCompare(bestName) < 0))) {
      bestRate = rate;
      bestName = player.name;
    }
  }
  const firstName = overHtml.match(/<th scope="row"><button[^>]*>([^<]+)<\/button>/);
  assert.equal(firstName?.[1], bestName);
  assert.ok(slateGame);
  const oneSlate = { ...slate, games: [slateGame] };
  const cached = new Map([[game.event_id, sim]]);
  const leans = slateLeans(oneSlate, card, 'pts', cached);
  assert.ok(leans.over.length + leans.under.length > 0);
  assert.equal(slateLeans(oneSlate, card, 'pts', new Map()).waiting, 1);
  const sidesHtml = modelSidesInner(oneSlate, card, 'pts', cached);
  assert.match(sidesHtml, /not a book line/);
  const lead = leans.over[0] ?? leans.under[0];
  assert.ok(lead);
  assert.equal(sidesHtml.includes(lead.name), true);
  assert.match(modelSidesInner(oneSlate, card, 'pts', new Map()), /warming up/);
  const cameo: PlayerSample = {
    min: Array(40).fill(4),
    pts: Array(40).fill(0),
    reb: Array(40).fill(0),
    ast: Array(40).fill(0),
    tpm: Array(40).fill(0),
  };
  const scorer: PlayerSample = {
    min: Array(40).fill(34),
    pts: Array(40).fill(22),
    reb: Array(40).fill(6),
    ast: Array(40).fill(5),
    tpm: Array(40).fill(2),
  };
  assert.equal(propEligible(cameo, 'pts'), false);
  assert.equal(propEligible(scorer, 'pts'), true);
  const spiked: PlayerSample = {
    min: Array(40).fill(18),
    pts: [...Array(32).fill(0), ...Array(8).fill(20)],
    reb: Array(40).fill(2),
    ast: Array(40).fill(1),
    tpm: Array(40).fill(0),
  };
  assert.equal(propEligible(spiked, 'pts'), false);
  const low: PlayerSample = {
    min: Array(40).fill(16),
    pts: [...Array(20).fill(2), ...Array(20).fill(3)],
    reb: Array(40).fill(1),
    ast: Array(40).fill(1),
    tpm: Array(40).fill(0),
  };
  assert.equal(naturalHookLine('pts', low.pts), 2.5);
  assert.equal(defaultMarketLine('pts', low, undefined, 'low'), null);
  assert.equal(gradedPropLine('pts', 1.5), null);
  assert.equal(gradedPropLine('pts', 2.5), null);
  const lowChance = modelChanceHtml(low, 'pts', '2.5');
  assert.match(lowChance, /not graded/);
  assert.equal(lowChance.includes('<dd>'), false);
  const cameoPlayer = { ...game.players[0]!, athlete_id: 'cameo', name: 'Cameo Zero', replacement_level: undefined };
  const scorerPlayer = { ...game.players[1]!, athlete_id: 'scorer', name: 'Star Scorer', replacement_level: undefined };
  const tinyGame = { ...game, players: [cameoPlayer, scorerPlayer] };
  const tinyCard = { ...card, games: [tinyGame] };
  const cameoDraws = new Map<string, Simulation>([
    [game.event_id, { playerDraws: new Map([['cameo', cameo], ['scorer', scorer]]) } as Simulation],
  ]);
  const filtered = slateLeans(oneSlate, tinyCard, 'pts', cameoDraws);
  assert.deepEqual(filtered.over.map((row) => row.name), ['Star Scorer']);
  assert.deepEqual(filtered.under.map((row) => row.name), []);
  assert.equal(modelSidesInner(oneSlate, tinyCard, 'pts', cameoDraws).includes('Cameo Zero'), false);

  // 3. Team-changed newcomer with 0 prior-season games and 0 current-team games gets newcomer prior and cameo cap, not phantom 20 min.
  const transfer: RatePlayer = {
    ...structuredClone(top),
    athlete_id: 'transfer-rookie',
    team_id: game.home_team_id,
    games_2026: 0,
    games_2027: 1,
    games: 1,
    shooting_games: 1,
    minutes_mean: 22,
    current_team_games: 0,
  };
  assert.equal(conditionalMinutes(transfer), CAMEO_MINUTE_CAP);
  const otherTeamAppearance: CompletedEvent = {
    event_id: 'other-1',
    start_time: '2026-10-22T01:00:00Z',
    season: 2027,
    season_type: 2,
    neutral: false,
    periods: 4,
    home_team_id: '98',
    away_team_id: '99',
    home_pts: 100,
    away_pts: 98,
    players: [
      {
        athlete_id: 'transfer-rookie',
        team_id: '98',
        minutes: 22,
        fgm: 2,
        fga: 5,
        tpm: 0,
        tpa: 1,
        ftm: 0,
        fta: 0,
        reb: 5,
        ast: 1,
        pts: 4,
        orb: 4,
        drb: 1,
        tov: 1,
      },
    ],
  };
  fitCurrentRoles([transfer], [otherTeamAppearance], 2027, [], '2026-11-10T00:00:00Z');
  assert.equal(transfer.current_team_games, 0);
  assert.ok(transfer.minutes_mean <= NEWCOMER_MINUTES_PRIOR + 1e-9);
  assert.ok(transfer.orb_share !== undefined && transfer.orb_share > 0 && transfer.orb_share < 1);

  // 4. Context-aware healthy calibration separates returning high-minute starters from coach-DNP bench warmers at the same raw logit.
  let rngState = 19;
  const rand = () => ((rngState = (Math.imul(rngState ^ (rngState >>> 15), 0x2c1b3c6d) >>> 0)) / 4294967296);
  const calRows = Array.from({ length: MIN_CALIBRATION_ROWS * 2 }, (_, i) => {
    const isStarterReturn = i % 2 === 0;
    const p = 0.25 + 0.2 * rand();
    const career_minutes = isStarterReturn ? 30 : 6;
    const coach_dnp_last5 = isStarterReturn ? 0 : 0.8;
    const inactive_last5 = isStarterReturn ? 0.8 : 0;
    const missing_minutes = isStarterReturn ? 35 : 0;
    const truth = isStarterReturn ? 0.92 : 0.12;
    return {
      tip: new Date(Date.UTC(2026, 9, 20) + Math.floor(i / 20) * 86400000).toISOString(),
      p,
      y: Number(rand() < truth),
      career_minutes,
      coach_dnp_last5,
      inactive_last5,
      missing_minutes,
    };
  });
  const cal = calibrateHealthy(calRows);
  assert.equal(cal.status, 'fitted');
  assert.ok(Array.isArray(cal.coefficients));
  const pStarter = applyHealthyCalibration(cal, 0.3, {
    career_minutes: 30,
    coach_dnp_last5: 0,
    inactive_last5: 0.8,
    missing_minutes: 35,
  });
  const pBench = applyHealthyCalibration(cal, 0.3, {
    career_minutes: 6,
    coach_dnp_last5: 0.8,
    inactive_last5: 0,
    missing_minutes: 0,
  });
  assert.ok(pStarter > pBench + 0.4, `expected starter ${pStarter} >> bench ${pBench}`);
});

test('IndexedDB simulation cache hydrates matching generations and purges stale generations automatically', async () => {
  const backing = new Map<string, unknown>();
  const makeRequest = <T>(compute: () => T) => {
    const req: { result?: T; onsuccess?: () => void; onerror?: () => void; onupgradeneeded?: () => void } = {};
    queueMicrotask(() => {
      req.result = compute();
      req.onsuccess?.();
    });
    return req;
  };
  const fakeDb = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => ({}),
    close: () => {},
    transaction: () => {
      const tx: { oncomplete?: () => void; onerror?: () => void; onabort?: () => void; objectStore: () => unknown } = {
        objectStore: () => ({
          getAll: () =>
            makeRequest(() => {
              const all = [...backing.values()];
              queueMicrotask(() => tx.oncomplete?.());
              return all;
            }),
          put: (val: { key: string }) => {
            backing.set(val.key, val);
            queueMicrotask(() => tx.oncomplete?.());
          },
          delete: (key: string) => {
            backing.delete(key);
          },
        }),
      };
      return tx;
    },
  };
  const prevIdb = (globalThis as Record<string, unknown>).indexedDB;
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: { open: () => makeRequest(() => fakeDb) },
  });
  try {
    const sim = simulate(game, seed, 60);
    await persistSimulationEntry('ev-stale:old:old:auto', 'old:old', sim);
    await persistSimulationEntry('ev-current:new:new:auto', 'new:new', sim);
    assert.equal(backing.size, 2);

    const hydrated = new Map<string, Simulation>();
    const count = await hydrateSimulationCache('new:new', hydrated);
    assert.equal(count, 1);
    assert.equal(hydrated.has('ev-current:new:new:auto'), true);
    assert.equal(hydrated.has('ev-stale:old:old:auto'), false);
    assert.equal(backing.has('ev-stale:old:old:auto'), false, 'stale generation purged from browser storage');
  } finally {
    if (prevIdb === undefined) delete (globalThis as Record<string, unknown>).indexedDB;
    else Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: prevIdb });
  }
});
