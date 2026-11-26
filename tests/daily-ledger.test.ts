import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dailyFile, dailyPanelState, dailyRecord, emptyDay, openPick, parseDailyDay, parseDailyFile, pickState, postDailyPicks,
  serializeDailyDay, settleDailyPick, settleDailyPicks, type DailyLedgerDay, type PostedDailyPick,
} from '../src/daily-ledger.ts';
import type { DailyOffer } from '../src/daily-price.ts';
import type { CompletedEvent } from '../src/parse-summary.ts';
import type { PropMarket } from '../src/props.ts';
import { buildDaily, finalsFromScoreboard, pendingSpreadDates, publishedText, readDays } from '../scripts/build-daily.ts';
import type { RateCard, Slate, SpreadQuote } from '../src/types.ts';

const date = '2026-11-25';
const offer = (eventId: string, team: string, tip: string, expectedReturn: number, changes: Partial<DailyOffer> = {}): DailyOffer => ({
  eventId, title: `${team} +3.5`, projectionLabel: 'Model spread', matchup: `${team.slice(0, 3).toUpperCase()} at HOM`, tip,
  pricedAt: '2026-11-25T06:05:00Z', book: 'DraftKings', odds: -110, modelProbability: 0.6, breakEven: 110 / 210, expectedReturn, grade: 'EDGE',
  settle: { kind: 'spread', side: 'away', home_spread: -3.5, home: 'HOM', away: team.slice(0, 3).toUpperCase() }, ...changes,
});
const bulls = offer('401909318', 'Chicago Bulls', '2026-11-26T00:00:00Z', 0.172, { odds: -115, breakEven: 115 / 215 });
const wolves = offer('401909320', 'Minnesota Timberwolves', '2026-11-26T00:30:00Z', 0.129, { title: 'Minnesota Timberwolves +2.5', settle: { kind: 'spread', side: 'away', home_spread: -2.5, home: 'OKC', away: 'MIN' } });
const grizzlies = offer('401909321', 'Memphis Grizzlies', '2026-11-26T01:00:00Z', 0.113, { settle: { kind: 'spread', side: 'home', home_spread: -7.5, home: 'MEM', away: 'LAC' } });

test('a posted pick stays up until its game tips, then the next game\'s best pick is posted, and both are kept', () => {
  const day = emptyDay(date);
  // 12:05 AM: the Bulls are the best spread on the slate and are posted.
  assert.deepEqual(postDailyPicks(day, { prop: [], spread: [wolves, bulls, grizzlies] }, new Date('2026-11-25T06:05:00Z')).map((pick) => pick.title), ['Chicago Bulls +3.5']);
  // 5:30 PM: a better price elsewhere does not replace a pick that is still open, and nothing is posted twice.
  assert.deepEqual(postDailyPicks(day, { prop: [], spread: [{ ...wolves, expectedReturn: 0.5 }, bulls] }, new Date('2026-11-25T23:30:00Z')), []);
  assert.equal(openPick(day, 'spread', new Date('2026-11-25T23:59:59Z'))?.eventId, bulls.eventId);
  // 6:00 PM: the Bulls tip. The best game still to play is posted next; the Bulls stay on the day and keep counting.
  const tipped = new Date('2026-11-26T00:00:00Z');
  assert.equal(openPick(day, 'spread', tipped), null);
  assert.deepEqual(postDailyPicks(day, { prop: [], spread: [bulls, grizzlies, wolves] }, tipped).map((pick) => pick.title), ['Minnesota Timberwolves +2.5']);
  assert.deepEqual(day.picks.map((pick) => [pick.title, pick.posted_at]), [
    ['Chicago Bulls +3.5', '2026-11-25T06:05:00Z'],
    ['Minnesota Timberwolves +2.5', '2026-11-26T00:00:00Z'],
  ]);
  // The posted pick is fixed: its line and price are the ones it was posted with.
  assert.equal(day.picks[0].odds, -115);
  assert.equal(dailyRecord([day]).spread.pending, 2);
  // A game is posted once a category, a tipped game is never posted, and an offer that cannot be graded is not posted.
  const later = new Date('2026-11-26T00:30:00Z');
  assert.deepEqual(postDailyPicks(day, { prop: [], spread: [wolves, bulls] }, later), []);
  assert.deepEqual(postDailyPicks(emptyDay(date), { prop: [], spread: [{ ...grizzlies, settle: undefined }] }, later), []);
  assert.deepEqual(postDailyPicks(emptyDay(date), { prop: [grizzlies], spread: [] }, later), [], 'a spread is never posted as a prop');
});

