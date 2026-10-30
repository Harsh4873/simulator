import type {RefreshHealth} from './generation.ts';
import { freshnessIssue, validateGame } from './validate-card.ts';
import { formatTip } from './date.ts';
import { teamLogoUrl } from './display.ts';
import type { RateCard, Slate, SlateGame, TeamSide } from './types.ts';

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function statusLabel(
  game: Pick<SlateGame, 'completed' | 'status_state' | 'start_time'>,
  now: Date,
  capturedAt?: string | null,
): string {
  if (game.completed === true || game.status_state === 'post') return 'final';
  if (game.status_state === 'in') return 'in progress';
  const tip = Date.parse(game.start_time);
  if (!Number.isNaN(tip) && now.getTime() < tip) return 'not started';
  if (game.status_state === 'pre') {
    const captured = capturedAt ? ` captured ${capturedAt}` : '';
    return `pregame card${captured}; status may be stale`;
  }
  return 'unknown';
}

function sideLabel(side: TeamSide): string {
  const name = side.name.trim();
  if (name) return name;
  return side.abbreviation.trim();
}

function sideAbbr(side: TeamSide): string {
  const abbreviation = side.abbreviation.trim();
  if (abbreviation) return abbreviation;
  return side.name.trim();
}

export function teamLogoMarkup(side: TeamSide): string {
  const url = teamLogoUrl(side);
  const mono = `<span class="mono"${url ? ' hidden' : ''}>${escapeHtml(sideAbbr(side))}</span>`;
  const image = url
    ? `<img referrerpolicy="no-referrer" alt="${escapeHtml(sideLabel(side))}" src="${escapeHtml(url)}" width="56" height="56">`
    : '';
  return `<span class="logo">${image}${mono}</span>`;
}

function matchupSide(side: TeamSide): string {
  return `<span class="side">${teamLogoMarkup(side)}<span class="side-copy"><span class="abbr">${escapeHtml(sideAbbr(side))}</span><span class="name">${escapeHtml(sideLabel(side))}</span></span></span>`;
}

function renderCard(game: SlateGame, card: RateCard, now: Date, capturedAt: string | null): string {
  const rate = card.games.find((item) => item.event_id === game.event_id);
  let ready = false;
  try { if(rate){validateGame(rate);ready=true;} } catch { ready=false; }
  const season = game.season_type ? `<p class="tag">${escapeHtml(game.season_type)}</p>` : '';
  const spread = game.spread_caption ? `<p class="spread">${escapeHtml(game.spread_caption)}</p>` : '';
  const label = ready ? 'Simulate' : 'Shooting rates are not ready';
  return `<article class="game-card">
    <h2 class="matchup">${matchupSide(game.away)}<span class="at">@</span>${matchupSide(game.home)}</h2>
    <p class="tip">${escapeHtml(formatTip(game.start_time))}</p>
    <p class="status">${escapeHtml(statusLabel(game, now, capturedAt))}</p>
    ${season}
    ${spread}
    <button type="button" data-event="${escapeHtml(game.event_id)}"${ready ? '' : ' disabled'}>${label}</button>
  </article>`;
}

export function renderSlate(slate: Slate, card: RateCard, now: Date, health:RefreshHealth|null=null): string {
  if (slate.generated_at === null) {
    return '<p class="state">Today\'s slate has not been built yet.</p>';
  }
  const issue = freshnessIssue(slate,card,now,health);
  if(issue) return `<p class="state" role="alert">${escapeHtml(issue)}. Captured ${escapeHtml(card.generated_at ?? 'unknown')}. <button data-retry>Retry</button></p>`;
  if (slate.games.length === 0) {
    return `<p class="state">No NBA games on ${escapeHtml(slate.date ?? '')}.</p>`;
  }
  return `<p class="status">Captured ${escapeHtml(card.generated_at ?? 'unknown')}</p><div class="slate">${slate.games.map((game) => renderCard(game, card, now, slate.generated_at)).join('')}</div>`;
}
