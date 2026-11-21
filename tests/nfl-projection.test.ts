import assert from 'node:assert/strict';
import test from 'node:test';
import { pickShown, publishedStatBand } from '../scripts/build-nfl-slate.ts';
import { parseFeedSlate, renderFeedSlate, type FeedSlate } from '../src/feed.ts';
import { packGame, parseNflCache, parseNflSummary, serializeNflCache, unpackGame } from '../src/nfl/boxscore.ts';
import { parseInjuries, parseRoster } from '../src/nfl/espn.ts';
import {
  IDENTITY_CALIBRATION,
  fitBias,
  fitSpread,
  orderQuarterbacks,
  planGame,
  playChance,
  simulateGame,
  walkForward,
} from '../src/nfl/projection.ts';
import { season } from './helpers/nfl-season.ts';

function summary(state: 'post' | 'pre') {
  const athlete = (id: string, displayName: string) => ({ athlete: { id, displayName } });
  return {
    header: {
      id: '9001',
      season: { year: 2026, type: 2 },
      week: { number: 11 },
      competitions: [
        {
          id: '9001',
          date: '2026-11-20T01:15Z',
          neutralSite: false,
          status: { type: { state, completed: state === 'post' } },
          competitors: [
            { homeAway: 'home', score: '26', team: { id: '34', abbreviation: 'HOU' } },
            { homeAway: 'away', score: '3', team: { id: '11', abbreviation: 'IND' } },
          ],
        },
      ],
    },
    odds: [{ spread: -3.5 }],
    boxscore: {
      teams: [
        { team: { id: '34' }, statistics: [{ name: 'totalDrives', displayValue: '10' }, { name: 'completionAttempts', displayValue: '21/27' }, { name: 'rushingAttempts', displayValue: '37' }] },
        { team: { id: '11' }, statistics: [{ name: 'totalDrives', displayValue: '10' }, { name: 'completionAttempts', displayValue: '12/29' }, { name: 'rushingAttempts', displayValue: '17' }] },
      ],
      players: [
        {
          team: { id: '34' },
          statistics: [
            // Keys out of their usual order: values are read by name.
            { name: 'passing', keys: ['passingYards', 'completions/passingAttempts', 'passingTouchdowns', 'interceptions'], athletes: [{ ...athlete('1', 'Passer'), stats: ['194', '21/27', '3', '1'] }] },
            { name: 'rushing', keys: ['rushingAttempts', 'rushingYards', 'rushingTouchdowns'], athletes: [{ ...athlete('2', 'Runner'), stats: ['26', '107', '0'] }, { ...athlete('1', 'Passer'), stats: ['6', '27', '0'] }] },
            { name: 'receiving', keys: ['receptions', 'receivingYards', 'receivingTouchdowns', 'receivingTargets'], athletes: [{ ...athlete('3', 'Catcher'), stats: ['3', '58', '1', '5'] }] },
            { name: 'kicking', keys: ['fieldGoalsMade/fieldGoalAttempts', 'extraPointsMade/extraPointAttempts'], athletes: [{ ...athlete('4', 'Kicker'), stats: ['1/1', '3/3'] }] },
          ],
        },
        { team: { id: '11' }, statistics: [{ name: 'passing', keys: ['completions/passingAttempts', 'passingYards', 'passingTouchdowns', 'interceptions'], athletes: [{ ...athlete('5', 'Other Passer'), stats: ['12/27', '144', '0', '1'] }] }] },
      ],
    },
    injuries: [{ team: { abbreviation: 'HOU' }, injuries: [{ athlete: { id: '3' }, status: 'Questionable' }, { athlete: { id: '9' }, status: 'Out' }] }],
  };
}

test('a final summary becomes a box score read by key name, and a game still to play is not one', () => {
  const game = parseNflSummary(summary('post'))!;
  assert.ok(game);
  assert.equal(game.home.abbr, 'HOU');
  assert.equal(game.home.points, 26);
  assert.equal(game.home.pass_att, 27);
  assert.equal(game.home.rush_att, 37);
  assert.equal(game.home.fg, 1);
  const passer = game.home.players.find((line) => line.id === '1')!;
  assert.deepEqual([passer.pass_cmp, passer.pass_att, passer.pass_yds, passer.pass_td, passer.int, passer.car, passer.rush_yds], [21, 27, 194, 3, 1, 6, 27]);
  assert.equal(game.home.players.find((line) => line.id === '3')!.tgt, 5);
  assert.equal(game.home.players.some((line) => line.id === '4'), false);
  assert.equal(parseNflSummary(summary('pre')), null);
  const roundTrip = parseNflCache(serializeNflCache({ schema_version: 1, season: 2026, games: [packGame(game)] }))!;
  assert.deepEqual(unpackGame(roundTrip.games[0]!), game);
  assert.equal(parseNflCache('{"schema_version":2}'), null);
  const injuries = parseInjuries(summary('pre'));
  assert.equal(injuries.get('3'), 'Questionable');
  assert.equal(playChance(injuries.get('3') ?? null), 0.75);
  assert.equal(playChance(injuries.get('9') ?? null), 0);
  assert.equal(playChance('Doubtful'), 0);
  assert.equal(playChance(null), 1);
  const roster = parseRoster({ athletes: [{ position: 'offense', items: [{ id: '1', displayName: 'Passer', position: { abbreviation: 'QB' } }] }, { position: 'injuredReserveOrOut', items: [{ id: '8', displayName: 'Hurt', position: { abbreviation: 'WR' } }] }] });
  assert.deepEqual(roster.map((player) => player.id), ['1']);
});