const spreadPick = (changes: Partial<PostedDailyPick> = {}): PostedDailyPick => ({ ...bulls, category: 'spread', date, posted_at: '2026-11-25T06:05:00Z', settle: bulls.settle!, ...changes });
const event = (changes: Partial<CompletedEvent> = {}): CompletedEvent => ({
  event_id: bulls.eventId, start_time: bulls.tip, season: 2027, season_type: 2, neutral: false, periods: 4,
  home_team_id: '30', away_team_id: '4', home_pts: 110, away_pts: 108, players: [], ...changes,
});
const now = new Date('2026-11-26T05:00:00Z');

test('a spread settles on the final margin at its posted handicap and price, from the scoreboard or the box score', () => {
  const finals = (home: number, away: number) => new Map([[bulls.eventId, { home, away }]]);
  // Bulls +3.5 at -115: losing by 2 covers and pays 100/115 a unit; losing by 4 loses the unit.
  assert.deepEqual(settleDailyPick(spreadPick(), finals(110, 108), new Map(), now), { outcome: 'win', actual: 2, units: 0.8696, settled_at: '2026-11-26T05:00:00Z' });
  assert.equal(settleDailyPick(spreadPick(), finals(112, 108), new Map(), now)?.outcome, 'loss');
  assert.equal(settleDailyPick(spreadPick(), finals(112, 108), new Map(), now)?.units, -1);
  const home = spreadPick({ settle: { kind: 'spread', side: 'home', home_spread: -4, home: 'CHA', away: 'CHI' }, odds: 120 });
  assert.deepEqual(settleDailyPick(home, finals(112, 108), new Map(), now), { outcome: 'push', actual: 4, units: 0, settled_at: '2026-11-26T05:00:00Z' });
  assert.equal(settleDailyPick(home, finals(113, 108), new Map(), now)?.units, 1.2);
  // Without a scoreboard final the cached box score settles it; without either it waits, then voids after three days.
  assert.equal(settleDailyPick(spreadPick(), new Map(), new Map([[bulls.eventId, event()]]), now)?.outcome, 'win');
  assert.equal(settleDailyPick(spreadPick(), new Map(), new Map(), now), null);
  assert.equal(settleDailyPick(spreadPick(), new Map(), new Map(), new Date('2026-11-29T05:59:00Z')), null);
  assert.deepEqual(settleDailyPick(spreadPick(), new Map(), new Map(), new Date('2026-11-29T06:00:00Z')),
    { outcome: 'void', reason: 'no result', units: 0, settled_at: '2026-11-29T06:00:00Z' });
});

test('a prop settles on the player\'s box score, voids when he sits, and reads double-doubles from five categories', () => {
  const prop = (market: PropMarket, side: 'over' | 'under', line: number) =>
    spreadPick({ category: 'prop', settle: { kind: 'prop', athlete_id: '7', market, side, line } });
  const box = { athlete_id: '7', team_id: '4', minutes: 34, fgm: 9, fga: 18, tpm: 3, tpa: 7, ftm: 4, fta: 5, reb: 11, ast: 6, pts: 25, stl: 1, blk: 0 };
  const events = new Map([[bulls.eventId, event({ players: [box] })]]);
  assert.deepEqual(settleDailyPick(prop('pts', 'over', 24.5), new Map(), events, now), { outcome: 'win', actual: 25, units: 0.8696, settled_at: '2026-11-26T05:00:00Z' });
  // Points, rebounds and assists add to 42.
  assert.equal(settleDailyPick(prop('pra', 'under', 42.5), new Map(), events, now)?.outcome, 'win');
  assert.equal(settleDailyPick(prop('pra', 'under', 41.5), new Map(), events, now)?.outcome, 'loss');
  assert.equal(settleDailyPick(prop('pra', 'over', 42), new Map(), events, now)?.outcome, 'push');
  assert.equal(settleDailyPick(prop('dd', 'over', 0.5), new Map(), events, now)?.outcome, 'win');
  assert.equal(settleDailyPick(prop('td', 'over', 0.5), new Map(), events, now)?.outcome, 'loss');
  // A spread's final alone cannot settle a prop.
  assert.equal(settleDailyPick(prop('pts', 'over', 24.5), new Map([[bulls.eventId, { home: 1, away: 0 }]]), new Map(), now), null);
  const sat = new Map([[bulls.eventId, event({ players: [{ ...box, minutes: 0 }] })]]);
  assert.deepEqual(settleDailyPick(prop('pts', 'over', 24.5), new Map(), sat, now), { outcome: 'void', reason: 'dnp', units: 0, settled_at: '2026-11-26T05:00:00Z' });
  assert.equal(settleDailyPick(prop('pts', 'over', 24.5), new Map(), new Map([[bulls.eventId, event()]]), now)?.reason, 'dnp');
});

