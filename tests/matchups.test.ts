import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { parseHTML } from 'linkedom';
import { DEFENSE_STAT_KEYS } from '../src/projection-context.ts';
import type { CompletedEvent } from '../src/parse-summary.ts';
import type { DefenseStatKey, TeamDefenseEntry } from '../src/projection-context.ts';
import type { RateCard, RatePlayer, Slate, SlateGame, TeamSide } from '../src/types.ts';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export {};', shortCircuit: true };
    return nextLoad(url, context);
  },
});

const {
  CLOSE_LOSS_SHARE,
  CLOSE_MARGIN_MAX,
  COLLAPSE_MEAN_MARGIN,
  COMPARABLE_LIST_MAX,
  COMPARABLE_RANK_DISTANCE,
  DEFENSE_EDGE_N,
  MATCHUP_MIN_MINUTES,
  MATCHUP_MIN_PLAY,
  MIN_DEFENSE_GAMES,
  MIN_EXPLAINED_LOSSES,
  MIN_FORM_GAMES,
  MIN_STRENGTH_GAMES,
  RECENT_WINDOW,
  STRONG_RANK_MAX,
  VERDICT,
  boardControlsHtml,
  buildMatchups,
  parseMatchupsFile,
  renderMatchups,
  serializeMatchups,
} = await import('../src/matchups.ts');

const TIP = '2026-11-20T00:00:00.000Z';

function at(minute: number): string {
  return new Date(Date.parse('2026-11-01T00:00:00.000Z') + minute * 60_000).toISOString();
}

function event(id: string, start: string, away: string, home: string, awayPts: number, homePts: number, season = 2027, seasonType = 2): CompletedEvent {
  return {
    event_id: id,
    start_time: start,
    season,
    season_type: seasonType,
    neutral: false,
    periods: 4,
    home_team_id: home,
    away_team_id: away,
    home_pts: homePts,
    away_pts: awayPts,
    players: [],
  };
}

function side(id: string): TeamSide {
  return { team_id: id, name: `Team ${id}`, abbreviation: id };
}

function slateGame(id: string, away: string, home: string, tip = TIP): SlateGame {
  return {
    event_id: id,
    date: '2026-11-19',
    start_time: tip,
    season: 2027,
    season_type: 'regular',
    status_state: 'pre',
    completed: false,
    away: side(away),
    home: side(home),
    spread_caption: null,
  };
}

function bundle(games: SlateGame[], events: CompletedEvent[]): { slate: Slate; card: RateCard } {
  const slate: Slate = { schema_version: 1, generated_at: '2026-11-20T23:00:39Z', date: '2026-11-20', timezone: 'America/Chicago', games };
  const card = {
    schema_version: 1,
    generated_at: slate.generated_at,
    date: slate.date,
    iterations: 10000,
    model_version: 'possessions-v9',
    input_hash: 'input',
    model_hash: 'model',
    columns: [],
    games: [],
    projection_context: {
      active_season: 2027,
      season_label: '2026-27',
      defense_season_label: '2026-27',
      teams: {},
      players: {},
    },
  } as RateCard;
  return { slate, card: card, events } as { slate: Slate; card: RateCard } & { events: CompletedEvent[] };
}

function reportFor(games: SlateGame[], events: CompletedEvent[]) {
  const packed = bundle(games, events);
  return { ...packed, file: buildMatchups(packed.slate, packed.card, events) };
}

function keysOf(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) keysOf(item, found);
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value)) {
    found.add(key);
    keysOf(child, found);
  }
  return found;
}

function article(html: string, title: string): string {
  const found = html.split('<article').find((part) => part.includes(`<h2>${title}</h2>`));
  assert.ok(found, title);
  return found;
}

function section(html: string, heading: string): string {
  const start = html.indexOf(`<h3>${heading}</h3>`);
  assert.ok(start >= 0, heading);
  const rest = html.slice(start);
  const next = rest.indexOf('<h3>', 4);
  return next === -1 ? rest : rest.slice(0, next);
}

