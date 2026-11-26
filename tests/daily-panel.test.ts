import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { renderDailyPanel, formatUnits } from '../src/daily-panel.ts';
import { dailyRecord, emptyDay, type DailyPanelPick, type DailyPanelState, type PostedDailyPick } from '../src/daily-ledger.ts';

const spread: PostedDailyPick = {
  category: 'spread', date: '2026-11-25', posted_at: '2026-11-25T06:05:00Z',
  eventId: '401909318', title: 'Chicago Bulls <+3.5>', matchup: 'CHI at CHA', projectionLabel: 'Model spread CHI +1.0',
  tip: '2026-11-26T00:00:00Z', pricedAt: '2026-11-25T06:05:00Z', book: 'Book & Co', odds: -115,
  modelProbability: 0.627, breakEven: 115 / 215, expectedReturn: 0.172, grade: 'EDGE',
  evidence: 'Not a qualified pick: spread leans are not graded against results yet.',
  settle: { kind: 'spread', side: 'away', home_spread: -3.5, home: 'CHA', away: 'CHI' },
};
const prop: PostedDailyPick = {
  ...spread, category: 'prop', eventId: '401909320', title: 'Guard Name Over 16.5 points', matchup: 'MIN at OKC',
  projectionLabel: 'Model projection 18.2 points', tip: '2026-11-26T00:30:00Z', odds: 120, breakEven: 1 / 2.2, modelProbability: 0.57,
  expectedReturn: 0.254, grade: 'LEAN', evidence: undefined, settle: { kind: 'prop', athlete_id: '7', market: 'pts', side: 'over', line: 16.5 },
};
const at = (pick: PostedDailyPick, state: DailyPanelPick['state']): DailyPanelPick => ({ ...pick, state });
const record = (...picks: PostedDailyPick[]) => dailyRecord([{ ...emptyDay('2026-11-25'), picks }]);
const settled = (outcome: 'win' | 'loss' | 'push' | 'void', units: number, actual?: number) =>
  ({ outcome, units, settled_at: '2026-11-26T05:00:00Z', ...(actual === undefined ? { reason: 'no result' as const } : { actual }) });
const state = (changes: Partial<DailyPanelState> = {}): DailyPanelState => ({
  status: 'open', category: 'spread', record: record(spread, prop).spread, today: [], yesterday: [], notes: [], ...changes,
});

test('Games carries the team bets and Projections the player props, each under its own title and record', () => {
  const games = parseHTML(renderDailyPanel(state({ today: [at(spread, 'open')] }))).document;
  assert.equal(games.querySelector('section.daily-picks')?.getAttribute('data-category'), 'spread');
  assert.equal(games.querySelector('h2')?.textContent, 'NBA team bets of the day');
  assert.match(games.querySelector('.daily-intro')?.textContent ?? '', /strongest game spread left on the slate.*Player props are on Projections\.$/);
  const props = parseHTML(renderDailyPanel(state({ category: 'prop', record: record(spread, prop).prop, today: [at(prop, 'open')] }))).document;
  assert.equal(props.querySelector('section.daily-picks')?.getAttribute('data-category'), 'prop');
  assert.equal(props.querySelector('h2')?.textContent, 'NBA player prop bets of the day');
  assert.match(props.querySelector('.daily-intro')?.textContent ?? '', /strongest player prop left on the slate.*Team bets are on Games\.$/);
  for (const [category, first] of [['spread', 'team bet'], ['prop', 'player prop']] as const) {
    const empty = parseHTML(renderDailyPanel(state({ category, record: dailyRecord([])[category] }))).document;
    assert.equal(empty.querySelector('.daily-record')?.textContent, `The record starts with the first posted ${first}.`);
    assert.equal(empty.querySelector('.daily-empty')?.textContent, category === 'spread' ? 'No team bets were posted today.' : 'No player props were posted today.');
    const waiting = parseHTML(renderDailyPanel({ status: 'unavailable', category, record: null, today: [], yesterday: [], notes: [] })).document;
    assert.match(waiting.querySelector('.daily-intro')?.textContent ?? '', category === 'spread' ? /team bets and their record are awaiting publication/ : /player props and their record are awaiting publication/);
    assert.equal(waiting.querySelector('.daily-offer'), null);
  }
});