test('the record counts every posted pick by category, and graded picks are never graded again', () => {
  const day: DailyLedgerDay = { ...emptyDay(date), picks: [spreadPick(), spreadPick({ eventId: wolves.eventId, settle: wolves.settle! }), spreadPick({ category: 'prop', eventId: '9', settle: { kind: 'prop', athlete_id: '7', market: 'pts', side: 'over', line: 1.5 } })] };
  const finals = new Map([[bulls.eventId, { home: 110, away: 108 }], [wolves.eventId, { home: 120, away: 100 }]]);
  assert.equal(settleDailyPicks([day], finals, new Map(), now), 2);
  assert.equal(settleDailyPicks([day], new Map([[bulls.eventId, { home: 140, away: 100 }]]), new Map(), now), 0);
  const record = dailyRecord([day, { ...emptyDay('2026-11-24'), picks: [] }]);
  assert.deepEqual(record.spread, { picks: 2, wins: 1, losses: 1, pushes: 0, voids: 0, pending: 0, units: -0.1304, from: date });
  assert.deepEqual(record.prop, { picks: 1, wins: 0, losses: 0, pushes: 0, voids: 0, pending: 1, units: 0, from: date });
  // Each line starts on its own first pick: a category with none has no start.
  assert.equal(dailyRecord([{ ...emptyDay(date), picks: [spreadPick()] }]).prop.from, null);
  assert.equal(record.all.picks, 3);
  assert.equal(record.from, date);
});

test('a ledger day round-trips one pick a line, and malformed picks or files are refused', () => {
  const day: DailyLedgerDay = { ...emptyDay(date), picks: [spreadPick({ result: { outcome: 'win', actual: 2, units: 0.8696, settled_at: '2026-11-26T05:00:00Z' } }), spreadPick({ eventId: '2' })] };
  const text = serializeDailyDay(day);
  assert.equal(text.split('\n').length, 5);
  assert.deepEqual(parseDailyDay(text), day);
  assert.equal(parseDailyDay(text.replace('"odds":-115', '"odds":-50')), null);
  assert.equal(parseDailyDay(text.replace('"category":"spread"', '"category":"prop"')), null, 'a pick must settle as its category');
  assert.equal(parseDailyDay('{"schema_version":1,"date":"2026-11-25"}'), null);
  const file = dailyFile(new Map([[date, day]]), ['2026-11-24', date], now);
  const parsed = parseDailyFile(JSON.stringify(file))!;
  assert.equal(parsed.picks.length, 2);
  assert.deepEqual(parsed.record, file.record);
  assert.equal(parseDailyFile(JSON.stringify({ ...file, picks: [...file.picks, { title: 'broken' }] }))?.picks.length, 2);
  assert.equal(parseDailyFile(JSON.stringify({ ...file, record: { ...file.record, all: null } })), null);
  assert.equal(parseDailyFile('not json'), null);
});

const quote: SpreadQuote = { source: 'ESPN scoreboard', book: 'DraftKings', captured_at: '2026-11-25T22:00:00Z', home_spread: -3.5, home_odds: -110, away_odds: -110 };