test('the matchup bounds stay the named constants', () => {
  assert.equal(MIN_STRENGTH_GAMES, 8);
  assert.equal(RECENT_WINDOW, 10);
  assert.equal(MIN_FORM_GAMES, 5);
  assert.equal(CLOSE_MARGIN_MAX, 5);
  assert.equal(STRONG_RANK_MAX, 10);
  assert.equal(CLOSE_LOSS_SHARE, 0.5);
  assert.equal(MIN_EXPLAINED_LOSSES, 2);
  assert.equal(COLLAPSE_MEAN_MARGIN, -8);
  assert.equal(COMPARABLE_RANK_DISTANCE, 5);
  assert.equal(COMPARABLE_LIST_MAX, 8);
  assert.equal(DEFENSE_EDGE_N, 5);
  assert.equal(MIN_DEFENSE_GAMES, 8);
  assert.equal(MATCHUP_MIN_PLAY, 0.5);
  assert.equal(MATCHUP_MIN_MINUTES, 20);
  assert.equal(VERDICT, 'NO BET');
});

test('close losses to a strong team outrank a steep margin, and one loss cannot', () => {
  const events: CompletedEvent[] = [];
  let minute = 0;
  for (let team = 1; team <= 10; team += 1) {
    for (let game = 0; game < 8; game += 1) {
      minute += 1;
      events.push(event(`base-${team}-${game}`, at(minute), String(team), String(team + 20), 120, 100));
    }
  }
  const add = (id: string, away: string, home: string, awayPts: number, homePts: number) => {
    minute += 1;
    events.push(event(id, at(minute), away, home, awayPts, homePts));
  };
  add('close-1', '50', '5', 96, 100);
  add('close-2', '50', '6', 97, 100);
  add('close-3', '50', '25', 80, 105);
  add('close-4', '50', '26', 80, 105);
  add('close-5', '50', '27', 101, 100);
  add('drop-1', '60', '28', 70, 100);
  add('drop-2', '60', '29', 70, 100);
  add('drop-3', '60', '30', 70, 100);
  add('drop-4', '60', '24', 70, 95);
  add('drop-5', '60', '23', 90, 88);
  add('one-close', '70', '4', 96, 100);
  add('one-win-1', '70', '21', 110, 100);
  add('one-win-2', '70', '22', 110, 100);
  add('one-win-3', '70', '23', 110, 100);
  add('one-win-4', '70', '24', 110, 100);
  add('one-blow', '71', '21', 70, 115);
  add('one-blow-w1', '71', '22', 101, 100);
  add('one-blow-w2', '71', '22', 101, 100);
  add('one-blow-w3', '71', '22', 101, 100);
  add('one-blow-w4', '71', '22', 101, 100);
  for (let game = 0; game < 4; game += 1) add(`short-${game}`, '72', '21', 70, 100);
  for (let game = 0; game < 5; game += 1) add(`pad-${game}`, '40', '41', 140, 100);
  add('weak-close-1', '73', '40', 96, 100);
  add('weak-close-2', '73', '40', 97, 100);
  add('weak-blow-1', '73', '21', 80, 100);
  add('weak-blow-2', '73', '21', 80, 100);
  add('weak-blow-3', '73', '21', 80, 100);

  const games = ['50', '60', '70', '71', '72', '73', '80'].map((id) => slateGame(`slate-${id}`, id, '99'));
  const { file, slate, card } = reportFor(games, events);
  const team = (id: string) => file.games.find((game) => game.event_id === `slate-${id}`)!.away;
  const close = team('50');
  const drop = team('60');
  const one = team('70');
  const blow = team('71');
  const short = team('72');
  const weak = team('73');
  const empty = team('80');

  assert.equal(close.form.tag, 'close-losses-to-strong');
  assert.equal(close.form.losses, 4);
  assert.equal(close.form.close_losses_to_strong, 2);
  assert.ok(close.form.mean_margin != null && close.form.mean_margin <= COLLAPSE_MEAN_MARGIN);
  for (const row of close.rows.filter((item) => item.event_id === 'close-1' || item.event_id === 'close-2')) {
    assert.ok(row.opponent_rank != null && row.opponent_rank <= STRONG_RANK_MAX);
  }

  assert.equal(drop.form.tag, 'margin-collapse');
  assert.equal(drop.form.close_losses_to_strong, 0);
  assert.ok(drop.form.mean_margin != null && drop.form.mean_margin <= COLLAPSE_MEAN_MARGIN);

  assert.equal(one.form.tag, 'no-tag');
  assert.equal(one.form.losses, 1);
  assert.equal(one.form.close_losses_to_strong, 1);
  assert.notEqual(one.form.tag, 'close-losses-to-strong');

  assert.equal(blow.form.losses, 1);
  assert.equal(blow.form.tag, 'margin-collapse');
  assert.notEqual(blow.form.tag, 'close-losses-to-strong');

  assert.equal(short.form.games, 4);
  assert.equal(short.form.tag, 'short-sample');
  assert.notEqual(short.form.tag, 'margin-collapse');

  assert.equal(weak.form.tag, 'margin-collapse');
  assert.equal(weak.form.close_losses_to_strong, 0);
  const weakRow = weak.rows.find((row) => row.opponent_id === '40');
  assert.ok(weakRow);
  assert.equal(weakRow.opponent_rank, null);
  assert.equal(weakRow.opponent_games, 7);

  assert.equal(empty.games_before_tip, 0);
  assert.equal(empty.rank, null);
  assert.equal(empty.rows.length, 0);

  const text = JSON.stringify(file);
  assert.equal(text.toLowerCase().includes('hot'), false);
  const names = keysOf(file);
  for (const key of ['price', 'odds', 'spread', 'moneyline', 'blowout', 'winner', 'win_chance']) assert.equal(names.has(key), false);
  assert.equal(file.calibrated, false);
  assert.equal(file.verdict, 'NO BET');
  for (const game of file.games) assert.equal(game.verdict, 'NO BET');

  const html = renderMatchups(file, slate, card);
  assert.equal(html.toLowerCase().includes('hot'), false);
  assert.match(article(html, '50 at 99'), /data-form="close-losses-to-strong"/);
  assert.match(article(html, '60 at 99'), /data-form="margin-collapse"/);
  assert.match(article(html, '80 at 99'), /No completed regular-season games before tip\./);
  assert.equal(parseMatchupsFile(serializeMatchups(file))?.games.find((game) => game.away.team_id === '50')?.away.form.tag, 'close-losses-to-strong');
  const priced = JSON.parse(serializeMatchups(file)) as { games: { price?: number }[] };
  priced.games[0]!.price = -110;
  assert.equal(parseMatchupsFile(JSON.stringify(priced)), null);
});

