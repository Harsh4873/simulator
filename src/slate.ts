import type {RefreshHealth} from './generation.ts';
import { freshnessIssue, validateGame } from './validate-card.ts';
import { chicagoDate, formatTip, shiftChicagoDate } from './date.ts';
import { paletteStyle, playerHeadshotUrl, teamLogoUrl } from './display.ts';
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

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

export function avatarMarkup(name: string, athleteId: string, headshot?: string | null): string {
  const url = playerHeadshotUrl({ athlete_id: athleteId, headshot_url: headshot ?? null });
  const image = url ? `<img referrerpolicy="no-referrer" loading="lazy" alt="" src="${escapeHtml(url)}" width="36" height="36">` : '';
  return `<span class="avatar" aria-hidden="true">${image}<span class="mono"${url ? ' hidden' : ''}>${escapeHtml(initials(name))}</span></span>`;
}

function matchupSide(side: TeamSide): string {
  return `<span class="side">${teamLogoMarkup(side)}<span class="side-copy"><span class="abbr">${escapeHtml(sideAbbr(side))}</span><span class="name">${escapeHtml(sideLabel(side))}</span></span></span>`;
}

function stateChip(game: SlateGame, now: Date): string {
  const tip = Date.parse(game.start_time);
  if (game.completed === true || game.status_state === 'post') return '<span class="chip" data-state="post">Final</span>';
  if (game.status_state === 'in') return '<span class="chip" data-state="live">Live</span>';
  if (Number.isFinite(tip) && tip <= now.getTime()) return '<span class="chip" data-state="live">Tipped</span>';
  return '<span class="chip" data-state="pre">Upcoming</span>';
}

function tipClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(date);
}

function renderCard(game: SlateGame, card: RateCard, now: Date, capturedAt: string | null, edits: number): string {
  const rate = card.games.find((item) => item.event_id === game.event_id);
  let ready = false;
  let unavailable = 'Shooting rates are not ready';
  try { if(rate){validateGame(rate);ready=true;} } catch (error) { ready=false; if(error instanceof Error)unavailable=error.message; }
  const season = game.season_type && game.season_type !== 'regular' ? `<p class="tag">${escapeHtml(game.season_type)}</p>` : '';
  const spread = game.spread_caption ? `<p class="spread">${escapeHtml(game.spread_caption)}</p>` : '';
  const thin = rate?.thin_rotation ? '<p class="tag">Thin rotation: replacement-level minutes fill remaining spots from league-average rates, not invented player stats.</p>' : '';
  const label = ready ? 'Simulate' : escapeHtml(unavailable);
  const edited = edits ? `<p class="chip chip-edit">${edits} lineup change${edits === 1 ? '' : 's'}</p>` : '';
  const lineups = rate && rate.players.length ? `<button type="button" class="ghost" data-lineup="${escapeHtml(game.event_id)}">Lineups</button>` : '';
  return `<article class="game-card" style="${paletteStyle(game.away, game.home)}">
    <div class="card-top"><span class="chip chip-time">${escapeHtml(tipClock(game.start_time))}</span>${stateChip(game, now)}</div>
    <h2 class="matchup">${matchupSide(game.away)}<span class="at">@</span>${matchupSide(game.home)}</h2>
    <p class="tip">${escapeHtml(formatTip(game.start_time))}</p>
    <p class="status">${escapeHtml(statusLabel(game, now, capturedAt))}</p>
    ${season}
    ${spread}
    ${thin}
    ${edited}
    <div class="card-actions"><button type="button" data-event="${escapeHtml(game.event_id)}"${ready ? '' : ' disabled'}>${label}</button>${lineups}</div>
  </article>`;
}

function dayTitle(gameDate: string, today: string): string {
  if (gameDate === today) return 'Today';
  if (gameDate === shiftChicagoDate(today, -1)) return 'Yesterday';
  return gameDate;
}

function slateSummary(slate: Slate, card: RateCard, now: Date): string {
  const today = chicagoDate(now);
  const todayGames = slate.games.filter((game) => game.date === today);
  const older = slate.games.length - todayGames.length;
  const upcoming = todayGames.filter((g) => g.status_state === 'pre' && Date.parse(g.start_time) > now.getTime());
  const first = upcoming.map((g) => g.start_time).sort()[0];
  const parts: string[] = [];
  if (todayGames.length) parts.push(`${todayGames.length} today`);
  if (older) parts.push(`${older} from yesterday`);
  if (first) parts.push(`next tip ${tipClock(first)}`);
  else if (todayGames.length) parts.push('today\'s games are under way or final');
  const built = card.generated_at ? `Card built ${tipClock(card.generated_at)}` : 'Card time unknown';
  return `<div class="slate-head"><p class="slate-meta">${escapeHtml(parts.join(' · '))}</p><p class="status captured" title="${escapeHtml(card.generated_at ?? '')}">${escapeHtml(built)}</p></div>`;
}

export function renderSlate(slate: Slate, card: RateCard, now: Date, health:RefreshHealth|null=null, edits: Readonly<Record<string, number>> = {}): string {
  if (slate.generated_at === null) {
    return '<p class="state">Today\'s slate has not been built yet.</p>';
  }
  const issue = freshnessIssue(slate,card,now,health);
  if(issue) return `<p class="state" role="alert">${escapeHtml(issue)}. Captured ${escapeHtml(card.generated_at ?? 'unknown')}. <button data-retry>Retry</button></p>`;
  if (slate.games.length === 0) {
    return `<p class="state">No NBA games on ${escapeHtml(slate.date ?? '')}.</p>`;
  }
  const today = chicagoDate(now);
  const byDate = new Map<string, SlateGame[]>();
  for (const game of slate.games) {
    const list = byDate.get(game.date) ?? [];
    list.push(game);
    byDate.set(game.date, list);
  }
  const sections = [...byDate.keys()].sort((a, b) => b.localeCompare(a)).map((day) => {
    const games = byDate.get(day) ?? [];
    const cards = games.map((game) => renderCard(game, card, now, slate.generated_at, edits[game.event_id] ?? 0)).join('');
    return `<section class="slate-day"><h2 class="slate-title">${escapeHtml(dayTitle(day, today))}</h2><div class="slate">${cards}</div></section>`;
  }).join('');
  return `${slateSummary(slate, card, now)}${sections}`;
}
