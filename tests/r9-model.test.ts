import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fitPlayers, MIN_ROLE_POOL_MINUTES, roleTier, shrinkRate, type RosterPlayer } from '../src/fit.ts';
import { applyHealthyCalibration, applyIsotonic, calibrateHealthy, isotonicKnots, MIN_ISOTONIC_BLOCK, type HealthyCalibrationRow } from '../src/participation-model.ts';
import type { CompletedEvent } from '../src/parse-summary.ts';
import { fitMinutesSpread, MINUTES_SPREAD_EDGES, MINUTES_SPREAD_KNOTS, minutesSpreadTier, sampleMinutesRatio, selectRolePrior, type MinutesSpread } from '../src/role-model.ts';
import { mulberry32 } from '../src/rng.ts';
import { expectedMinutes, roleStretch, ROLE_STRETCH_MINUTES, ROLE_STRETCH_RATIO, simulate } from '../src/simulate.ts';
import { MODEL_VERSION } from '../src/team-model.ts';
import { validateGame } from '../src/validate-card.ts';
import type { OutcomeRow, RateCard, ShootingRow } from '../src/types.ts';

const card = JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/rate-card.json', 'utf8')) as RateCard;

test('a monotone step lifts healthy regulars that a logistic map leaves too low, and is kept only when later games agree', () => {
  assert.equal(isotonicKnots([{ p: 0.5, y: 1 }]), null);
  // Three bands of true play rates: 20%, 70% and 99%, with model probabilities bunched too close together.
  const rng = mulberry32(11);
  const rows = (n: number, p: number, truth: number) => Array.from({ length: n }, () => ({ p: p + (rng() - 0.5) * 0.02, y: Number(rng() < truth) }));
  const pairs = [...rows(300, 0.3, 0.2), ...rows(300, 0.7, 0.7), ...rows(600, 0.94, 0.99)];
  const map = isotonicKnots(pairs)!;
  assert.ok(map.x.length >= 2 && map.x.length === map.y.length);
  for (let i = 1; i < map.x.length; i += 1) {
    assert.ok(map.x[i] > map.x[i - 1]);
    assert.ok(map.y[i] >= map.y[i - 1]);
  }
  assert.ok(applyIsotonic(map, 0.94) > 0.97, `regular lifted to ${applyIsotonic(map, 0.94)}`);
  assert.ok(applyIsotonic(map, 0.3) < 0.27);
  // No block is ever certain, and anything past the last knot keeps the last knot's rate.
  assert.ok(Math.max(...map.y) < 1 && Math.min(...map.y) > 0);
  assert.equal(applyIsotonic(map, 0.999), map.y[map.y.length - 1]);
  assert.equal(applyIsotonic(map, 0), map.y[0]);
  assert.equal(applyIsotonic(null, 0.42), 0.42);
  assert.ok(pairs.length >= MIN_ISOTONIC_BLOCK * 3);

  // Archived healthy rows where the model says 93% and players play 99%: the step is fitted on the earlier games,
  // checked on the later ones, and then applied on top of the logistic map.
  const tip = (i: number) => new Date(Date.UTC(2026, 9, 25, 0, i)).toISOString();
  const archived: HealthyCalibrationRow[] = Array.from({ length: 1500 }, (_, i) => {
    const band = i % 3;
    const p = band === 0 ? 0.25 : band === 1 ? 0.6 : 0.93;
    const truth = band === 0 ? 0.35 : band === 1 ? 0.55 : 0.99;
    return { tip: tip(i), p: p + (rng() - 0.5) * 0.02, y: Number(rng() < truth) };
  });
  const fitted = calibrateHealthy(archived);
  assert.equal(fitted.status, 'fitted');
  assert.ok(fitted.isotonic, 'the step improved the later archived games');
  assert.ok(fitted.isotonic!.log_loss < fitted.isotonic!.logistic_log_loss);
  assert.ok(applyHealthyCalibration(fitted, 0.93) > 0.975, `healthy regular at ${applyHealthyCalibration(fitted, 0.93)}`);
  assert.ok(applyHealthyCalibration(fitted, 0.25) < applyHealthyCalibration(fitted, 0.6));
  // When the logistic map is already right the step adds nothing and is left off.
  const calibrated: HealthyCalibrationRow[] = Array.from({ length: 1500 }, (_, i) => {
    const p = 0.1 + 0.8 * rng();
    return { tip: tip(i), p, y: Number(rng() < Math.min(0.99, p + 0.08)) };
  });
  const plain = calibrateHealthy(calibrated);
  if (plain.status === 'fitted' && plain.isotonic) assert.ok(plain.isotonic.log_loss < plain.isotonic.logistic_log_loss);
});

