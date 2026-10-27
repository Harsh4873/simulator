import { formatTip } from './date.ts';
import type { RateCard, Slate, SlateGame } from './types.ts';

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function statusLabel(game: Pick<SlateGame, 'completed' | 'status_state' | 'start_time'>, now: Date): string {
  if (game.completed === true || game.status_state === 'post') return 'final';
  if (game.status_state === 'in') return 'in progress';
  if (game.status_state === 'pre') return 'not started';
  const tip = Date.parse(game.start_time);
  if (!Number.isNaN(tip) && now.getTime() < tip) return 'not started';
  return 'unknown';
}

function renderCard(game: SlateGame, card: RateCard, now: Date): string {
  const ready = card.games.some((item) => item.event_id === game.event_id);
  const season = game.season_type ? `<p class="tag">${escapeHtml(game.season_type)}</p>` : '';
  const spread = game.spread_caption ? `<p class="spread">${escapeHtml(game.spread_caption)}</p>` : '';
  const label = ready ? 'Simulate' : 'Shooting rates are not ready';
  return `<article class="game-card">
    <h2>${escapeHtml(game.away.name)} @ ${escapeHtml(game.home.name)}</h2>
    <p class="tip">${escapeHtml(formatTip(game.start_time))}</p>
    <p class="status">${escapeHtml(statusLabel(game, now))}</p>
    ${season}
    ${spread}
    <button type="button" data-event="${escapeHtml(game.event_id)}"${ready ? '' : ' disabled'}>${label}</button>
  </article>`;
}

export function renderSlate(slate: Slate, card: RateCard, now: Date): string {
  if (slate.generated_at === null) {
    return '<p class="state">Today\'s slate has not been built yet.</p>';
  }
  if (slate.games.length === 0) {
    return `<p class="state">No NBA games on ${escapeHtml(slate.date ?? '')}.</p>`;
  }
  return `<div class="slate">${slate.games.map((game) => renderCard(game, card, now)).join('')}</div>`;
}