test('eight games are ranked, seven are not, and a tied mean follows the team id', () => {
  const events: CompletedEvent[] = [];
  let minute = 0;
  const add = (id: string, away: string, home: string, awayPts: number, homePts: number) => {
    minute += 1;
    events.push(event(id, at(minute), away, home, awayPts, homePts));
  };
  for (let game = 0; game < 8; game += 1) add(`a-${game}`, '1', '31', 110, 100);
  for (let game = 0; game < 8; game += 1) add(`b-${game}`, '2', '32', 110, 100);
  for (let game = 0; game < 6; game += 1) add(`c-${game}`, '3', '33', 140, 100);
  for (let game = 0; game < 7; game += 1) add(`d-${game}`, '4', '34', 101, 100);
  add('c-vs-d', '3', '4', 120, 100);
  const { file } = reportFor([slateGame('tied', '1', '2'), slateGame('short', '3', '4')], events);
  const tied = file.games[0]!;
  const sample = file.games[1]!;
  assert.equal(tied.away.rank, 1);
  assert.equal(tied.home.rank, 2);
  assert.equal(tied.away.games_before_tip, 8);
  assert.equal(tied.home.games_before_tip, 8);
  assert.equal(tied.away.mean_margin, tied.home.mean_margin);
  assert.equal(sample.away.rank, null);
  assert.equal(sample.away.games_before_tip, 7);
  assert.ok(sample.home.rank != null);
  const unranked = sample.home.rows.find((row) => row.opponent_id === '3');
  assert.ok(unranked);
  assert.equal(unranked.opponent_rank, null);
  assert.equal(unranked.opponent_games, 7);
  assert.match(unranked.why, /last 10 before tip/);
});

test('games at the tip, after it, in another season, or the game itself stay out', () => {
  const tip = '2026-11-20T12:00:00.000Z';
  const before = new Date(Date.parse(tip) - 1).toISOString();
  const after = new Date(Date.parse(tip) + 60 * 60 * 1000).toISOString();
  const events = [
    event('before', before, '8', '7', 90, 100),
    event('exact', tip, '8', '7', 70, 120),
    event('after', after, '8', '7', 60, 130),
    event('cut', new Date(Date.parse(tip) - 60_000).toISOString(), '8', '7', 50, 140),
    event('playoff', before, '8', '7', 80, 110, 2027, 3),
    event('prior-season', before, '8', '7', 80, 110, 2026, 2),
  ];
  const { file } = reportFor([slateGame('cut', '8', '7', tip)], events);
  const away = file.games[0]!.away;
  assert.equal(away.games_before_tip, 1);
  assert.equal(away.rows.length, 1);
  assert.equal(away.rows[0]!.event_id, 'before');
  assert.equal(away.rows[0]!.team_score, 90);
  assert.equal(away.rows[0]!.opponent_score, 100);
  assert.equal(away.rows[0]!.margin, -10);
  assert.equal(away.rank, null);
});