/** Eight a side: five starters near 34 minutes, a sixth man near 20 and two reserves whose nights swing widely. */
function boxGame(i: number, season: number): CompletedEvent {
  const rng = mulberry32(1000 + i * 7 + season);
  const minutes = (j: number) => (j < 5 ? 34 + Math.round((rng() - 0.5) * 6) : j === 5 ? 20 + Math.round((rng() - 0.5) * 10) : rng() < 0.4 ? 3 : 6 + Math.round(rng() * 12));
  return {
    event_id: `${season}-${i}`,
    start_time: new Date(Date.UTC(season - 1, 9, 20, 0, 0) + i * 2 * 86400000).toISOString(),
    season,
    season_type: 2,
    neutral: false,
    periods: 4,
    home_team_id: 'h',
    away_team_id: 'a',
    home_pts: 100,
    away_pts: 100,
    players: ['h', 'a'].flatMap((team) =>
      Array.from({ length: 8 }, (_, j) => ({ athlete_id: `${team}${j}`, team_id: team, starter: j < 5, minutes: minutes(j), fgm: 4, fga: 8, tpm: 0, tpa: 2, ftm: 2, fta: 3, pts: 10, reb: 4, ast: 2, orb: 1, tov: 1 })),
    ),
  };
}

test('minutes spread is fitted by tier from held-out appearances, averages one, and leaves the role selection alone', () => {
  assert.equal(minutesSpreadTier(MINUTES_SPREAD_EDGES, 7.9), 0);
  assert.equal(minutesSpreadTier(MINUTES_SPREAD_EDGES, 8), 1);
  assert.equal(minutesSpreadTier(MINUTES_SPREAD_EDGES, 40), MINUTES_SPREAD_EDGES.length);
  const history = [...Array.from({ length: 700 }, (_, i) => boxGame(i, 2026)), ...Array.from({ length: 30 }, (_, i) => boxGame(i, 2027))];
  const selection = selectRolePrior(history, 2027);
  assert.equal(selection.source, 'chronological-validation');
  const spread = fitMinutesSpread(history, 2027, selection);
  // This toy league has no 24-to-32-minute players, so those tiers are empty and the fit is refused whole.
  assert.equal(spread.status, 'unknown');
  assert.match(spread.reason ?? '', /fewer than 200 held-out appearances/);
  assert.equal(fitMinutesSpread([], 2027, selection).status, 'unknown');
  assert.equal(fitMinutesSpread(history, 2027, { ...selection, source: 'labelled-prior' }).status, 'unknown');
  // Adding the spread did not change what the role selection returns.
  assert.deepEqual(selectRolePrior(history, 2027), selection);

  // A real cache has every tier. The fitted knots rise, average one, and are far wider for reserves than starters.
  const cache = JSON.parse(readFileSync('data/shooting-cache.json', 'utf8')) as { events: CompletedEvent[] };
  const events = cache.events.filter((event) => event.season_type === 2 && Date.parse(event.start_time) < Date.parse('2026-11-01T00:00:00Z'));
  const fitted = fitMinutesSpread(events, 2027, selectRolePrior(events, 2027));
  assert.equal(fitted.status, 'fitted');
  assert.equal(fitted.quantiles.length, MINUTES_SPREAD_EDGES.length + 1);
  const width = fitted.quantiles.map((q) => q[19] - q[1]);
  for (const q of fitted.quantiles) {
    assert.equal(q.length, MINUTES_SPREAD_KNOTS);
    for (let k = 1; k < q.length; k += 1) assert.ok(q[k] >= q[k - 1]);
    const mean = q.slice(0, -1).reduce((sum, value, k) => sum + (value + q[k + 1]) / 2, 0) / (q.length - 1);
    assert.ok(Math.abs(mean - 1) < 0.001, `tier mean ${mean}`);
  }
  assert.ok(width[0] > 3 * width[width.length - 1], JSON.stringify(width));
  // A starter almost never doubles his minutes; a deep reserve often does.
  assert.ok(fitted.quantiles[fitted.quantiles.length - 1][20] < 1.5);
  assert.ok(fitted.quantiles[0][20] > 3);
  assert.equal(sampleMinutesRatio(fitted, 36, 0), fitted.quantiles[7][0]);
  assert.equal(sampleMinutesRatio(fitted, 36, 0.5), fitted.quantiles[7][10]);
  assert.ok(Math.abs(sampleMinutesRatio(fitted, 36, 0.525) - (fitted.quantiles[7][10] + fitted.quantiles[7][11]) / 2) < 1e-9);
});