test('an open pick shows its line, book, price, chances, evidence and the times it was posted and priced', () => {
  const { document } = parseHTML(renderDailyPanel(state({ category: 'prop', record: record(prop).prop, today: [at(prop, 'open')] })));
  const card = document.querySelector('article.daily-offer[data-state="open"]')!;
  assert.equal(card.querySelector('h4')?.textContent, 'Player prop');
  assert.equal(card.querySelector('.daily-grade')?.textContent, 'Model lean');
  assert.equal(card.querySelector('.daily-status')?.textContent, 'Open');
  assert.equal(card.querySelector('.daily-selection')?.textContent, prop.title);
  assert.equal(card.querySelector('.daily-price')?.textContent, '+120 at Book & Co');
  assert.deepEqual([...card.querySelectorAll('dd')].map((el) => el.textContent), ['57.0%', '45.5%', '+25.4%']);
  assert.match(card.querySelector('.daily-match')?.textContent ?? '', /MIN at OKC · Tips .*6:30 PM CST/);
  assert.match(card.querySelector('.daily-stamp')?.textContent ?? '', /^Posted .*12:05 AM CST · price checked .*12:05 AM CST$/);
  assert.equal(card.querySelector('.daily-stamp time')?.getAttribute('datetime'), prop.posted_at);
  assert.equal(document.querySelector('[data-record-tally]')?.textContent, '0–0');
  assert.equal(document.querySelector('.daily-record-sub')?.textContent, '1 posted · 1 pending · since Nov 25');
});

test('every team bet posted today is shown together, each with where it stands', () => {
  const won = { ...spread, result: settled('win', 0.8696, -2) };
  const wolves = { ...spread, eventId: '401909320', title: 'Minnesota Timberwolves +2.5', tip: '2026-11-26T00:30:00Z', posted_at: '2026-11-26T00:00:00Z' };
  const { document } = parseHTML(renderDailyPanel(state({ record: record(won, wolves).spread, today: [at(won, 'win'), at(wolves, 'live')] })));
  const cards = [...document.querySelectorAll('article.daily-offer')];
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map((card) => card.querySelector('.daily-status')?.textContent), ['Won +0.87u', 'In progress']);
  assert.equal(cards[0].querySelector('.daily-selection')?.textContent, 'Chicago Bulls <+3.5>');
  assert.equal(cards[0].querySelector('.daily-selection test'), null);
  assert.equal(cards[0].querySelector('.daily-result')?.textContent, 'Final: CHI by 2');
  assert.ok(cards.every((card) => card.classList.contains('daily-offer-compact')), 'a started pick no longer shows its pregame metrics');
  assert.equal(document.querySelector('[data-record-tally]')?.textContent, '1–0');
  assert.equal(document.querySelector('.daily-record-units')?.textContent, '+0.87u');
  assert.equal(document.querySelector('.daily-record-sub')?.textContent, '2 posted · 1 pending · since Nov 25');
});