test('a simulated game is consistent: the passer throws what his receivers catch, and the same seed repeats', () => {
  const games = season(8);
  const asOf = Date.parse('2026-12-01T00:00:00Z');
  const plans = planGame(games, 'AAA', 'DDD', false, asOf);
  assert.ok(plans.home.points > plans.away.points);
  const first = simulateGame(plans.home, plans.away, false, 2000, 11, IDENTITY_CALIBRATION);
  const again = simulateGame(plans.home, plans.away, false, 2000, 11, IDENTITY_CALIBRATION);
  assert.deepEqual(first.projection, again.projection);
  assert.ok(first.projection.home_win > 0.5);
  const tally = first.raw.tally;
  for (let draw = 0; draw < 2000; draw += 1) {
    const passYds = tally.get('AAA-qb')!.pass_yds![draw]!;
    const catches = ['AAA-wr0', 'AAA-wr1', 'AAA-wr2', 'AAA-rb1', 'AAA-rb2'].reduce((sum, id) => sum + tally.get(id)!.rec_yds![draw]!, 0);
    assert.equal(passYds, catches);
    const passTd = tally.get('AAA-qb')!.pass_td![draw]!;
    const recTd = ['AAA-wr0', 'AAA-wr1', 'AAA-wr2', 'AAA-rb1', 'AAA-rb2'].reduce((sum, id) => sum + tally.get(id)!.rec_td![draw]!, 0);
    assert.equal(passTd, recTd);
  }
  const top = first.projection.players.find((player) => player.id === 'AAA-wr0')!;
  const third = first.projection.players.find((player) => player.id === 'AAA-wr2')!;
  assert.ok(top.stats.tgt!.mean > third.stats.tgt!.mean);
  assert.ok(first.projection.margin.p10 < first.projection.margin.p50 && first.projection.margin.p50 < first.projection.margin.p90);
});

test('the walk-forward check fits a calibration on earlier weeks only', () => {
  const games = season(10);
  const result = walkForward(games, 300, 4, [0, 0.1]);
  assert.equal(result.fromWeek, 4);
  assert.equal(result.throughWeek, 10);
  assert.equal(result.games, 14);
  assert.ok(result.winBrier > 0 && result.winBrier < 0.35);
  assert.ok(result.calibration.temperature >= 0.5 && result.calibration.temperature <= 2);
  assert.ok(Object.values(result.calibration.spread).every((value) => value! >= 0.6 && value! <= 2.5));
  assert.ok(result.playerRows > 0);
  assert.equal(fitSpread([]), 1);
  assert.equal(fitBias([{ projected: 10, actual: 12 }]), 1);
  assert.ok(Math.abs(fitBias(Array.from({ length: 200 }, () => ({ projected: 10, actual: 12 }))) - 1.1) < 1e-9);
});

test('the starter is last week\'s passer unless he has thrown far less than the leader', () => {
  const qb = (name: string, lastPassAtt: number, weightedPassAtt: number) => ({ name, lastPassAtt, weightedPassAtt });
  // A stand-in who started one game while the starter sat does not take over.
  assert.equal(orderQuarterbacks([qb('Stand-in', 30, 30), qb('Starter', 0, 100)])[0]!.name, 'Starter');
  // A change that has lasted two games does.
  assert.equal(orderQuarterbacks([qb('New', 30, 55), qb('Old', 0, 86)])[0]!.name, 'New');
  assert.equal(orderQuarterbacks([qb('Only', 0, 0)])[0]!.name, 'Only');
});

test('published ranges are whole numbers that stop where the stat can, and only the starting passer is listed', () => {
  assert.deepEqual(publishedStatBand('rec', { mean: 4.08, p10: -0.4, p50: 4.08, p90: 7.2 }), { mean: 4.1, p10: 0, p50: 4, p90: 7 });
  assert.deepEqual(publishedStatBand('rush_yds', { mean: 3, p10: -14, p50: 2.4, p90: 20.6 }), { mean: 3, p10: -10, p50: 2, p90: 21 });
  const band = (p50: number, mean = p50) => ({ mean, p10: 0, p50, p90: p50 * 2 });
  const shown = pickShown([
    { position: 'QB', stats: { pass_yds: band(240) } },
    { position: 'QB', stats: { pass_yds: band(0, 55) } },
    { position: 'RB', stats: { car: band(15) } },
    { position: 'RB', stats: { car: band(1) } },
    { position: 'WR', stats: { tgt: band(7) } },
    { position: 'TE', stats: { tgt: band(5) } },
    { position: 'WR', stats: { tgt: band(1) } },
  ]);
  assert.equal(shown.length, 4);
  assert.equal(shown.filter((player) => player.position === 'QB').length, 1);
});

