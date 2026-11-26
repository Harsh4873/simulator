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
const state = (changes: Partial<DailyPanelState> = {}): DailyPanelState => ({
  status: 'open', record: dailyRecord([{ ...emptyDay('2026-11-25'), picks: [spread, prop] }]), today: [], yesterday: [], notes: [], ...changes,
});

test('an open pick shows its line, book, price, chances, evidence and the times it was posted and priced', () => {
  const { document } = parseHTML(renderDailyPanel(state({ today: [at(prop, 'open')] })));
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
});

test('every pick posted today is shown together, each with where it stands, and the record heads the panel', () => {
  const graded = { ...spread, result: { outcome: 'win' as const, actual: -2, units: 0.8696, settled_at: '2026-11-26T03:00:00Z' } };
  const { document } = parseHTML(renderDailyPanel(state({ today: [at(graded, 'win'), at(prop, 'live')] })));
  const cards = [...document.querySelectorAll('article.daily-offer')];
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map((card) => card.querySelector('.daily-status')?.textContent), ['Won +0.87u', 'In progress']);
  assert.equal(cards[0].querySelector('.daily-selection')?.textContent, 'Chicago Bulls <+3.5>');
  assert.equal(cards[0].querySelector('.daily-selection test'), null);
  assert.equal(cards[0].querySelector('.daily-result')?.textContent, 'Final: CHI by 2');
  assert.ok(cards.every((card) => card.classList.contains('daily-offer-compact')), 'a started pick no longer shows its pregame metrics');
  assert.equal(document.querySelector('[data-record-tally]')?.textContent, '0–0');
  assert.match(document.querySelector('.daily-record-sub')?.textContent ?? '', /Spreads 0–0 · Props 0–0 · 2 pending · since Nov 25/);
});

test('the record counts wins, losses, pushes and units, and yesterday keeps its results under its own heading', () => {
  const won = { ...spread, result: { outcome: 'win' as const, actual: -2, units: 0.8696, settled_at: '2026-11-26T03:00:00Z' } };
  const lost = { ...prop, result: { outcome: 'loss' as const, actual: 12, units: -1, settled_at: '2026-11-26T03:00:00Z' } };
  const pushed = { ...spread, eventId: '3', result: { outcome: 'push' as const, actual: 3.5 * 0, units: 0, settled_at: '2026-11-26T03:00:00Z' } };
  const voided = { ...prop, eventId: '4', result: { outcome: 'void' as const, reason: 'dnp' as const, units: 0, settled_at: '2026-11-26T03:00:00Z' } };
  const record = dailyRecord([{ ...emptyDay('2026-11-25'), picks: [won, lost, pushed, voided] }]);
  const { document } = parseHTML(renderDailyPanel(state({ record, yesterday: [at(won, 'win'), at(lost, 'loss'), at(pushed, 'push'), at(voided, 'void')] })));
  assert.equal(document.querySelector('[data-record-tally]')?.textContent, '1–1–1');
  assert.equal(document.querySelector('.daily-record-units')?.textContent, '−0.13u');
  assert.equal(document.querySelector('.daily-record-units')?.getAttribute('data-units'), 'down');
  assert.match(document.querySelector('.daily-record-sub')?.textContent ?? '', /Spreads 1–0–1 · Props 0–1 · 1 push · 1 void · since Nov 25/);
  const headings = [...document.querySelectorAll('.daily-day')].map((el) => el.textContent);
  assert.deepEqual(headings, ['Today', 'Yesterday']);
  assert.deepEqual([...document.querySelectorAll('.daily-status')].map((el) => el.textContent), ['Won +0.87u', 'Lost −1.00u', 'Push', 'Void · did not play']);
  assert.equal(document.querySelectorAll('.daily-result')[1]?.textContent, 'Final: 12');
  assert.match(document.querySelector('.daily-empty')?.textContent ?? '', /No NBA bets of the day were posted today/);
  assert.equal(formatUnits(0), '0.00u');
  assert.equal(formatUnits(1.2), '+1.20u');
});

test('notes say why a category has no pick, and an unproven edge is explained whenever one is shown', () => {
  const { document } = parseHTML(renderDailyPanel(state({
    today: [at(spread, 'open')], notes: ['No player prop has cleared the model’s price, noise and data checks yet today.'],
  })));
  assert.equal(document.querySelector('.daily-offer[data-grade="EDGE"] .daily-grade')?.textContent, 'Unproven edge');
  assert.equal(document.querySelector('.daily-evidence')?.textContent, spread.evidence);
  assert.equal(document.querySelector('.daily-empty')?.textContent, 'No player prop has cleared the model’s price, noise and data checks yet today.');
  assert.match(document.querySelector('.daily-note')?.textContent ?? '', /An unproven edge clears the price, noise and data checks/);
  assert.match(document.querySelector('.daily-note')?.textContent ?? '', /grades each pick at its posted line and price, one unit each/);
  const lean = parseHTML(renderDailyPanel(state({ today: [at(prop, 'open')] }))).document;
  assert.doesNotMatch(lean.querySelector('.daily-note')?.textContent ?? '', /unproven/i);
  const none = parseHTML(renderDailyPanel({ status: 'unavailable', record: null, today: [], yesterday: [], notes: [] })).document;
  assert.match(none.querySelector('.daily-intro')?.textContent ?? '', /awaiting publication/);
  assert.equal(none.querySelector('.daily-offer'), null);
  const fresh = parseHTML(renderDailyPanel(state({ record: dailyRecord([]) }))).document;
  assert.equal(fresh.querySelector('.daily-record')?.textContent, 'The record starts with the first posted pick.');
});
