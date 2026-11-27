import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { buildDaily, nflGamesOf, pendingSpreadDates } from '../scripts/build-daily.ts';
import {
  dailyFile, dailyRecord, emptyDay, nflDailyPanelState, parseDailyDay, parseDailyFile, pickState, postDailyPicks, serializeDailyDay,
  type DailyLedgerDay,
} from '../src/daily-ledger.ts';
import { dailyNflSpreadForGame } from '../src/daily-nfl.ts';
import { renderDailyPanel } from '../src/daily-panel.ts';
import { nflUpcomingToday } from '../src/daily-price.ts';
import type { FeedGame } from '../src/feed.ts';
import { pregameSpreadQuotes } from '../src/spread-quotes.ts';
import type { RateCard, Slate, SpreadQuote } from '../src/types.ts';

const side = (name: string, abbreviation: string) => ({ name, abbreviation, score: null, logo_url: null, color: null, alternate_color: null });
const nflGame = (changes: Partial<FeedGame> = {}): FeedGame => ({
  id: '401873083', start_time: '2026-11-27T20:00:00.000Z', status: 'scheduled', listed: false,
  away: side('Denver Broncos', 'DEN'), home: side('Pittsburgh Steelers', 'PIT'), venue: null, neutral_site: false, competition: null,
  projection: null, projection_note: 'Simulated.', ...changes,
});
const quote: SpreadQuote = { source: 'ESPN scoreboard', book: 'DraftKings', captured_at: '2026-11-27T17:30:00Z', home_spread: 4.5, home_odds: -107, away_odds: -112 };
const morning = new Date('2026-11-27T17:30:00Z');
// PIT covers +4.5 whenever it loses by 4 or less: 5,425 of 10,000 draws.
const margins = [...Array(5425).fill(-3), ...Array(4575).fill(-8)];

test('the NFL scoreboard gives each game still to start its current two-sided spreads', () => {
  const offer = (home: string, away: string, homeOdds = '-107', awayOdds = '-112') => ({
    provider: { name: 'DraftKings' }, pointSpread: { home: { close: { line: home, odds: homeOdds } }, away: { close: { line: away, odds: awayOdds } } },
  });
  const event = (id: string, state: string, date: string, odds: unknown[]) => ({ id, date, competitions: [{ status: { type: { state, completed: state === 'post' } }, odds }] });
  const board = { events: [
    event('1', 'pre', '2026-11-27T20:00Z', [offer('+4.5', '-4.5')]),
    event('2', 'pre', '2026-11-29T18:00Z', [offer('PK', 'PK', 'EVEN', '-120')]),
    event('3', 'in', '2026-11-27T17:00Z', [offer('-3', '+3')]),
    event('4', 'pre', '2026-11-27T17:00Z', [offer('-3', '+3')]),
    event('5', 'pre', '2026-11-29T18:00Z', [offer('-3', '+2.5')]),
  ] };
  const quotes = pregameSpreadQuotes(board, '2026-11-27T17:30:00Z');
  assert.deepEqual([...quotes.keys()], ['1', '2'], 'a game under way, past its start, or with a mismatched line has none');
  assert.deepEqual(quotes.get('1'), { start: '2026-11-27T20:00:00.000Z', quotes: [{ ...quote }] });
  assert.deepEqual(quotes.get('2')?.quotes[0], { ...quote, home_spread: 0, home_odds: 100, away_odds: -120 });
  assert.deepEqual([...pregameSpreadQuotes(null, '2026-11-27T17:30:00Z')], []);
});