test('the table is the last ten plus up to eight comparable games, newest first', () => {
  const events: CompletedEvent[] = [];
  let minute = 0;
  const add = (id: string, away: string, home: string, awayPts: number, homePts: number) => {
    minute += 1;
    events.push(event(id, at(minute), away, home, awayPts, homePts));
  };
  for (let game = 0; game < 8; game += 1) add(`t1-${game}`, '1', '101', 130, 100);
  for (let game = 0; game < 40; game += 1) add(`t2-${game}`, '2', '102', 120, 100);
  for (let team = 3; team <= 7; team += 1) {
    for (let game = 0; game < 8; game += 1) add(`t${team}-${game}`, String(team), String(200 + team), 100 + (18 - team * 2), 100);
  }
  for (let game = 0; game < 40; game += 1) add(`t8-${game}`, '8', '108', 101, 100);
  add('old-1', '90', '2', 99, 100);
  add('old-2', '90', '2', 99, 100);
  for (let game = 0; game < 9; game += 1) add(`recent-${game}`, '90', '8', 101, 100);
  add('both', '90', '2', 99, 100);
  const { file } = reportFor([slateGame('tonight', '90', '1')], events);
  const rows = file.games[0]!.away.rows;
  assert.equal(rows.length, 12);
  assert.equal(rows[0]!.event_id, 'both');
  assert.equal(rows[0]!.why, 'last 10 before tip; comparable, rank distance 1');
  assert.equal(rows[0]!.opponent_rank, 2);
  const older = rows.filter((row) => row.event_id === 'old-1' || row.event_id === 'old-2');
  assert.equal(older.length, 2);
  for (const row of older) assert.equal(row.why, 'comparable, rank distance 1');
  const recent = rows.filter((row) => row.event_id.startsWith('recent-'));
  assert.equal(recent.length, 9);
  for (const row of recent) assert.equal(row.why, 'last 10 before tip');
  const times = rows.map((row) => row.event_id);
  assert.deepEqual(times.slice(0, 2), ['both', 'recent-8']);
  assert.deepEqual(times.slice(-2), ['old-2', 'old-1']);
});

function player(patch: Partial<RatePlayer> & Pick<RatePlayer, 'athlete_id' | 'name' | 'team_id' | 'injury_status'>): RatePlayer {
  return {
    position: 'PG',
    position_group: 'Guard',
    minutes_weight: 1,
    questionable_widen: false,
    games_2026: 10,
    games_2027: 10,
    games: 20,
    shooting_games: 20,
    thin_sample: false,
    minutes_mean: 30,
    fga_per_min: 0.2,
    fta_per_min: 0.1,
    tpa_given_fga: 0.3,
    fg2_pct: 0.5,
    tp_pct: 0.35,
    ft_pct: 0.8,
    reb_per_min: 0.1,
    ast_per_min: 0.1,
    play_probability: 0.9,
    minutes_restriction: null,
    starter_rate: 0.8,
    minutes_residual_sd: 3.5,
    ...patch,
  };
}

function defenseEntry(games: number, pace: string, points: string): TeamDefenseEntry {
  const allowed = {} as Record<DefenseStatKey, string>;
  for (const key of DEFENSE_STAT_KEYS) allowed[key] = points;
  return { abbr: 'TM', name: 'Team', games, pace, allowed };
}