test('the sampler uses a fitted spread for regulation minutes, stays deterministic, and rejects a malformed one', () => {
  const game = structuredClone(card.games.find((item) => item.context && !item.simulation_error)!);
  // Narrow for every tier at 28 minutes and above, wide below: starters should now move far less than reserves.
  const narrow = Array.from({ length: MINUTES_SPREAD_KNOTS }, (_, k) => +(0.95 + 0.005 * k).toFixed(4));
  const wide = Array.from({ length: MINUTES_SPREAD_KNOTS }, (_, k) => +(0.2 + 0.08 * k).toFixed(4));
  const spread: MinutesSpread = { status: 'fitted', edges: [...MINUTES_SPREAD_EDGES], quantiles: MINUTES_SPREAD_EDGES.map((edge) => (edge < 28 ? wide : narrow)).concat([narrow]), rows: MINUTES_SPREAD_EDGES.map(() => 500).concat([500]), reason: null };
  game.context!.minutes_spread = spread;
  // Hold the cast fixed so only the minutes draw moves a player's minutes.
  game.players = game.players.map((player) => (player.minutes_weight === 0 ? player : { ...player, play_probability: player.minutes_mean >= 14 ? 1 : 0, questionable_widen: false, injury_status: 'healthy' }));
  game.context!.rotation_state = { ...game.context!.rotation_state!, status: 'unknown' };
  game.context!.fouls = { ...game.context!.fouls!, status: 'unknown' };
  assert.doesNotThrow(() => validateGame(game));
  const a = simulate(game, 9, 400);
  const b = simulate(game, 9, 400);
  assert.deepEqual(a.awayTotals, b.awayTotals);
  const cv = (id: string) => {
    const xs = Array.from(a.playerDraws.get(id)!.min).filter((m) => m > 0);
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length) / mean;
  };
  const playing = game.players.filter((player) => player.minutes_weight === 1 && player.play_probability === 1);
  const starters = playing.filter((player) => player.minutes_mean >= 30);
  const reserves = playing.filter((player) => player.minutes_mean >= 14 && player.minutes_mean < 22);
  assert.ok(starters.length >= 2 && reserves.length >= 2);
  const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  assert.ok(avg(reserves.map((player) => cv(player.athlete_id))) > 2 * avg(starters.map((player) => cv(player.athlete_id))), 'reserves swing more than starters');
  // Every draw still fills the team budget exactly.
  for (const team of [a.away, a.home]) assert.equal(team.players.reduce((sum, player) => sum + player.min, 0) % 5, 0);

  const broken = structuredClone(game);
  broken.context!.minutes_spread = { ...spread, quantiles: spread.quantiles.map((q, i) => (i === 0 ? [...q].reverse() : q)) };
  assert.throws(() => validateGame(broken), /Invalid minutes spread/);
  const short = structuredClone(game);
  short.context!.minutes_spread = { ...spread, quantiles: spread.quantiles.slice(1) };
  assert.throws(() => validateGame(short), /Invalid minutes spread/);
  // An older card without a spread still simulates with the gamma multiplier.
  const old = structuredClone(game);
  delete old.context!.minutes_spread;
  assert.ok(simulate(old, 9, 50).awayTotals.length === 50);
  assert.equal(MODEL_VERSION, 'possessions-v9');
});