test('each tab shows its own picks together with where each stands, yesterday\'s results, and why it is empty', () => {
  const posted = [spreadPick(), spreadPick({ eventId: wolves.eventId, tip: wolves.tip, title: wolves.title, posted_at: '2026-11-26T00:00:00Z', settle: wolves.settle! }),
    spreadPick({ date: '2026-11-24', eventId: '1', tip: '2026-11-25T01:00:00Z', result: { outcome: 'loss', actual: 9, units: -1, settled_at: '2026-11-25T06:00:00Z' } })];
  const file = dailyFile(new Map([[date, { ...emptyDay(date), picks: posted.slice(0, 2) }], ['2026-11-24', { ...emptyDay('2026-11-24'), picks: posted.slice(2) }]]), ['2026-11-24', date], now);
  const game = (id: string, start: string) => ({ event_id: id, date, start_time: start, status_state: 'pre', completed: false, spread_quotes: [quote] }) as unknown as Slate['games'][number];
  const slate = { schema_version: 1, generated_at: '2026-11-25T22:00:00Z', date, timezone: 'America/Chicago', games: [game(bulls.eventId, bulls.tip), game(wolves.eventId, wolves.tip), game('9', '2026-11-26T03:00:00Z')] } as unknown as Slate;
  const games = (time: string) => dailyPanelState(file, slate, null, new Date(time), 'spread');
  const projections = (time: string) => dailyPanelState(file, slate, null, new Date(time), 'prop');

  // Games: the team bets, with the spread record.
  const evening = games('2026-11-26T00:10:00Z');
  assert.equal(evening.category, 'spread');
  assert.deepEqual(evening.today.map((pick) => [pick.title, pick.state]), [['Chicago Bulls +3.5', 'live'], ['Minnesota Timberwolves +2.5', 'open']]);
  assert.deepEqual(evening.yesterday.map((pick) => pick.state), ['loss']);
  assert.deepEqual(evening.notes, []);
  assert.deepEqual(evening.record, file.record.spread);
  // Once the Wolves tip too, Games says a spread may still follow for the last game.
  assert.deepEqual(games('2026-11-26T00:40:00Z').notes, ['The next spread posts at the next update if a game still to tip clears the checks.']);
  assert.deepEqual(games('2026-11-26T03:10:00Z').notes, [], 'no notes once every game has tipped');

  // Projections: only the player props and their record, so none of the spreads above.
  const props = projections('2026-11-26T00:10:00Z');
  assert.deepEqual([props.today, props.yesterday, props.record], [[], [], file.record.prop]);
  assert.deepEqual(props.notes, ['No current player prop price for today’s remaining games.']);
  const lines = { '9': [['1', 'pts', 15.5, -110, -110, '2026-11-25T22:00:00Z']] } as never;
  assert.deepEqual(dailyPanelState(file, slate, { lines }, new Date('2026-11-26T00:10:00Z'), 'prop').notes, ['No player prop has cleared the model’s price, noise and data checks yet today.']);
  assert.deepEqual(projections('2026-11-26T03:10:00Z').notes, []);

  assert.equal(pickState(posted[0], new Date('2026-11-26T03:00:01Z')), 'awaiting');
  assert.deepEqual(dailyPanelState(null, slate, null, now, 'prop'), { status: 'unavailable', category: 'prop', record: null, today: [], yesterday: [], notes: [] });
});