test('an NFL spread is priced from the replayed margins, posted only before kickoff on its day, and is never a qualified pick', () => {
  const draw = () => margins;
  const pick = dailyNflSpreadForGame(nflGame(), [quote], morning, draw)!;
  assert.equal(pick.title, 'Pittsburgh Steelers +4.5');
  assert.equal(pick.matchup, 'DEN at PIT');
  assert.equal(pick.projectionLabel, 'Model spread PIT +5.3');
  assert.equal(pick.tip, '2026-11-27T20:00:00Z', 'kickoff in the same form as a tip');
  assert.equal(pick.modelProbability, 0.5425);
  assert.equal(pick.grade, 'THIN');
  assert.equal(pick.evidence, 'Below the edge bar: the model’s cover chance of 54.3% clears the 51.7% break-even by 2.6 points, short of the 3.0 a lean needs.');
  assert.deepEqual(pick.settle, { kind: 'spread', side: 'home', home_spread: 4.5, home: 'PIT', away: 'DEN' });
  // A clear edge is still only an unproven one: NFL spread leans have no graded record.
  const edge = dailyNflSpreadForGame(nflGame(), [quote], morning, () => [...Array(6000).fill(-3), ...Array(4000).fill(-8)])!;
  assert.equal(edge.grade, 'EDGE');
  assert.match(edge.evidence ?? '', /^Not a qualified pick: NFL spread leans are not graded against results yet/);
  assert.equal(dailyNflSpreadForGame(nflGame({ status: 'in_progress' }), [quote], morning, draw), null);
  assert.equal(dailyNflSpreadForGame(nflGame(), [quote], new Date('2026-11-27T20:00:00Z'), draw), null, 'not at kickoff');
  assert.equal(dailyNflSpreadForGame(nflGame({ start_time: '2026-11-29T18:00:00.000Z' }), [{ ...quote }], morning, draw), null, 'not before its day');
  assert.equal(dailyNflSpreadForGame(nflGame(), [], morning, draw), null);
  assert.equal(dailyNflSpreadForGame(nflGame(), [quote], morning, () => null), null, 'a game without a plan is not priced');
  // Thursday night kicks off at 7:15 PM in Chicago, which is already Friday in UTC: it is still Thursday's game.
  assert.equal(nflUpcomingToday(nflGame({ start_time: '2026-12-04T01:15:00.000Z' }), new Date('2026-12-03T15:00:00Z')), true);
});

const slate: Slate = { schema_version: 1, generated_at: '2026-11-27T17:00:00Z', date: '2026-11-27', timezone: 'America/Chicago', games: [] };
const card = { generated_at: '2026-11-27T17:00:00Z', games: [] } as unknown as RateCard;

test('the refresh posts the NFL team bet in its own category, draws no NBA game for it, and grades it on the final', () => {
  const days = new Map<string, DailyLedgerDay>();
  const nba: string[] = [];
  const nfl = { games: [nflGame(), nflGame({ id: '401873084', start_time: '2026-11-29T18:00:00.000Z' })], quotes: new Map([['401873083', { start: '2026-11-27T20:00:00.000Z', quotes: [quote] }]]) };
  const input = { slate, card, picks: null, calibration: null, events: new Map(), finals: new Map(), days, nfl, nflDraw: () => margins,
    draw: () => { nba.push('drawn'); throw new Error('no NBA game should be drawn'); } };
  const first = buildDaily({ ...input, now: morning });
  assert.deepEqual(first.posted.map((pick) => [pick.category, pick.title, pick.odds]), [['nfl_spread', 'Pittsburgh Steelers +4.5', -107]]);
  assert.deepEqual(nba, []);
  assert.equal(first.file.record.nfl_spread.pending, 1);
  assert.equal(first.file.record.spread.picks, 0, 'NFL picks keep out of the NBA team record');
  assert.equal(first.file.record.all.picks, 1);
  // A kickoff the scoreboard moved is not priced until the slate agrees.
  const moved = buildDaily({ ...input, days: new Map(), nfl: { ...nfl, quotes: new Map([['401873083', { start: '2026-11-27T21:00:00.000Z', quotes: [quote] }]]) }, now: morning });
  assert.deepEqual(moved.posted, []);
  // Kicked off: nothing else today, and the game waits on its final. PIT lost by 3 and covered +4.5.
  const kicked = new Date('2026-11-27T21:00:00Z');
  assert.equal(pickState(days.get('2026-11-27')!.picks[0], kicked), 'live');
  assert.deepEqual(pendingSpreadDates(days.values(), kicked, 'nfl_spread'), ['2026-11-27']);
  assert.deepEqual(pendingSpreadDates(days.values(), kicked), [], 'the NBA scoreboard is not read for an NFL pick');
  const graded = buildDaily({ ...input, finals: new Map([['401873083', { home: 20, away: 23 }]]), now: new Date('2026-11-28T02:00:00Z') });
  assert.equal(graded.settled, 1);
  assert.deepEqual(graded.file.record.nfl_spread, { picks: 1, wins: 1, losses: 0, pushes: 0, voids: 0, pending: 0, units: 0.9346, from: '2026-11-27' });
  // The day round-trips with its NFL pick.
  const text = serializeDailyDay(days.get('2026-11-27')!);
  assert.equal(parseDailyDay(text)?.picks[0].category, 'nfl_spread');
});

test('an NFL pick posts only as an NFL spread, and a file from before NFL picks still reads', () => {
  const offer = dailyNflSpreadForGame(nflGame(), [quote], morning, () => margins)!;
  const day = emptyDay('2026-11-27');
  assert.deepEqual(postDailyPicks(day, { prop: [offer] }, morning), [], 'a spread is never posted as a prop');
  assert.equal(postDailyPicks(day, { nfl_spread: [offer] }, morning)[0].category, 'nfl_spread');
  const file = dailyFile(new Map([[day.date, day]]), [day.date], morning);
  const { nfl_spread: _nfl, ...older } = file.record;
  const parsed = parseDailyFile(JSON.stringify({ ...file, picks: [], record: older }));
  assert.deepEqual(parsed?.record.nfl_spread, dailyRecord([]).nfl_spread);
  assert.equal(parseDailyFile(JSON.stringify(file))?.picks[0].category, 'nfl_spread');
  assert.equal(parseDailyFile(JSON.stringify({ ...file, record: { ...file.record, nfl_spread: { picks: 'x' } } })), null);
});

