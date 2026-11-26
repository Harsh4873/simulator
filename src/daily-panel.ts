import type { DailyPanelPick, DailyPanelState, DailyRecord, DailyRecordLine } from './daily-ledger.ts';
import type { DailyGrade } from './daily-price.ts';
import { formatTip } from './date.ts';
import { escapeHtml } from './slate.ts';

const percent = (value: number) => (value * 100).toFixed(1) + '%';

function timeTag(iso: string): string {
  return `<time datetime="${escapeHtml(iso)}">${escapeHtml(formatTip(iso))}</time>`;
}

const GRADE_LABEL: Readonly<Record<DailyGrade, string>> = { BET: 'Qualified bet', LEAN: 'Model lean', EDGE: 'Unproven edge' };
const CATEGORY_LABEL = { prop: 'Player prop', spread: 'Game spread' } as const;

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

function recordHtml(record: DailyRecord | null): string {
  if (!record || !record.all.picks) return '<p class="daily-record">The record starts with the first posted pick.</p>';
  const { all, spread, prop } = record;
  const extra = [
    all.pushes ? `${all.pushes} push${all.pushes === 1 ? '' : 'es'}` : '',
    all.voids ? `${all.voids} void` : '',
    all.pending ? `${all.pending} pending` : '',
  ].filter(Boolean).join(' · ');
  return `<div class="daily-record" aria-label="Record of every posted bet of the day">
    <p class="daily-record-main"><span class="daily-record-label">Record</span> <strong data-record-tally>${tally(all)}</strong> <span class="daily-record-units" data-units="${all.units > 0 ? 'up' : all.units < 0 ? 'down' : 'flat'}">${formatUnits(all.units)}</span></p>
    <p class="daily-record-sub">Spreads ${tally(spread)} · Props ${tally(prop)}${extra ? ` · ${extra}` : ''}${record.from ? ` · since ${escapeHtml(monthDay(record.from))}` : ''}</p>
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
  if (state.status === 'unavailable') {
    return `<section class="daily-picks" aria-labelledby="daily-picks-title">
    <h2 id="daily-picks-title">NBA bets of the day</h2><p class="daily-intro">Today’s posted picks and their record are awaiting publication.</p>
  </section>`;
  }
  const shown = [...state.today, ...state.yesterday];
  const unproven = shown.some((pick) => pick.grade === 'EDGE')
    ? ' An unproven edge clears the price, noise and data checks, but leans like it have not beaten the posted price in live grading.'
    : '';
  const notes = state.notes.map((note) => `<p class="daily-empty">${escapeHtml(note)}</p>`).join('');
  const today = state.today.length ? `<div class="daily-offers">${state.today.map(pickCard).join('')}</div>` : '';
  const todayEmpty = !state.today.length && !state.notes.length ? '<p class="daily-empty">No NBA bets of the day were posted today.</p>' : '';
  const yesterday = state.yesterday.length
    ? `<h3 class="daily-day">Yesterday</h3><div class="daily-offers">${state.yesterday.map(pickCard).join('')}</div>`
    : '';
  return `<section class="daily-picks" aria-labelledby="daily-picks-title">
    <header class="daily-head"><h2 id="daily-picks-title">NBA bets of the day</h2>${recordHtml(state.record)}</header>
    <p class="daily-intro">Each pick is the strongest player prop or spread left on the slate, read from the same 10,000 simulations as the box scores at the best tracked price. It is posted once, at the line and price shown, and stays up until its game tips; then the next game’s best pick is posted. Every posted pick counts in the record.</p>
    <h3 class="daily-day">Today</h3>${today}${notes}${todayEmpty}
    ${yesterday}
    ${shown.length ? `<p class="daily-note">No pick is a sure thing: a lean can lose, and leans have limited validation.${unproven} Win chance and break-even exclude pushes and voids; estimated net return includes them. The record grades each pick at its posted line and price, one unit each.</p>` : ''}
  </section>`;
}