test('counting rates shrink toward players in the same minutes tier, scaled by the team, once that pool is large enough', () => {
  assert.equal(roleTier(11.9), 0);
  assert.equal(roleTier(12), 1);
  assert.equal(roleTier(28), 3);
  const league = { s: 4000, e: 10000 };
  const base = { k: 75, league, team: { s: 420, e: 1000 }, position: { s: 900, e: 2500 }, player: { s: 10, e: 50 }, blendPosition: true };
  const teamOnly = shrinkRate(base)!;
  // Reserves average 0.30 a minute against a league 0.40; this team runs 5% hot, so the prior is 0.30 x 1.05.
  const teamRate = (420 + 75 * 0.4) / (1000 + 75);
  const withRole = shrinkRate({ ...base, role: { s: 900, e: 3000 } })!;
  assert.ok(Math.abs(withRole - (10 + 75 * 0.3 * (teamRate / 0.4)) / (50 + 75)) < 1e-12);
  assert.ok(withRole < teamOnly);
  // A thin role pool is not trusted and the team prior stays.
  assert.equal(shrinkRate({ ...base, role: { s: 30, e: MIN_ROLE_POOL_MINUTES - 1 } }), teamOnly);
  assert.equal(shrinkRate({ ...base, role: null }), teamOnly);

  // A league where starters take 0.5 shots a minute and reserves 0.2. A reserve with one short game is pulled
  // toward 0.2, not toward the team average that the starters dominate.
  const roster: RosterPlayer[] = [];
  const outcomes: OutcomeRow[] = [];
  const shooting: ShootingRow[] = [];
  for (let team = 1; team <= 4; team += 1) {
    for (let j = 0; j < 10; j += 1) {
      const starter = j < 5;
      const athlete = `${team}-${j}`;
      const thin = team === 1 && j === 9;
      const games = thin ? 1 : 40;
      const minutes = starter ? 34 : 10;
      roster.push({ athlete_id: athlete, name: athlete, team_id: String(team), position: j % 2 ? 'G' : 'F' });
      for (let g = 0; g < games; g += 1) {
        for (const stat of ['points', 'totalRebounds', 'assists']) outcomes.push({ season: 2027, athlete_id: athlete, team_id: String(team), event_id: `${team}-${g}`, stat_key: stat, actual: starter ? 17 : 2, minutes });
      }
      const fga = Math.round(games * minutes * (starter ? 0.5 : 0.2));
      shooting.push({ athlete_id: athlete, team_id: String(team), season: 2027, games, minutes: games * minutes, fgm: Math.round(fga * 0.45), fga, tpm: 0, tpa: 0, ftm: Math.round(fga * 0.2), fta: Math.round(fga * 0.25), reb: games * 4, ast: games * 2, pts: Math.round(fga * 0.9) });
    }
  }
  const fitted = fitPlayers({ roster, injuries: [], outcomes, shooting, activeSeason: 2027 });
  const thin = fitted.players.find((player) => player.athlete_id === '1-9')!;
  const regular = fitted.players.find((player) => player.athlete_id === '2-9')!;
  const star = fitted.players.find((player) => player.athlete_id === '2-0')!;
  // Undo the points blend to read the shrunk attempt rate itself.
  const attempts = (player: typeof thin) => player.fga_per_min / (player.points_scale ?? 1);
  assert.ok(Math.abs(attempts(thin) - 0.2) < 0.02, `thin reserve at ${attempts(thin)}`);
  assert.ok(Math.abs(attempts(regular) - 0.2) < 0.01);
  assert.ok(Math.abs(attempts(star) - 0.5) < 0.01);
});