test('the NFL page shows the simulated score, the player table, and the walk-forward check', () => {
  const now = new Date('2026-11-21T18:00:00Z');
  const band = (mean: number, spread: number) => ({ mean, p10: mean - spread, p50: mean, p90: mean + spread });
  const slate: FeedSlate = {
    sport: 'nfl',
    source: 'ESPN NFL scoreboard and box scores',
    generated_at: now.toISOString(),
    timezone: 'America/Chicago',
    dates: ['2026-11-20', '2026-11-21'],
    games: [],
    later: [
      {
        id: 'g1',
        start_time: '2026-11-22T18:00:00Z',
        status: 'scheduled',
        listed: false,
        away: { name: 'Miami Dolphins', abbreviation: 'MIA', score: null, logo_url: null, color: null, alternate_color: null, record: '1-8' },
        home: { name: 'Buffalo Bills', abbreviation: 'BUF', score: null, logo_url: null, color: null, alternate_color: null, record: '8-1' },
        venue: 'Highmark Stadium',
        neutral_site: false,
        competition: null,
        projection: { kind: 'game', away_win: 0.13, home_win: 0.87, summary: 'MIA 13.0% · BUF 87.0%' },
        projection_note: 'Simulated from box scores before kickoff.',
        sim: {
          draws: 10000,
          away_points: band(18.4, 11),
          home_points: band(31.3, 12),
          margin: band(12.9, 16),
          combined: band(49.7, 18),
          home_win: 0.87,
          players: [
            { id: 'p1', name: 'Josh Allen', side: 'home', position: 'QB', status: null, play: 1, stats: { pass_yds: { mean: 224.7, p10: 119, p50: 225, p90: 336 } }, td: 0.4 },
            { id: 'p2', name: 'Dalton Kincaid', side: 'home', position: 'TE', status: 'Questionable', play: 0.75, stats: { rec: { mean: 2.8, p10: 1, p50: 3, p90: 5 } }, td: 0.23 },
          ],
        },
      },
    ],
    model: {
      fitted: true,
      name: 'nfl-sim-v1',
      note: 'Each game is played 10,000 times.',
      holdout_games: 103,
      holdout_brier: 0.2128,
      validation: { games: 103, from_week: 4, through_week: 11, win_brier: 0.2128, margin_mae: 9.43, td_brier: 0.155, coverage: { rec_yds: 0.81, rush_yds: 0.8, pass_yds: 0.8, margin: 0.79 }, mae: { rec_yds: 18.6 } },
    },
  };
  const parsed = parseFeedSlate(JSON.stringify(slate), 'nfl');
  assert.ok(parsed);
  const html = renderFeedSlate(parsed, now);
  assert.match(html, /<span class="feed-proj-line">MIA 18 <span class="feed-proj-dash">–<\/span> 31 BUF<\/span>/);
  assert.match(html, /<span>MIA 13%<\/span><span>BUF by 12\.9<\/span><span>BUF 87%<\/span>/);
  assert.match(html, /role="img" aria-label="Win chance MIA 13%, BUF 87%"/);
  // The method and the walk-forward check fold away under the header instead of opening the page.
  assert.match(html, /<details class="method-note"><summary>How these projections work<\/summary>/);
  assert.match(html, /<summary>Player projections<\/summary>/);
  assert.match(html, /Josh Allen/);
  assert.match(html, /Pass yds<\/p><p class="tile-value">225<\/p><p class="tile-sub">119 to 336/);
  assert.match(html, /Questionable · plays in 75% of draws · anytime TD 23%/);
  assert.match(html, /Checked on weeks 4 to 11 \(103 games\)/);
  assert.equal(/odds|spread|moneyline/i.test(html), false);
  // A broken projection block fails the file, as a price would.
  const broken = JSON.parse(JSON.stringify(slate));
  broken.later[0].sim.players[0].stats.pass_yds.p10 = 400;
  assert.equal(parseFeedSlate(JSON.stringify(broken), 'nfl'), null);
  const unknownStat = JSON.parse(JSON.stringify(slate));
  unknownStat.later[0].sim.players[0].stats.fantasy = { mean: 1, p10: 0, p50: 1, p90: 2 };
  assert.equal(parseFeedSlate(JSON.stringify(unknownStat), 'nfl'), null);
});
