import type { DailyCategory, DailyPanelPick, DailyPanelState, DailyRecordLine } from './daily-ledger.ts';
import type { DailyGrade } from './daily-price.ts';
import { formatTip } from './date.ts';
import { escapeHtml } from './slate.ts';

const percent = (value: number) => (value * 100).toFixed(1) + '%';

function timeTag(iso: string): string {
  return `<time datetime="${escapeHtml(iso)}">${escapeHtml(formatTip(iso))}</time>`;
}

const GRADE_LABEL: Readonly<Record<DailyGrade, string>> = { BET: 'Qualified bet', LEAN: 'Model lean', EDGE: 'Unproven edge' };
const CATEGORY_LABEL = { prop: 'Player prop', spread: 'Game spread' } as const;

/** Games carries the team bets (game spreads); Projections carries the player props. */
const PANEL: Readonly<Record<DailyCategory, { title: string; first: string; intro: string; none: string; waiting: string }>> = {
  spread: {
    title: 'NBA team bets of the day',
    first: 'The record starts with the first posted team bet.',
    intro: 'Each pick is the strongest game spread left on the slate, read from the same 10,000 simulations as the box scores at the best tracked price. It is posted once, at the line and price shown, and stays up until its game tips; then the next game’s best spread is posted. Every posted pick counts in the record. Player props are on Projections.',
    none: 'No team bets were posted today.',
    waiting: 'Today’s team bets and their record are awaiting publication.',
  },
  prop: {
    title: 'NBA player prop bets of the day',
    first: 'The record starts with the first posted player prop.',
    intro: 'Each pick is the strongest player prop left on the slate, read from the same 10,000 simulations as the box scores at the best tracked price. It is posted once, at the line and price shown, and stays up until its game tips; then the next game’s best prop is posted. Every posted pick counts in the record. Team bets are on Games.',
    none: 'No player props were posted today.',
    waiting: 'Today’s player props and their record are awaiting publication.',
  },
};

