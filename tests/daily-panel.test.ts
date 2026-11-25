import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { renderDailyPanel } from '../src/daily-panel.ts';
import type { DailyOffer } from '../src/daily-price.ts';

const offer: DailyOffer = {
  eventId: '12', title: 'Guard <Test> over 16.5 points', matchup: 'BOS at CHI', projectionLabel: 'Model projection 18.2 points',
  tip: '2026-11-25T01:00:00Z', pricedAt: '2026-11-24T23:30:00Z', book: 'Book & Co', odds: 120,
  modelProbability: 0.57, breakEven: 1 / 2.2, expectedReturn: 0.254, grade: 'LEAN',
};

test('daily cards display the picked line, book, price, model and implied chances with Chicago tip and quote times', () => {
  const spread: DailyOffer = { ...offer, title: 'Chicago Bulls +3.5', projectionLabel: 'Model spread CHI +1.0', odds: -110, grade: 'BET' };
  const { document } = parseHTML(renderDailyPanel({ status: 'open', prop: offer, spread }));
  const [prop, game] = [...document.querySelectorAll('article')];
  assert.equal(prop.querySelector('.daily-selection')?.textContent, offer.title);
  assert.equal(prop.querySelector('.daily-selection test'), null);
  assert.equal(prop.querySelector('.daily-price')?.textContent, '+120 at Book & Co');
  assert.equal(game.querySelector('.daily-price strong')?.textContent, '-110');
  assert.equal(prop.querySelector('.daily-grade')?.textContent, 'Model lean');
  assert.equal(game.querySelector('.daily-grade')?.textContent, 'Qualified bet');
  assert.equal(prop.querySelector('.daily-projection')?.textContent, offer.projectionLabel);
  assert.deepEqual([...prop.querySelectorAll('dd')].map(el => el.textContent), ['57.0%', '45.5%', '+25.4%']);
  assert.match(prop.querySelector('.daily-stamp')?.textContent ?? '', /Nov 24.*5:30 PM CST/);
  assert.match(prop.querySelector('.daily-match')?.textContent ?? '', /BOS at CHI.*Nov 24.*7:00 PM CST/);
  assert.equal(prop.querySelector('.daily-stamp time')?.getAttribute('datetime'), offer.pricedAt);
});

test('an empty category or unavailable slate cannot display an actionable price', () => {
  const { document } = parseHTML(renderDailyPanel({ status: 'open', prop: null, spread: offer }));
  assert.equal(document.querySelectorAll('.daily-price').length, 1);
  assert.match(document.querySelector('.daily-offer-empty')?.textContent ?? '', /Player prop.*No tracked offer/);
  for (const [status, reason] of [
    ['stale', 'fresh update'], ['finished', 'No upcoming NBA games'], ['unavailable', 'awaiting publication'],
  ] as const) {
    const html = renderDailyPanel({ status, prop: offer, spread: offer });
    assert.ok(html.includes(reason));
    assert.ok(!html.includes('+120'));
  }
});

test('each pick shows what its grade rests on, and an empty category shows why it is empty', () => {
  const { document } = parseHTML(renderDailyPanel({
    status: 'open', prop: null, spread: { ...offer, evidence: 'Spread leans are not graded <yet>.' },
    propNote: 'Live-graded prop leans have settled short of the posted price at every strength (6,167 graded since Nov 15), so none qualifies yet.',
  }));
  assert.equal(document.querySelector('.daily-offer-empty p')?.textContent,
    'Live-graded prop leans have settled short of the posted price at every strength (6,167 graded since Nov 15), so none qualifies yet.');
  assert.equal(document.querySelector('.daily-evidence')?.textContent, 'Spread leans are not graded <yet>.');
  assert.match(document.querySelector('.daily-note')?.textContent ?? '', /No pick is a sure thing/);
  const none = parseHTML(renderDailyPanel({ status: 'open', prop: null, spread: null, propNote: 'a', spreadNote: 'b' })).document;
  assert.deepEqual([...none.querySelectorAll('.daily-offer-empty p')].map(el => el.textContent), ['a', 'b']);
  assert.equal(none.querySelector('.daily-note'), null);
  assert.equal(none.querySelector('.daily-evidence'), null);
});