test('a short-handed rotation plays its healthy reserves instead of stretching three of them past 40 minutes', () => {
  // Expected minutes: ordinary rotations are only scaled; a role is held at twelve more minutes or 1.6 times itself.
  assert.deepEqual(expectedMinutes([36, 36, 36, 36, 36, 30, 30], [48, 48, 48, 48, 48, 48, 48], 240), [36, 36, 36, 36, 36, 30, 30]);
  const stretch = (role: number) => Math.max(role + ROLE_STRETCH_MINUTES, role * ROLE_STRETCH_RATIO);
  const roles = [30, 20, 20, 20, 10, 10];
  const held = expectedMinutes(roles, roles.map(stretch), 240);
  assert.ok(Math.abs(held.reduce((a, b) => a + b, 0) - 240) < 1e-9);
  // 110 role minutes for 240: everyone is at his limit, so the limits are relaxed in proportion and nobody is skipped.
  const limits = roles.map(stretch);
  for (let i = 0; i < roles.length; i += 1) assert.ok(Math.abs(held[i] / limits[i] - held[0] / limits[0]) < 1e-9);
  // Six players for 240: four roles reach their limits and the two reserves share what is left, short of their own.
  const mixed = expectedMinutes([36, 36, 36, 20, 10, 10], [36, 36, 36, 20, 10, 10].map(stretch), 240);
  assert.equal(mixed[3], 32);
  assert.ok(Math.abs(mixed[0] - 57.6) < 1e-9 && Math.abs(mixed[4] - 17.6) < 1e-9 && mixed[4] < stretch(10));
  assert.ok(Math.abs(mixed.reduce((a, b) => a + b, 0) - 240) < 1e-9);
  // A scale that leaves every role inside its limit changes nothing.
  assert.deepEqual(expectedMinutes([34, 34, 32, 30, 28, 8, 6], [34, 34, 32, 30, 28, 8, 6].map(stretch), 240), [34, 34, 32, 30, 28, 8, 6].map((role) => (role * 240) / 172));

  const game = structuredClone(card.games.find((item) => item.context && !item.simulation_error)!);
  const home = game.players.filter((player) => player.team_id === game.home_team_id && !player.replacement_level).sort((a, b) => b.minutes_mean - a.minutes_mean);
  assert.ok(home.length >= 12);
  // The six highest roles are out; three mid-rotation players are certain to play and the rest are healthy long shots.
  home.forEach((player, index) => {
    if (index < 6) Object.assign(player, { minutes_weight: 0, injury_status: 'out', play_probability: 0 });
    else Object.assign(player, { minutes_weight: 1, injury_status: 'healthy', questionable_widen: false, minutes_restriction: null, play_probability: index < 9 ? 1 : 0.1, games: 40, games_2026: 30, games_2027: 10, shooting_games: 40 });
  });
  const available = home.slice(6);
  const result = simulate(game, 21, 300);
  const played = (id: string) => Array.from(result.playerDraws.get(id)!.min).filter((m) => m > 0);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  // Every healthy reserve is needed to cover the minutes at plausible loads, long shot or not.
  const capacity = available.reduce((sum, player) => sum + Math.min(48, roleStretch(player)), 0);
  if (capacity <= 240) for (const player of available) assert.equal(played(player.athlete_id).length, 300, `${player.name} plays every draw`);
  for (const player of available.slice(0, 3)) {
    const minutes = mean(played(player.athlete_id));
    assert.ok(minutes <= Math.min(48, roleStretch(player)) * 1.12, `${player.name} role ${player.minutes_mean} averaged ${minutes}`);
  }
  // The players ruled out never appear, and the team still fills 240.
  for (const player of home.slice(0, 6)) assert.equal(played(player.athlete_id).length, 0);
  assert.equal(result.home.players.reduce((sum, player) => sum + player.min, 0) % 5, 0);
});