export function formatUnits(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${Math.abs(value).toFixed(2)}u`;
}

function tally(line: DailyRecordLine): string {
  return `${line.wins}–${line.losses}${line.pushes ? `–${line.pushes}` : ''}`;
}

function monthDay(date: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(`${date}T12:00:00Z`));
}

function recordHtml(line: DailyRecordLine | null, category: DailyCategory): string {
  if (!line || !line.picks) return `<p class="daily-record">${PANEL[category].first}</p>`;
  const extra = [
    `${line.picks} posted`,
    line.pushes ? `${line.pushes} push${line.pushes === 1 ? '' : 'es'}` : '',
    line.voids ? `${line.voids} void` : '',
    line.pending ? `${line.pending} pending` : '',
    line.from ? `since ${escapeHtml(monthDay(line.from))}` : '',
  ].filter(Boolean).join(' · ');
  return `<div class="daily-record" aria-label="Record of every posted ${category === 'prop' ? 'player prop' : 'team bet'}">
    <p class="daily-record-main"><span class="daily-record-label">Record</span> <strong data-record-tally>${tally(line)}</strong> <span class="daily-record-units" data-units="${line.units > 0 ? 'up' : line.units < 0 ? 'down' : 'flat'}">${formatUnits(line.units)}</span></p>
    <p class="daily-record-sub">${extra}</p>
  </div>`;
}

function statusText(pick: DailyPanelPick): string {
  const result = pick.result;
  if (pick.state === 'open') return 'Open';
  if (pick.state === 'live') return 'In progress';
  if (pick.state === 'awaiting' || !result) return 'Awaiting final';
  if (result.outcome === 'win') return `Won ${formatUnits(result.units)}`;
  if (result.outcome === 'loss') return `Lost ${formatUnits(result.units)}`;
  if (result.outcome === 'push') return 'Push';
  return result.reason === 'dnp' ? 'Void · did not play' : 'Void · no result';
}

function resultDetail(pick: DailyPanelPick): string {
  const actual = pick.result?.actual;
  if (actual === undefined) return '';
  const settle = pick.settle;
  if (settle.kind === 'spread') {
    const margin = actual === 0 ? 'Final: tied' : `Final: ${escapeHtml(actual > 0 ? settle.home : settle.away)} by ${Math.abs(actual)}`;
    return `<p class="daily-result">${margin}</p>`;
  }
  const value = settle.market === 'dd' || settle.market === 'td' ? (actual >= 1 ? 'yes' : 'no') : String(actual);
  return `<p class="daily-result">Final: ${escapeHtml(value)}</p>`;
}

function priceText(pick: DailyPanelPick): string {
  return `<strong>${pick.odds > 0 ? '+' + pick.odds : String(pick.odds)}</strong> at ${escapeHtml(pick.book)}`;
}

function pickCard(pick: DailyPanelPick): string {
  const head = `<header><h4>${CATEGORY_LABEL[pick.category]}</h4><span class="daily-grade" data-grade="${pick.grade}">${GRADE_LABEL[pick.grade]}</span><span class="daily-status" data-state="${pick.state}">${escapeHtml(statusText(pick))}</span></header>`;
  const posted = `<p class="daily-stamp">Posted ${timeTag(pick.posted_at)} · price checked ${timeTag(pick.pricedAt)}</p>`;
  if (pick.state !== 'open') {
    return `<article class="daily-offer daily-offer-compact" data-grade="${pick.grade}" data-state="${pick.state}">
    ${head}
    <p class="daily-selection">${escapeHtml(pick.title)}</p>
    <p class="daily-price">${priceText(pick)}</p>
    <p class="daily-match">${escapeHtml(pick.matchup)} · Tipped ${timeTag(pick.tip)}</p>
    ${resultDetail(pick)}
    ${posted}
  </article>`;
  }
  return `<article class="daily-offer" data-grade="${pick.grade}" data-state="open">
    ${head}
    <p class="daily-selection">${escapeHtml(pick.title)}</p>
    <p class="daily-price">${priceText(pick)}</p>
    <p class="daily-match">${escapeHtml(pick.matchup)} · Tips ${timeTag(pick.tip)}</p>
    <p class="daily-projection">${escapeHtml(pick.projectionLabel)}</p>
    <dl class="daily-metrics">
      <div><dt>Model win chance</dt><dd>${percent(pick.modelProbability)}</dd></div>
      <div><dt>Break-even</dt><dd>${percent(pick.breakEven)}</dd></div>
      <div><dt>Est. net return</dt><dd>+${percent(pick.expectedReturn)}</dd></div>
    </dl>
    ${pick.evidence ? `<p class="daily-evidence">${escapeHtml(pick.evidence)}</p>` : ''}
    ${posted}
  </article>`;
}

export function renderDailyPanel(state: DailyPanelState): string {
  const panel = PANEL[state.category];
  if (state.status === 'unavailable') {
    return `<section class="daily-picks" data-category="${state.category}" aria-labelledby="daily-picks-title">
    <h2 id="daily-picks-title">${panel.title}</h2><p class="daily-intro">${panel.waiting}</p>
  </section>`;
  }
  const shown = [...state.today, ...state.yesterday];
  const unproven = shown.some((pick) => pick.grade === 'EDGE')
    ? ' An unproven edge clears the price, noise and data checks, but leans like it have not beaten the posted price in live grading.'
    : '';
  const notes = state.notes.map((note) => `<p class="daily-empty">${escapeHtml(note)}</p>`).join('');
  const today = state.today.length ? `<div class="daily-offers">${state.today.map(pickCard).join('')}</div>` : '';
  const todayEmpty = !state.today.length && !state.notes.length ? `<p class="daily-empty">${panel.none}</p>` : '';
  const yesterday = state.yesterday.length
    ? `<h3 class="daily-day">Yesterday</h3><div class="daily-offers">${state.yesterday.map(pickCard).join('')}</div>`
    : '';
  return `<section class="daily-picks" data-category="${state.category}" aria-labelledby="daily-picks-title">
    <header class="daily-head"><h2 id="daily-picks-title">${panel.title}</h2>${recordHtml(state.record, state.category)}</header>
    <p class="daily-intro">${panel.intro}</p>
    <h3 class="daily-day">Today</h3>${today}${notes}${todayEmpty}
    ${yesterday}
    ${shown.length ? `<p class="daily-note">No pick is a sure thing: a lean can lose, and leans have limited validation.${unproven} Win chance and break-even exclude pushes and voids; estimated net return includes them. The record grades each pick at its posted line and price, one unit each.</p>` : ''}
  </section>`;
}
