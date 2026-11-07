import { paletteStyle } from './display.ts';
import { formatTip } from './date.ts';
import { avatarMarkup, escapeHtml, teamLogoMarkup } from './slate.ts';
import { cleanOverrides, lineupIssue, type LineupChoice, type LineupOverrides } from './lineup-overrides.ts';
import type { RateGame, RatePlayer, SlateGame, TeamSide } from './types.ts';

const CHOICES: { value: LineupChoice; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'in', label: 'In' },
  { value: 'out', label: 'Out' },
];

function statusText(player: RatePlayer): string {
  const status = player.injury_status.trim() || 'healthy';
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function statusTone(player: RatePlayer): 'ok' | 'warn' | 'out' {
  if (player.minutes_weight === 0) return 'out';
  return player.injury_status === 'healthy' ? 'ok' : 'warn';
}

/** Model chance to play, before any call by the viewer. */
export function modelPlayShare(player: RatePlayer): number {
  if (player.minutes_weight === 0) return 0;
  return Math.max(0, Math.min(1, player.play_probability ?? 1));
}

function row(player: RatePlayer, choice: LineupChoice): string {
  const id = escapeHtml(player.athlete_id);
  const share = modelPlayShare(player);
  const meta = [
    player.position ? escapeHtml(player.position) : null,
    `${player.minutes_mean.toFixed(1)} min role`,
    `${Math.round(share * 100)}% to play`,
  ]
    .filter(Boolean)
    .join(' · ');
  const radios = CHOICES.map(
    (c) =>
      `<label class="choice-opt choice-${c.value}"><input type="radio" name="lineup-${id}" value="${c.value}" data-lineup-choice="${id}"${choice === c.value ? ' checked' : ''}><span>${c.label}</span></label>`,
  ).join('');
  return `<li class="lineup-row" data-choice="${choice}" data-tone="${statusTone(player)}">
    ${avatarMarkup(player.name, player.athlete_id, player.headshot_url)}
    <span class="lineup-who"><span class="lineup-name">${escapeHtml(player.name)}</span><span class="lineup-meta"><span class="pill tone-${statusTone(player)}">${escapeHtml(statusText(player))}</span> ${meta}</span></span>
    <fieldset class="choice-group" aria-label="${escapeHtml(player.name)} availability"><legend class="sr-only">${escapeHtml(player.name)}</legend>${radios}</fieldset>
  </li>`;
}

function expectedPlayers(players: RatePlayer[], overrides: LineupOverrides): number {
  return players.reduce((n, p) => n + (overrides[p.athlete_id] === 'in' ? 1 : overrides[p.athlete_id] === 'out' ? 0 : modelPlayShare(p)), 0);
}

function teamColumn(side: TeamSide, players: RatePlayer[], overrides: LineupOverrides, which: 'away' | 'home'): string {
  const ordered = players
    .filter((p) => !p.replacement_level)
    .slice()
    .sort((a, b) => modelPlayShare(b) * b.minutes_mean - modelPlayShare(a) * a.minutes_mean || a.name.localeCompare(b.name));
  const out = ordered.filter((p) => overrides[p.athlete_id] === 'out').length;
  const forcedIn = ordered.filter((p) => overrides[p.athlete_id] === 'in').length;
  const changes = out + forcedIn ? ` · ${out} out, ${forcedIn} in by you` : '';
  return `<section class="lineup-team ${which}" aria-label="${escapeHtml(side.name || side.abbreviation)} lineup">
    <header class="lineup-head">${teamLogoMarkup(side)}<div><h3>${escapeHtml(side.name || side.abbreviation)}</h3><p class="lineup-count">${expectedPlayers(ordered, overrides).toFixed(1)} expected to play${changes}</p></div></header>
    <ul class="lineup-list">${ordered.map((p) => row(p, overrides[p.athlete_id] ?? 'auto')).join('')}</ul>
  </section>`;
}

export function renderLineupEditor(game: SlateGame, rate: RateGame, rawOverrides: LineupOverrides | undefined): string {
  const overrides = cleanOverrides(rate, rawOverrides);
  const issue = lineupIssue(rate, overrides);
  const edits = Object.keys(overrides).length;
  const away = rate.players.filter((p) => p.team_id === rate.away_team_id);
  const home = rate.players.filter((p) => p.team_id === rate.home_team_id);
  return `<div class="lineups" data-lineup-editor="${escapeHtml(game.event_id)}" style="${paletteStyle(game.away, game.home)}">
    <div class="toolbar">
      <button type="button" data-back>Back to slate</button>
      <div class="toolbar-title"><h2 id="lineup-title" tabindex="-1">Lineups</h2><p class="toolbar-sub">${escapeHtml(game.away.abbreviation || game.away.name)} @ ${escapeHtml(game.home.abbreviation || game.home.name)} · ${escapeHtml(formatTip(game.start_time))}</p></div>
    </div>
    <p class="lede">Auto follows tonight's injury report and each player's recent games. Set a player to In to play him every simulation, or Out to sit him. Your calls stay in this browser and never change the published card.</p>
    <div class="lineup-grid">
      ${teamColumn(game.away, away, overrides, 'away')}
      ${teamColumn(game.home, home, overrides, 'home')}
    </div>
    <div class="lineup-actions">
      <button type="button" data-event="${escapeHtml(game.event_id)}" data-lineup-run${issue ? ' disabled' : ''}>${edits ? 'Simulate with my lineups' : 'Simulate'}</button>
      <button type="button" class="ghost" data-lineup-reset${edits ? '' : ' disabled'}>Reset to model</button>
      <p class="lineup-status" role="status">${issue ? escapeHtml(issue) : edits ? `${edits} change${edits === 1 ? '' : 's'} from the model.` : 'Using the model for every player.'}</p>
    </div>
  </div>`;
}