test('the record counts wins, losses, pushes and units, and yesterday keeps its results under its own heading', () => {
  const won = { ...spread, result: settled('win', 0.8696, -2) };
  const lost = { ...spread, eventId: '2', result: settled('loss', -1, 9) };
  const pushed = { ...spread, eventId: '3', title: 'Chicago Bulls +4', settle: { ...spread.settle, home_spread: -4 }, result: settled('push', 0, 4) };
  const unplayed = { ...spread, eventId: '4', result: settled('void', 0) };
  const { document } = parseHTML(renderDailyPanel(state({ record: record(won, lost, pushed, unplayed).spread,
    yesterday: [at(won, 'win'), at(lost, 'loss'), at(pushed, 'push'), at(unplayed, 'void')] })));
  assert.equal(document.querySelector('[data-record-tally]')?.textContent, '1–1–1');
  assert.equal(document.querySelector('.daily-record-units')?.textContent, '−0.13u');
  assert.equal(document.querySelector('.daily-record-units')?.getAttribute('data-units'), 'down');
  assert.equal(document.querySelector('.daily-record-sub')?.textContent, '4 posted · 1 push · 1 void · since Nov 25');
  assert.deepEqual([...document.querySelectorAll('.daily-day')].map((el) => el.textContent), ['Today', 'Yesterday']);
  assert.deepEqual([...document.querySelectorAll('.daily-status')].map((el) => el.textContent), ['Won +0.87u', 'Lost −1.00u', 'Push', 'Void · no result']);
  assert.deepEqual([...document.querySelectorAll('.daily-result')].map((el) => el.textContent), ['Final: CHI by 2', 'Final: CHA by 9', 'Final: CHA by 4']);
  assert.equal(document.querySelector('.daily-empty')?.textContent, 'No team bets were posted today.');
  const sat = { ...prop, result: { outcome: 'void' as const, reason: 'dnp' as const, units: 0, settled_at: '2026-11-26T05:00:00Z' } };
  const props = parseHTML(renderDailyPanel(state({ category: 'prop', record: record(sat).prop, yesterday: [at(sat, 'void')] }))).document;
  assert.equal(props.querySelector('.daily-status')?.textContent, 'Void · did not play');
  assert.equal(props.querySelector('[data-record-tally]')?.textContent, '0–0');
  assert.equal(formatUnits(0), '0.00u');
  assert.equal(formatUnits(1.2), '+1.20u');
});

test('notes say why a tab has no pick, and an unproven edge is explained whenever one is shown', () => {
  const { document } = parseHTML(renderDailyPanel(state({ today: [at(spread, 'open')] })));
  assert.equal(document.querySelector('.daily-offer[data-grade="EDGE"] .daily-grade')?.textContent, 'Unproven edge');
  assert.equal(document.querySelector('.daily-evidence')?.textContent, spread.evidence);
  assert.match(document.querySelector('.daily-note')?.textContent ?? '', /An unproven edge clears the price, noise and data checks/);
  assert.match(document.querySelector('.daily-note')?.textContent ?? '', /grades each pick at its posted line and price, one unit each/);
  const note = 'No player prop has cleared the model’s price, noise and data checks yet today.';
  const waiting = parseHTML(renderDailyPanel(state({ category: 'prop', record: dailyRecord([]).prop, notes: [note] }))).document;
  assert.deepEqual([...waiting.querySelectorAll('.daily-empty')].map((el) => el.textContent), [note]);
  assert.equal(waiting.querySelector('.daily-note'), null, 'no caveat without a pick');
  const lean = parseHTML(renderDailyPanel(state({ category: 'prop', today: [at(prop, 'open')] }))).document;
  assert.doesNotMatch(lean.querySelector('.daily-note')?.textContent ?? '', /unproven/i);
});

test('a thin edge and a top prop say what they are, and a negative return keeps its sign', () => {
  const thin = { ...prop, grade: 'THIN' as const, expectedReturn: 0.007, evidence: 'Below the edge bar: the calibrated chance of 45.0% clears the 44.6% break-even by 0.3 points, short of the 3.0 a lean needs.' };
  const top = { ...prop, eventId: '9', grade: 'TOP' as const, modelProbability: 0.384, breakEven: 0.386, expectedReturn: -0.0062, evidence: 'No edge at this price.' };
  const { document } = parseHTML(renderDailyPanel(state({ category: 'prop', record: record(thin, top).prop, today: [at(thin, 'open'), at(top, 'open')] })));
  const cards = [...document.querySelectorAll('article.daily-offer')];
  assert.deepEqual(cards.map((card) => card.querySelector('.daily-grade')?.textContent), ['Thin edge', 'Top prop · no edge']);
  assert.deepEqual(cards.map((card) => card.getAttribute('data-grade')), ['THIN', 'TOP']);
  assert.deepEqual(cards.map((card) => card.querySelectorAll('dd')[2]?.textContent), ['+0.7%', '−0.6%']);
  assert.match(document.querySelector('.daily-note')?.textContent ?? '', /posted only because nothing cleared the edge bar.*close to a coin flip with the vig against you/);
  assert.match(document.querySelector('.daily-intro')?.textContent ?? '', /When none clears the edge bar, the closest one is still posted and labelled thin edge or no edge/);
});
