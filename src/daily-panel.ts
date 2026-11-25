import type { DailyOffer, DailyPanelState } from './daily-price.ts';
import { formatTip } from './date.ts';
import { escapeHtml } from './slate.ts';

const percent = (value: number) => (value * 100).toFixed(1) + '%';

function timeTag(iso: string): string {
  return `<time datetime="${escapeHtml(iso)}">${escapeHtml(formatTip(iso))}</time>`;
}

const NO_OFFER = 'No tracked offer currently clears the model’s price and evidence checks.';

function offerCard(label: string, offer: DailyOffer | null, note: string | undefined): string {
  if (!offer) {
    return `<article class="daily-offer daily-offer-empty"><h3>${label}</h3><p>${escapeHtml(note ?? NO_OFFER)}</p></article>`;
  }
  const grade = offer.grade === 'BET' ? 'Qualified bet' : 'Model lean';
  const odds = offer.odds > 0 ? '+' + offer.odds : String(offer.odds);
  return `<article class="daily-offer">
    <header><h3>${label}</h3><span class="daily-grade" data-grade="${offer.grade}">${grade}</span></header>
    <p class="daily-selection">${escapeHtml(offer.title)}</p>
    <p class="daily-price"><strong>${odds}</strong> at ${escapeHtml(offer.book)}</p>
    <p class="daily-match">${escapeHtml(offer.matchup)} · Tips ${timeTag(offer.tip)}</p>
    <p class="daily-projection">${escapeHtml(offer.projectionLabel)}</p>
    <dl class="daily-metrics">
      <div><dt>Model win chance</dt><dd>${percent(offer.modelProbability)}</dd></div>
      <div><dt>Break-even</dt><dd>${percent(offer.breakEven)}</dd></div>
      <div><dt>Est. net return</dt><dd>+${percent(offer.expectedReturn)}</dd></div>
    </dl>
    ${offer.evidence ? `<p class="daily-evidence">${escapeHtml(offer.evidence)}</p>` : ''}
    <p class="daily-stamp">Price checked ${timeTag(offer.pricedAt)}</p>
  </article>`;
}

const stateCopy = {
  finished: 'No upcoming NBA games remain on today’s slate.',
  unavailable: 'Today’s player prop and spread comparisons are awaiting publication.',
  stale: 'The NBA slate needs a fresh update before daily picks can be shown.',
};

export function renderDailyPanel(state: DailyPanelState): string {
  const hasOffer = state.prop !== null || state.spread !== null;
  const content = state.status === 'open'
    ? `<p class="daily-intro">The strongest player prop and spread left on today’s slate, read from the same 10,000 simulations as the box scores and taken at the best tracked pregame price. Each has to clear the model’s price, noise and evidence checks.</p>
      <div class="daily-offers">${offerCard('Player prop', state.prop, state.propNote)}${offerCard('Game spread', state.spread, state.spreadNote)}</div>
      ${hasOffer ? '<p class="daily-note">No pick is a sure thing: a lean can lose, and leans have limited validation. Win chance and break-even exclude pushes and voids; estimated net return includes them. Prices move, so check the line at the book before betting.</p>' : ''}`
    : `<p class="daily-intro">${stateCopy[state.status]}</p>`;
  return `<section class="daily-picks" aria-labelledby="daily-picks-title">
    <h2 id="daily-picks-title">NBA bets of the day</h2>${content}
  </section>`;
}