test('injuries keep unknown, skip a null cap, and defense rows are not a bet', () => {
  const teams: Record<string, TeamDefenseEntry> = {};
  for (let id = 1; id <= 30; id += 1) teams[String(id)] = defenseEntry(20, '100.0,15', '100,15|100,15|100,15|100,15');
  teams['1'] = defenseEntry(4, '99.4,8', '100,15|100,15|100,15|100,15');
  teams['2'] = defenseEntry(20, '101.2,4', '112.4,6|99.0,2|88.0,12|77.0,28');
  const slateGameOne = slateGame('g1', '1', '2');
  const slate: Slate = { schema_version: 1, generated_at: '2026-11-20T23:00:39Z', date: '2026-11-20', timezone: 'America/Chicago', games: [slateGameOne] };
  const ratePlayers = [
    player({ athlete_id: 'u', name: 'Uma Unknown', team_id: '1', injury_status: 'unknown', injury_note: 'ankle', minutes_restriction: null, play_probability: 0.4, minutes_mean: 15, starter_rate: 0.62, minutes_residual_sd: 4.25 }),
    player({ athlete_id: 'o', name: 'Uma Out', team_id: '1', injury_status: 'out', minutes_restriction: null, position_group: 'Forward', position: 'SF' }),
    player({ athlete_id: 's', name: 'Uma Season', team_id: '1', injury_status: 'out for season', position_group: 'Forward', position: 'PF' }),
    player({ athlete_id: 'c', name: 'Uma Cap', team_id: '1', injury_status: 'healthy', minutes_restriction: 24, position_group: 'Forward', position: 'SF' }),
    player({ athlete_id: 'f', name: 'Uma Fine', team_id: '1', injury_status: 'healthy', minutes_restriction: null, position_group: 'Forward', position: 'SF' }),
    player({ athlete_id: 'g', name: 'Guard Good', team_id: '1', injury_status: 'healthy', minutes_mean: 32, play_probability: 0.8, minutes_weight: 1 }),
    player({ athlete_id: 'm', name: 'Forward Mid', team_id: '1', injury_status: 'healthy', position_group: 'Forward', position: 'SF', minutes_mean: 30, play_probability: 0.9 }),
    player({ athlete_id: 'e', name: 'Center Edge', team_id: '1', injury_status: 'healthy', position_group: 'Center', position: 'C', minutes_mean: 28, play_probability: 0.7 }),
    player({ athlete_id: 'r', name: 'Guard Repl', team_id: '1', injury_status: 'healthy', replacement_level: true, minutes_mean: 30, play_probability: 1 }),
    player({ athlete_id: 'q', name: 'Guard Short', team_id: '1', injury_status: 'healthy', minutes_mean: 12, play_probability: 0.2, minutes_weight: 0 }),
    player({ athlete_id: 'h', name: 'Home Guard', team_id: '2', injury_status: 'healthy', minutes_mean: 32, play_probability: 0.95 }),
  ];
  const card = {
    schema_version: 1,
    generated_at: slate.generated_at,
    date: slate.date,
    iterations: 10000,
    model_version: 'possessions-v9',
    input_hash: 'input',
    model_hash: 'model',
    columns: [],
    projection_context: { active_season: 2027, season_label: '2026-27', defense_season_label: '2026-27', teams, players: {} },
    games: [{
      event_id: 'g1',
      away_team_id: '1',
      home_team_id: '2',
      thin_rotation: true,
      players: ratePlayers,
      context: {
        away: { pace: 100.5, offense: 1.11, defense: 1.08, games: 12, rest_days: 1, turnover_rate: 0.1, offensive_rebound_rate: 0.2, assist_rate: 0.5, ft_trip_rate: 0.2 },
        home: { pace: 98.2, offense: 1.05, defense: 1.14, games: 11, rest_days: null, turnover_rate: 0.1, offensive_rebound_rate: 0.2, assist_rate: 0.5, ft_trip_rate: 0.2 },
        league_efficiency: 1.123,
        pace_sd: 4,
        home_log_advantage: 0.01,
        neutral: false,
        training_games: 40,
        lead_effect: { marker: 0.424242 },
        residual_diagnostics: { margin_sd: 9.876 },
      },
    }],
  } as unknown as RateCard;
  const file = buildMatchups(slate, card, []);
  const html = renderMatchups(file, slate, card);
  assert.match(html, /NO BET/);
  assert.match(html, /Current unvalidated simulator \(possessions-v9\)\. Not a predicted score\./);
  assert.match(html, /The simulator is unvalidated\. Calibrated is false\. This report is descriptive\./);
  assert.match(html, /League efficiency 1\.123 points per possession\./);
  assert.equal(html.split('League efficiency').length - 1, 1);
  assert.match(html, /100\.5/);
  assert.match(html, /1\.110 points per possession/);
  assert.match(html, /1\.080 points per possession/);
  assert.match(html, /not recorded/);
  assert.match(html, /Defense sample 2026-27\./);
  assert.match(html, /99\.4 \(rank 8, 1 is fastest\)/);
  assert.match(html, /101\.2 \(rank 4, 1 is fastest\)/);
  assert.match(html, /112\.4 \(rank 6, 1 is fewest\)/);
  assert.match(html, /Thin rotation\./);
  assert.equal(html.includes('0.424242'), false);
  assert.equal(html.includes('9.876'), false);
  assert.match(html, /No simulated winner, score, margin, total, or win chance\. No posted spread, total, moneyline, or price\. No blowout rate\./);

  const injuries = section(html, 'Injuries');
  const item = (name: string) => {
    const found = injuries.split('<li>').find((part) => part.includes(name));
    assert.ok(found, name);
    return found;
  };
  const unknown = item('Uma Unknown');
  assert.match(unknown, /unknown/);
  assert.equal(unknown.toLowerCase().includes('healthy'), false);
  assert.match(unknown, /ankle/);
  assert.match(unknown, /Play probability 0\.400/);
  assert.match(unknown, /Minutes 15\.0/);
  assert.match(unknown, /Starter rate 0\.62/);
  assert.match(unknown, /Minute noise around role minutes 4\.25/);
  assert.equal(/cap|restriction/i.test(unknown), false);
  const out = item('Uma Out');
  assert.equal(/cap|restriction/i.test(out), false);
  assert.match(out, /Not converted into points\./);
  assert.match(item('Uma Season'), /No extra adjustment is applied\./);
  assert.match(item('Uma Cap'), /Minutes cap 24\./);
  assert.equal(injuries.includes('Uma Fine'), false);

  const defense = section(html, 'Points allowed');
  assert.match(defense, /points allowed to G per game\. Not a defender matchup\./);
  assert.match(defense, /points allowed to C per game\. Not a defender matchup\./);
  assert.equal(defense.includes('points allowed to F per game'), false);
  assert.match(defense, /Not a bet\./);
  const good = defense.split('<li>').find((part) => part.includes('Guard Good'));
  assert.ok(good);
  assert.match(good, /Allowed per game 99\.0\. Rank 2\. Sample 20\./);
  assert.match(good, /Play share 0\.800/);
  assert.equal(good.includes('Minutes screen does not pass'), false);
  const shortRow = defense.split('<li>').find((part) => part.includes('Guard Short'));
  assert.ok(shortRow);
  assert.match(shortRow, /Minutes screen does not pass/);
  assert.equal(defense.includes('Guard Repl'), false);
  assert.equal(defense.includes('Forward Mid'), false);
  assert.equal(defense.includes('Home Guard'), false);
  assert.equal(defense.includes('Uma Fine'), false);

  const other = { ...file, generated_at: '2026-11-21T00:00:00Z' };
  const missed = renderMatchups(other, slate, card);
  assert.match(missed, /The report is not for this card\./);
  assert.equal(missed.includes('data-verdict'), false);
  assert.match(renderMatchups(null, slate, card), /The report is not for this card\./);
  const controls = boardControlsHtml('shop');
  assert.match(controls, /data-board-view="shop"[^>]*aria-pressed="true"/);
  assert.match(controls, /data-board-view="matchups"[^>]*aria-pressed="false"/);
  assert.equal(controls.includes('data-panel-tab'), false);
  assert.equal(controls.includes('data-desk-tab'), false);
});