test('the refresh step posts, grades and publishes, draws only what it could post, and leaves an idle file alone', () => {
  const fixture = 'tests/fixtures/generation-2026-11-02';
  const card = JSON.parse(readFileSync(join(fixture, 'rate-card.json'), 'utf8')) as RateCard;
  const fixtureSlate = JSON.parse(readFileSync(join(fixture, 'slate.json'), 'utf8')) as Slate;
  const today = '2026-11-02';
  const clock = new Date('2026-11-02T22:30:00Z');
  const games = fixtureSlate.games.filter((game) => card.games.some((rate) => rate.event_id === game.event_id)).slice(0, 2)
    .map((game, index) => ({ ...game, date: today, status_state: 'pre', completed: false, start_time: `2026-11-03T0${index}:00:00Z`, spread_quotes: [{ ...quote, captured_at: '2026-11-02T22:15:00Z', home_spread: -3 }] }));
  const slate = { ...fixtureSlate, date: today, games };
  const pregame = { ...card, generated_at: '2026-11-02T22:00:00Z' };
  const drawn: string[] = [];
  const margins = [...Array(550).fill(5), ...Array(400).fill(2), ...Array(50).fill(3)];
  const draw = (rate: { event_id: string }) => {
    drawn.push(rate.event_id);
    return { margins, awayTotals: [], homeTotals: [], playerDraws: new Map() } as never;
  };
  const days = new Map<string, DailyLedgerDay>();
  const first = buildDaily({ slate, card: pregame, picks: null, calibration: null, events: new Map(), finals: new Map(), days, now: clock, draw });
  assert.equal(first.posted.length, 1);
  assert.equal(first.posted[0].category, 'spread');
  assert.equal(first.posted[0].eventId, games[0].event_id, 'equal offers go to the earlier tip');
  assert.deepEqual(first.changed, [today]);
  assert.deepEqual(drawn, games.map((game) => game.event_id));
  // The spread is open, so the next run draws games only to look for a prop.
  drawn.length = 0;
  const second = buildDaily({ slate, card: pregame, picks: null, calibration: null, events: new Map(), finals: new Map(), days, now: new Date('2026-11-02T23:00:00Z'), draw });
  assert.deepEqual([second.posted.length, second.changed.length], [0, 0]);
  assert.equal(drawn.length, 2);
  // After both tips and the finals, the day is graded and published with its record.
  const finals = new Map(games.map((game) => [game.event_id, { home: 105, away: 100 }]));
  const late = buildDaily({ slate: { ...slate, games: games.map((game) => ({ ...game, status_state: 'post', completed: true })) }, card: pregame, picks: null, calibration: null,
    events: new Map(), finals, days, now: new Date('2026-11-03T06:00:00Z'), draw });
  assert.equal(late.settled, 1);
  assert.equal(late.file.record.spread.wins, 1);
  assert.deepEqual(late.file.picks.map((pick) => pick.result?.outcome), ['win']);
  const text = publishedText(late.file, null)!;
  assert.equal(publishedText({ ...late.file, built_at: '2026-11-03T07:00:00Z' }, text), null, 'an idle run does not rewrite the file');
  assert.ok(publishedText({ ...late.file, picks: [] }, text));
  assert.deepEqual(pendingSpreadDates(days.values(), new Date('2026-11-03T06:00:00Z')), []);
});

test('scoreboard finals come only from completed games, and a malformed ledger file stops the run', () => {
  const competitors = (home: unknown, away: unknown) => [{ homeAway: 'home', score: home }, { homeAway: 'away', score: away }];
  const board = { events: [
    { id: '1', competitions: [{ status: { type: { state: 'post', completed: true } }, competitors: competitors('112', '108') }] },
    { id: '2', competitions: [{ status: { type: { state: 'post', completed: true } }, competitors: competitors({ value: 99 }, { value: 101 }) }] },
    { id: '3', competitions: [{ status: { type: { state: 'in', completed: false } }, competitors: competitors('50', '48') }] },
    { id: '4', competitions: [{ status: { type: { state: 'post', completed: false } }, competitors: competitors('0', '0') }] },
    { id: '5', competitions: [{ status: { type: { state: 'post', completed: true } }, competitors: competitors('', '90') }] },
  ] };
  assert.deepEqual([...finalsFromScoreboard(board)], [['1', { home: 112, away: 108 }], ['2', { home: 99, away: 101 }]]);
  assert.deepEqual([...finalsFromScoreboard(null)], []);
  const dir = mkdtempSync(join(tmpdir(), 'daily-ledger-'));
  try {
    mkdirSync(join(dir, 'days'));
    writeFileSync(join(dir, 'days', `${date}.json`), serializeDailyDay({ ...emptyDay(date), picks: [spreadPick()] }));
    assert.equal(readDays(join(dir, 'days')).get(date)?.picks.length, 1);
    assert.deepEqual(pendingSpreadDates(readDays(join(dir, 'days')).values(), now), [date]);
    writeFileSync(join(dir, 'days', '2026-11-26.json'), '{"schema_version":1,"date":"2026-11-26","picks":[{}]}');
    assert.throws(() => readDays(join(dir, 'days')), /Invalid daily ledger file 2026-11-26.json/);
    assert.equal(readDays(join(dir, 'missing')).size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