test('the NFL panel shows its team bets with kickoff times, its own record, and names the next game day when there is none', () => {
  const offer = dailyNflSpreadForGame(nflGame(), [quote], morning, () => margins)!;
  const day = emptyDay('2026-11-27');
  postDailyPicks(day, { nfl_spread: [offer] }, morning);
  const file = dailyFile(new Map([[day.date, day]]), [day.date], morning);
  const games = [nflGame(), nflGame({ id: '401873084', start_time: '2026-11-29T18:00:00.000Z' })];
  const { document } = parseHTML(renderDailyPanel(nflDailyPanelState(file, games, morning)));
  assert.equal(document.querySelector('section.daily-picks')?.getAttribute('data-category'), 'nfl_spread');
  assert.equal(document.querySelector('h2')?.textContent, 'NFL team bets of the day');
  assert.match(document.querySelector('.daily-intro')?.textContent ?? '', /strongest point spread left on the day’s NFL games.*NFL player props are not posted\.$/);
  const card = document.querySelector('article.daily-offer')!;
  assert.equal(card.querySelector('h4')?.textContent, 'NFL spread');
  assert.equal(card.querySelector('.daily-grade')?.textContent, 'Thin edge');
  assert.match(card.querySelector('.daily-match')?.textContent ?? '', /^DEN at PIT · Kicks off .*2:00 PM CST$/);
  assert.match(document.querySelector('.daily-note')?.textContent ?? '', /A thin edge or top spread is posted only because nothing cleared the edge bar/);
  assert.equal(document.querySelector('.daily-record-sub')?.textContent, '1 posted · 1 pending · since Nov 27');
  // Later in the day, once the game has kicked off.
  const after = parseHTML(renderDailyPanel(nflDailyPanelState(file, games, new Date('2026-11-27T21:00:00Z')))).document;
  assert.match(after.querySelector('.daily-match')?.textContent ?? '', /Kicked off/);
  // A day with games and no pick yet, and a day without games.
  const empty = dailyFile(new Map(), ['2026-11-27'], morning);
  const waiting = parseHTML(renderDailyPanel(nflDailyPanelState(empty, games, morning))).document;
  assert.equal(waiting.querySelector('.daily-empty')?.textContent, 'No NFL team bet has been posted yet today. One posts at the next update once a game still to kick off has a current spread.');
  const saturday = parseHTML(renderDailyPanel(nflDailyPanelState(empty, games, new Date('2026-11-28T17:00:00Z')))).document;
  assert.equal(saturday.querySelector('.daily-empty')?.textContent, 'No NFL games left today. The next team bet posts on game day, Sunday, Nov 29.');
  assert.equal(parseHTML(renderDailyPanel(nflDailyPanelState(null, games, morning))).document.querySelector('.daily-intro')?.textContent,
    'Today’s NFL team bets and their record are awaiting publication.');
  // A top spread says so, not "top prop".
  const top = { ...day.picks[0], grade: 'TOP' as const, state: 'open' as const };
  const shown = parseHTML(renderDailyPanel({ status: 'open', category: 'nfl_spread', record: file.record.nfl_spread, today: [top], yesterday: [], notes: [] })).document;
  assert.equal(shown.querySelector('.daily-grade')?.textContent, 'Top spread · no edge');
});

test('the NFL slate reads each game once, and an invalid file gives none', () => {
  const feed = { sport: 'nfl', source: 'ESPN', generated_at: '2026-11-27T17:00:00Z', timezone: 'America/Chicago', dates: ['2026-11-26', '2026-11-27'],
    games: [nflGame()], later: [nflGame(), nflGame({ id: '401873084', start_time: '2026-11-29T18:00:00.000Z' })],
    model: { fitted: true, name: 'nfl-sim-v1', note: 'Simulated.', holdout_games: null, holdout_brier: null } };
  assert.deepEqual(nflGamesOf(JSON.stringify(feed)).map((game) => game.id), ['401873083', '401873084']);
  assert.deepEqual(nflGamesOf(''), []);
  assert.deepEqual(nflGamesOf(JSON.stringify({ ...feed, games: [{ ...nflGame(), spread: -3 }] })), [], 'the slate never carries a price');
});