test('the board opens on Prices and Matchups does not draw or read lineup edits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sim-matchups-'));
  const { window, document } = parseHTML(readFileSync('index.html', 'utf8'));
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const key of ['window', 'document', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLImageElement', 'HTMLDetailsElement', 'Element', 'Event']) {
    globals[key] = (window as unknown as Record<string, unknown>)[key];
  }
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false }) });
  window.scrollTo = () => {};
  globals.CSS = { escape: (value: string) => value };
  const reads: string[] = [];
  globals.localStorage = { getItem: (key: string) => { reads.push(key); return null; }, setItem: () => {} };
  globals.sessionStorage = { getItem: () => null, setItem: () => {} };
  let workers = 0;
  class CountingWorker {
    constructor() { workers += 1; }
    postMessage() {}
    terminate() {}
  }
  globals.Worker = CountingWorker;
  const timer = globalThis.setInterval;
  globals.setInterval = () => 0;

  const card = JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/rate-card.json', 'utf8')) as RateCard;
  const slate = JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/slate.json', 'utf8')) as Slate;
  const now = new Date();
  card.generated_at = now.toISOString();
  slate.generated_at = card.generated_at;
  const chicago = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  card.date = chicago;
  slate.date = chicago;
  slate.games.forEach((game) => {
    game.date = chicago;
    game.status_state = 'pre';
    game.completed = false;
    game.start_time = new Date(now.getTime() + 3_600_000).toISOString();
  });
  delete card.model_hash;
  const matchups = buildMatchups(slate, card, []);
  const picks = {
    schema_version: 1,
    generated_at: card.generated_at,
    input_hash: card.input_hash ?? null,
    model_hash: null,
    built_at: card.generated_at,
    book: 'DraftKings',
    lines: { [slate.games[0]!.event_id]: [['odds-player', 'pts', 10.5, -110, -110, now.toISOString()]] },
    leans: [],
    record: { tiers: [] },
  };
  globals.fetch = async (url: string) => {
    const body = String(url).endsWith('/slate.json')
      ? JSON.stringify(slate)
      : String(url).endsWith('/rate-card.json')
        ? JSON.stringify(card)
        : String(url).endsWith('/matchups.json')
          ? JSON.stringify(matchups)
          : String(url).endsWith('/picks.json')
            ? JSON.stringify(picks)
            : '';
    return new Response(body, { status: body ? 200 : 404 });
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 30));
  try {
    await build({ entryPoints: ['src/main.ts'], bundle: true, format: 'esm', outfile: join(dir, 'app.mjs'), loader: { '.css': 'empty' }, logLevel: 'silent' });
    await import(pathToFileURL(join(dir, 'app.mjs')).href);
    await flush();
    document.querySelector<HTMLButtonElement>('[data-desk-tab="board"]')?.click();
    await flush();
    const shop = document.querySelector<HTMLButtonElement>('#board [data-board-view="shop"]');
    const matchup = document.querySelector<HTMLButtonElement>('#board [data-board-view="matchups"]');
    assert.equal(shop?.getAttribute('aria-pressed'), 'true');
    assert.equal(matchup?.getAttribute('aria-pressed'), 'false');
    assert.equal(shop?.hasAttribute('data-panel-tab'), false);
    assert.equal(shop?.hasAttribute('data-desk-tab'), false);
    assert.equal(matchup?.hasAttribute('data-panel-tab'), false);
    assert.equal(matchup?.hasAttribute('data-desk-tab'), false);
    assert.match(document.querySelector('#board')?.textContent ?? '', /odds-player/);
    assert.equal(document.querySelector('#board [data-verdict]'), null);
    assert.equal(document.querySelector('[data-desk-tab="board"]')?.getAttribute('aria-selected'), 'true');
    assert.equal(document.querySelector('[data-desk-tab="games"]')?.getAttribute('aria-selected'), 'false');
    assert.equal(document.querySelector('[data-desk-tab="projections"]')?.getAttribute('aria-selected'), 'false');
    const drawn = workers;
    reads.length = 0;
    matchup?.click();
    await flush();
    assert.equal(workers, drawn);
    assert.equal(reads.includes('simulator.lineups'), false);
    assert.equal(document.querySelector('#board [data-board-view="matchups"]')?.getAttribute('aria-pressed'), 'true');
    assert.equal(document.querySelector('#board [data-board-view="shop"]')?.getAttribute('aria-pressed'), 'false');
    assert.equal(document.querySelector('#board [data-verdict]')?.textContent, 'NO BET');
    assert.equal((document.querySelector('#board')?.textContent ?? '').includes('odds-player'), false);
    assert.match(document.querySelector('#board')?.textContent ?? '', /Not a predicted score/);
    assert.equal(document.querySelector('[data-desk-tab="board"]')?.getAttribute('aria-selected'), 'true');
    assert.equal(document.querySelector('[data-desk-tab="games"]')?.getAttribute('aria-selected'), 'false');
    assert.equal((document.querySelector('#board')?.textContent ?? '').includes('Simulating 10,000'), false);
    document.querySelector<HTMLButtonElement>('#board [data-board-view="shop"]')?.click();
    await flush();
    assert.equal(workers, drawn);
    assert.match(document.querySelector('#board')?.textContent ?? '', /odds-player/);
    assert.equal(document.querySelector('#board [data-board-view="shop"]')?.getAttribute('aria-pressed'), 'true');
  } finally {
    globalThis.setInterval = timer;
    rmSync(dir, { recursive: true, force: true });
  }
});
