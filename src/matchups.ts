// Descriptive report for the board. Every verdict is NO BET. The page renders the file and does not sample a game.
import './matchups.css';
import { chicagoDate, formatTip } from './date.ts';
import type { CompletedEvent } from './parse-summary.ts';
import {
  NBA_TEAMS,
  positionToDefenseSlot,
  unpackRankedPair,
  unpackTeamAllowed,
  type TeamDefenseEntry,
} from './projection-context.ts';
import { escapeHtml } from './slate.ts';
import type { RateCard, RateGame, RatePlayer, Slate, SlateGame, TeamProfile } from './types.ts';

export const MIN_STRENGTH_GAMES = 8;
export const RECENT_WINDOW = 10;
export const MIN_FORM_GAMES = 5;
export const CLOSE_MARGIN_MAX = 5;
export const STRONG_RANK_MAX = 10;
export const CLOSE_LOSS_SHARE = 0.5;
export const MIN_EXPLAINED_LOSSES = 2;
export const COLLAPSE_MEAN_MARGIN = -8;
export const COMPARABLE_RANK_DISTANCE = 5;
export const COMPARABLE_LIST_MAX = 8;
export const DEFENSE_EDGE_N = 5;
export const MIN_DEFENSE_GAMES = 8;
export const MATCHUP_MIN_PLAY = 0.5;
export const MATCHUP_MIN_MINUTES = 20;
export const VERDICT = 'NO BET';

export type FormTag = 'short-sample' | 'close-losses-to-strong' | 'margin-collapse' | 'no-tag';
export type BoardSubview = 'shop' | 'matchups';

export interface MatchupForm {
  tag: FormTag;
  games: number;
  mean_margin: number | null;
  losses: number;
  close_losses_to_strong: number;
}

export interface MatchupRow {
  event_id: string;
  date: string;
  opponent_id: string;
  opponent: string;
  team_score: number;
  opponent_score: number;
  margin: number;
  opponent_games: number;
  opponent_net: number | null;
  opponent_rank: number | null;
  why: string;
}

export interface MatchupTeam {
  team_id: string;
  games_before_tip: number;
  mean_margin: number | null;
  rank: number | null;
  form: MatchupForm;
  rows: MatchupRow[];
}

export interface MatchupGame {
  event_id: string;
  verdict: typeof VERDICT;
  away: MatchupTeam;
  home: MatchupTeam;
}

export interface MatchupsFile {
  schema_version: 1;
  generated_at: string | null;
  input_hash: string | null;
  model_hash: string | null;
  model_version: string | null;
  calibrated: false;
  descriptive: true;
  verdict: typeof VERDICT;
  games: MatchupGame[];
}

const FORM_TAGS: ReadonlySet<string> = new Set(['short-sample', 'close-losses-to-strong', 'margin-collapse', 'no-tag']);
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  'price',
  'odds',
  'spread',
  'moneyline',
  'money_line',
  'blowout',
  'winner',
  'win_chance',
  'american',
]);

interface TeamGame {
  event_id: string;
  start_time: string;
  start_ms: number;
  opponent_id: string;
  team_score: number;
  opponent_score: number;
  margin: number;
}

interface Strength {
  games: number;
  mean: number | null;
  rank: number | null;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function idOrder(a: string, b: string): number {
  const left = Number(a);
  const right = Number(b);
  if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
  return a.localeCompare(b);
}

function opponentLabel(teamId: string): string {
  return NBA_TEAMS[teamId]?.abbr ?? teamId;
}

function gameDate(start: string): string {
  const ms = Date.parse(start);
  if (!Number.isFinite(ms)) return start.slice(0, 10);
  return chicagoDate(new Date(ms));
}

function gamesBeforeTip(events: readonly CompletedEvent[], season: number, tipMs: number, excludeId: string): Map<string, TeamGame[]> {
  const byTeam = new Map<string, TeamGame[]>();
  const add = (teamId: string, game: TeamGame) => {
    const list = byTeam.get(teamId);
    if (list) list.push(game);
    else byTeam.set(teamId, [game]);
  };
  for (const event of events) {
    if (event.season_type !== 2 || event.season !== season || event.event_id === excludeId) continue;
    const start = Date.parse(event.start_time);
    if (!Number.isFinite(start) || start >= tipMs) continue;
    if (!Number.isFinite(event.home_pts) || !Number.isFinite(event.away_pts)) continue;
    add(event.home_team_id, {
      event_id: event.event_id,
      start_time: event.start_time,
      start_ms: start,
      opponent_id: event.away_team_id,
      team_score: event.home_pts,
      opponent_score: event.away_pts,
      margin: event.home_pts - event.away_pts,
    });
    add(event.away_team_id, {
      event_id: event.event_id,
      start_time: event.start_time,
      start_ms: start,
      opponent_id: event.home_team_id,
      team_score: event.away_pts,
      opponent_score: event.home_pts,
      margin: event.away_pts - event.home_pts,
    });
  }
  for (const list of byTeam.values()) list.sort((a, b) => a.start_ms - b.start_ms || a.event_id.localeCompare(b.event_id));
  return byTeam;
}

function buildStrength(byTeam: Map<string, TeamGame[]>): Map<string, Strength> {
  const ranked: { id: string; mean: number }[] = [];
  const out = new Map<string, Strength>();
  for (const [id, list] of byTeam) {
    const raw = list.length ? list.reduce((sum, game) => sum + game.margin, 0) / list.length : null;
    out.set(id, { games: list.length, mean: raw == null ? null : round3(raw), rank: null });
    if (list.length >= MIN_STRENGTH_GAMES && raw != null) ranked.push({ id, mean: raw });
  }
  ranked.sort((a, b) => b.mean - a.mean || idOrder(a.id, b.id));
  ranked.forEach((row, index) => {
    const current = out.get(row.id);
    if (current) current.rank = index + 1;
  });
  return out;
}

function formOf(games: readonly TeamGame[], strength: Map<string, Strength>): MatchupForm {
  const window = games.slice(-RECENT_WINDOW);
  let losses = 0;
  let closeStrong = 0;
  let sum = 0;
  for (const game of window) {
    sum += game.margin;
    if (!(game.margin < 0)) continue;
    losses += 1;
    const oppRank = strength.get(game.opponent_id)?.rank ?? null;
    const close = game.margin >= -CLOSE_MARGIN_MAX;
    const strong = oppRank != null && oppRank >= 1 && oppRank <= STRONG_RANK_MAX;
    if (close && strong) closeStrong += 1;
  }
  const mean = window.length ? sum / window.length : null;
  let tag: FormTag = 'no-tag';
  if (window.length < MIN_FORM_GAMES) tag = 'short-sample';
  else if (losses >= MIN_EXPLAINED_LOSSES && closeStrong / losses >= CLOSE_LOSS_SHARE) tag = 'close-losses-to-strong';
  else if (mean != null && mean <= COLLAPSE_MEAN_MARGIN) tag = 'margin-collapse';
  return {
    tag,
    games: window.length,
    mean_margin: mean == null ? null : round3(mean),
    losses,
    close_losses_to_strong: closeStrong,
  };
}

function logRows(games: readonly TeamGame[], tonightOpponentId: string, strength: Map<string, Strength>): MatchupRow[] {
  const last = new Set(games.slice(-RECENT_WINDOW).map((game) => game.event_id));
  const tonightRank = strength.get(tonightOpponentId)?.rank ?? null;
  const comparable = new Map<string, number>();
  if (tonightRank != null) {
    const hits: { id: string; distance: number }[] = [];
    for (const game of games) {
      const oppRank = strength.get(game.opponent_id)?.rank ?? null;
      if (oppRank == null) continue;
      const distance = Math.abs(oppRank - tonightRank);
      if (distance <= COMPARABLE_RANK_DISTANCE) hits.push({ id: game.event_id, distance });
    }
    for (const hit of hits.slice(-COMPARABLE_LIST_MAX)) comparable.set(hit.id, hit.distance);
  }
  const rows: (MatchupRow & { start_ms: number })[] = [];
  const seen = new Set<string>();
  for (const game of games) {
    if (seen.has(game.event_id)) continue;
    const inLast = last.has(game.event_id);
    const distance = comparable.has(game.event_id) ? comparable.get(game.event_id)! : null;
    if (!inLast && distance == null) continue;
    seen.add(game.event_id);
    const opp = strength.get(game.opponent_id);
    const why: string[] = [];
    if (inLast) why.push('last 10 before tip');
    if (distance != null) why.push(`comparable, rank distance ${distance}`);
    rows.push({
      event_id: game.event_id,
      date: gameDate(game.start_time),
      opponent_id: game.opponent_id,
      opponent: opponentLabel(game.opponent_id),
      team_score: game.team_score,
      opponent_score: game.opponent_score,
      margin: game.margin,
      opponent_games: opp?.games ?? 0,
      opponent_net: opp?.mean ?? null,
      opponent_rank: opp?.rank ?? null,
      why: why.join('; '),
      start_ms: game.start_ms,
    });
  }
  rows.sort((a, b) => b.start_ms - a.start_ms || b.event_id.localeCompare(a.event_id));
  return rows.map((row) => ({
    event_id: row.event_id,
    date: row.date,
    opponent_id: row.opponent_id,
    opponent: row.opponent,
    team_score: row.team_score,
    opponent_score: row.opponent_score,
    margin: row.margin,
    opponent_games: row.opponent_games,
    opponent_net: row.opponent_net,
    opponent_rank: row.opponent_rank,
    why: row.why,
  }));
}

function teamBlock(teamId: string, opponentId: string, byTeam: Map<string, TeamGame[]>, strength: Map<string, Strength>): MatchupTeam {
  const games = byTeam.get(teamId) ?? [];
  const own = strength.get(teamId);
  return {
    team_id: teamId,
    games_before_tip: games.length,
    mean_margin: own?.mean ?? null,
    rank: own?.rank ?? null,
    form: formOf(games, strength),
    rows: logRows(games, opponentId, strength),
  };
}

export function buildMatchups(slate: Slate, card: RateCard, events: readonly CompletedEvent[]): MatchupsFile {
  const season = card.projection_context?.active_season;
  const seasonOk = typeof season === 'number' && Number.isFinite(season);
  const games: MatchupGame[] = slate.games.map((game) => {
    const tip = Date.parse(game.start_time);
    const byTeam = seasonOk && Number.isFinite(tip) ? gamesBeforeTip(events, season, tip, game.event_id) : new Map<string, TeamGame[]>();
    const strength = buildStrength(byTeam);
    return {
      event_id: game.event_id,
      verdict: VERDICT,
      away: teamBlock(game.away.team_id, game.home.team_id, byTeam, strength),
      home: teamBlock(game.home.team_id, game.away.team_id, byTeam, strength),
    };
  });
  return {
    schema_version: 1,
    generated_at: card.generated_at ?? null,
    input_hash: card.input_hash ?? null,
    model_hash: card.model_hash ?? null,
    model_version: card.model_version ?? null,
    calibrated: false,
    descriptive: true,
    verdict: VERDICT,
    games,
  };
}

export function serializeMatchups(file: MatchupsFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

function forbidden(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(forbidden);
  if (!value || typeof value !== 'object') return false;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key) || forbidden(child)) return true;
  }
  return false;
}

function asStringOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  return undefined;
}

function asNumberOrNull(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function asCount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  return undefined;
}

function parseTeam(value: unknown): MatchupTeam | null {
  if (!value || typeof value !== 'object') return null;
  const team = value as Partial<MatchupTeam>;
  const form = team.form;
  if (!form || typeof form.tag !== 'string' || !FORM_TAGS.has(form.tag)) return null;
  const games = asCount(form.games);
  const losses = asCount(form.losses);
  const close = asCount(form.close_losses_to_strong);
  const mean = asNumberOrNull(form.mean_margin);
  const teamMean = asNumberOrNull(team.mean_margin);
  const rank = asNumberOrNull(team.rank);
  const before = asCount(team.games_before_tip);
  if (typeof team.team_id !== 'string' || games === undefined || losses === undefined || close === undefined || mean === undefined || teamMean === undefined || rank === undefined || before === undefined) return null;
  if (!Array.isArray(team.rows)) return null;
  const rows: MatchupRow[] = [];
  for (const item of team.rows) {
    if (!item || typeof item !== 'object') return null;
    const row = item as Partial<MatchupRow>;
    const oppGames = asCount(row.opponent_games);
    const oppNet = asNumberOrNull(row.opponent_net);
    const oppRank = asNumberOrNull(row.opponent_rank);
    if (typeof row.event_id !== 'string' || typeof row.date !== 'string' || typeof row.opponent_id !== 'string' || typeof row.opponent !== 'string' || typeof row.why !== 'string') return null;
    if (typeof row.team_score !== 'number' || typeof row.opponent_score !== 'number' || typeof row.margin !== 'number') return null;
    if (oppGames === undefined || oppNet === undefined || oppRank === undefined) return null;
    rows.push({
      event_id: row.event_id,
      date: row.date,
      opponent_id: row.opponent_id,
      opponent: row.opponent,
      team_score: row.team_score,
      opponent_score: row.opponent_score,
      margin: row.margin,
      opponent_games: oppGames,
      opponent_net: oppNet,
      opponent_rank: oppRank,
      why: row.why,
    });
  }
  return {
    team_id: team.team_id,
    games_before_tip: before,
    mean_margin: teamMean,
    rank,
    form: { tag: form.tag as FormTag, games, mean_margin: mean, losses, close_losses_to_strong: close },
    rows,
  };
}

export function parseMatchupsFile(text: string): MatchupsFile | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (forbidden(value) || !value || typeof value !== 'object') return null;
  const file = value as Partial<MatchupsFile>;
  if (file.schema_version !== 1 || file.calibrated !== false || file.descriptive !== true || file.verdict !== VERDICT || !Array.isArray(file.games)) return null;
  const generated = asStringOrNull(file.generated_at);
  const input = asStringOrNull(file.input_hash);
  const model = asStringOrNull(file.model_hash);
  const version = asStringOrNull(file.model_version);
  if (generated === undefined || input === undefined || model === undefined || version === undefined) return null;
  const games: MatchupGame[] = [];
  for (const item of file.games) {
    if (!item || typeof item !== 'object') return null;
    const game = item as Partial<MatchupGame>;
    if (typeof game.event_id !== 'string' || game.verdict !== VERDICT) return null;
    const away = parseTeam(game.away);
    const home = parseTeam(game.home);
    if (!away || !home) return null;
    games.push({ event_id: game.event_id, verdict: VERDICT, away, home });
  }
  return {
    schema_version: 1,
    generated_at: generated,
    input_hash: input,
    model_hash: model,
    model_version: version,
    calibrated: false,
    descriptive: true,
    verdict: VERDICT,
    games,
  };
}

export function reportMatchesCard(file: MatchupsFile, card: RateCard): boolean {
  return file.generated_at === (card.generated_at ?? null)
    && file.input_hash === (card.input_hash ?? null)
    && file.model_hash === (card.model_hash ?? null)
    && file.model_version === (card.model_version ?? null)
    && file.calibrated === false
    && file.verdict === VERDICT;
}

function fixed(value: number, digits: number): string {
  if (!Number.isFinite(value)) return 'not on the card';
  return value.toFixed(digits);
}

function signed(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'not on the card';
  const text = Number.isInteger(value) ? String(value) : fixed(value, 1);
  return value > 0 ? `+${text}` : text;
}

function simulatorLabel(version: string | null | undefined): string {
  const name = version && version.trim() ? version.trim() : 'unvalidated';
  return `Current unvalidated simulator (${name}). Not a predicted score.`;
}

function profileHtml(profile: TeamProfile | undefined): string {
  if (!profile) return '<p>No team rating on the card.</p>';
  const rest = profile.rest_days == null ? 'not recorded' : String(profile.rest_days);
  return `<dl class="matchup-dl">
    <dt>Pace</dt><dd>${fixed(profile.pace, 1)}</dd>
    <dt>Offense</dt><dd>${fixed(profile.offense, 3)} points per possession</dd>
    <dt>Defense</dt><dd>${fixed(profile.defense, 3)} points per possession</dd>
    <dt>Games</dt><dd>${profile.games}</dd>
    <dt>Rest</dt><dd>${escapeHtml(rest)}</dd>
  </dl>`;
}

function copiedContextHtml(entry: TeamDefenseEntry | undefined): string {
  if (!entry) return '<p>No projection context for this team.</p>';
  const [pace, paceRank] = unpackRankedPair(entry.pace);
  const [allowed, allowedRank] = unpackTeamAllowed(entry, 'pts', 'all');
  return `<dl class="matchup-dl">
    <dt>Pace per 48</dt><dd>${fixed(pace, 1)} (rank ${paceRank}, 1 is fastest)</dd>
    <dt>Points allowed per game</dt><dd>${fixed(allowed, 1)} (rank ${allowedRank}, 1 is fewest)</dd>
    <dt>Games</dt><dd>${entry.games}</dd>
  </dl>`;
}

function outForSeason(status: string): boolean {
  return status.trim().toLowerCase().includes('out for season');
}

function minuteFacts(player: RatePlayer, playLabel: string): string {
  const play = typeof player.play_probability === 'number' && Number.isFinite(player.play_probability)
    ? fixed(player.play_probability, 3)
    : 'not on the card';
  const parts = [
    `Minutes ${fixed(player.minutes_mean, 1)}`,
    `${playLabel} ${play}`,
    `Minutes weight ${player.minutes_weight}`,
  ];
  if (typeof player.starter_rate === 'number' && Number.isFinite(player.starter_rate)) parts.push(`Starter rate ${fixed(player.starter_rate, 2)}`);
  if (typeof player.minutes_residual_sd === 'number' && Number.isFinite(player.minutes_residual_sd)) {
    parts.push(`Minute noise around role minutes ${fixed(player.minutes_residual_sd, 2)}`);
  }
  return `${parts.join('. ')}.`;
}

function listedForInjury(player: RatePlayer): boolean {
  const status = player.injury_status.trim().toLowerCase();
  const restricted = typeof player.minutes_restriction === 'number' && Number.isFinite(player.minutes_restriction);
  return (status !== '' && status !== 'healthy') || restricted;
}

function injuryHtml(players: readonly RatePlayer[]): string {
  const listed = players.filter(listedForInjury).sort((a, b) => a.name.localeCompare(b.name) || a.athlete_id.localeCompare(b.athlete_id));
  if (!listed.length) return '<p>No injured players and no minute cap on the card.</p>';
  const items = listed.map((player) => {
    const status = player.injury_status.trim();
    const note = player.injury_note?.trim() ? `<p>${escapeHtml(player.injury_note.trim())}</p>` : '';
    const cap = typeof player.minutes_restriction === 'number' && Number.isFinite(player.minutes_restriction)
      ? `<p>Minutes cap ${escapeHtml(String(player.minutes_restriction))}.</p>`
      : '';
    const extra = outForSeason(status)
      ? '<p>No extra adjustment is applied.</p>'
      : status.toLowerCase() !== 'healthy' && status !== ''
        ? '<p>Not converted into points.</p>'
        : '';
    return `<li><p>${escapeHtml(player.name)}. ${escapeHtml(status || 'not on the card')}. ${minuteFacts(player, 'Play probability')}</p>${note}${cap}${extra}</li>`;
  }).join('');
  return `<ul class="matchup-list">${items}</ul>`;
}

function screenFails(player: RatePlayer): boolean {
  const playFails = typeof player.play_probability === 'number' && player.play_probability < MATCHUP_MIN_PLAY;
  return playFails || player.minutes_mean < MATCHUP_MIN_MINUTES || player.minutes_weight === 0;
}

function defenseHtml(rate: RateGame | null, card: RateCard): string {
  const context = card.projection_context;
  if (!rate || !context) return '<p>No G, F, or C points-allowed rank cleared the edge.</p>';
  const teamCount = Object.keys(context.teams).length;
  const rows: string[] = [];
  const players = [...rate.players].sort((a, b) => a.name.localeCompare(b.name) || a.athlete_id.localeCompare(b.athlete_id));
  for (const player of players) {
    if (player.replacement_level) continue;
    const slot = positionToDefenseSlot(player.position_group || player.position);
    if (slot !== 'G' && slot !== 'F' && slot !== 'C') continue;
    const opponentId = player.team_id === rate.away_team_id ? rate.home_team_id : rate.away_team_id;
    const opponent = context.teams[opponentId];
    if (!opponent || opponent.games < MIN_DEFENSE_GAMES) continue;
    const [allowed, rank] = unpackTeamAllowed(opponent, 'pts', slot);
    if (!(rank <= DEFENSE_EDGE_N || rank > teamCount - DEFENSE_EDGE_N)) continue;
    const screen = screenFails(player) ? '<p>Minutes screen does not pass.</p>' : '';
    rows.push(`<li>
      <p>${escapeHtml(player.name)}. points allowed to ${slot} per game. Not a defender matchup.</p>
      <p>Allowed per game ${fixed(allowed, 1)}. Rank ${rank}. Sample ${opponent.games}. ${minuteFacts(player, 'Play share')}</p>
      ${screen}
      <p>Not a bet.</p>
    </li>`);
  }
  if (!rows.length) return '<p>No G, F, or C points-allowed rank cleared the edge.</p>';
  return `<ul class="matchup-list">${rows.join('')}</ul>`;
}

function tableHtml(rows: readonly MatchupRow[]): string {
  if (!rows.length) return '';
  const body = rows.map((row) => {
    const rank = row.opponent_rank == null ? 'unranked' : String(row.opponent_rank);
    return `<tr>
      <td>${escapeHtml(row.date)}</td>
      <td>${escapeHtml(row.opponent)}</td>
      <td>${row.team_score}</td>
      <td>${row.opponent_score}</td>
      <td>${signed(row.margin)}</td>
      <td>${row.opponent_games}</td>
      <td>${signed(row.opponent_net)}</td>
      <td>${escapeHtml(rank)}</td>
      <td>${escapeHtml(row.why)}</td>
    </tr>`;
  }).join('');
  return `<div class="matchup-scroll"><table class="matchup-table">
    <thead><tr><th>Chicago date</th><th>Opponent</th><th>Team score</th><th>Opponent score</th><th>Margin</th><th>Opponent games</th><th>Opponent net per game</th><th>Opponent rank</th><th>Why</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

function teamHtml(title: string, team: MatchupTeam, profile: TeamProfile | undefined, entry: TeamDefenseEntry | undefined, version: string | null | undefined): string {
  const history = team.games_before_tip === 0
    ? '<p class="matchup-empty">No completed regular-season games before tip.</p>'
    : `<p>Rank ${team.rank == null ? 'unranked' : team.rank}. Mean margin ${signed(team.mean_margin)} over ${team.games_before_tip} games before tip.</p>
      <p class="matchup-form" data-form="${escapeHtml(team.form.tag)}">${escapeHtml(team.form.tag)}. Mean margin ${signed(team.form.mean_margin)}. Window ${team.form.games} games, ${team.form.losses} losses, ${team.form.close_losses_to_strong} close losses to a strong opponent.</p>
      ${tableHtml(team.rows)}`;
  return `<section class="matchup-team">
    <h3>${escapeHtml(title)}</h3>
    <p class="matchup-label">${escapeHtml(simulatorLabel(version))}</p>
    ${profileHtml(profile)}
    ${copiedContextHtml(entry)}
    ${history}
  </section>`;
}

function gameHtml(slateGame: SlateGame, report: MatchupGame | undefined, rate: RateGame | null, card: RateCard): string {
  if (!report) return `<article class="matchup-game"><p class="matchup-miss">The report is not for this card.</p></article>`;
  const version = card.model_version;
  const context = rate?.context;
  const defense = card.projection_context;
  const awayEntry = defense?.teams[slateGame.away.team_id];
  const homeEntry = defense?.teams[slateGame.home.team_id];
  const league = context ? `<p>League efficiency ${fixed(context.league_efficiency, 3)} points per possession.</p>` : '<p>League efficiency is not on the card.</p>';
  const season = defense ? `<p>Defense sample ${escapeHtml(defense.defense_season_label)}.</p>` : '<p>No projection context on the card.</p>';
  const thin = rate?.thin_rotation ? '<p>Thin rotation.</p>' : '';
  const awayName = slateGame.away.abbreviation.trim() || slateGame.away.name.trim() || slateGame.away.team_id;
  const homeName = slateGame.home.abbreviation.trim() || slateGame.home.name.trim() || slateGame.home.team_id;
  return `<article class="matchup-game">
    <h2>${escapeHtml(awayName)} at ${escapeHtml(homeName)}</h2>
    <p>${escapeHtml(formatTip(slateGame.start_time))}</p>
    <p class="matchup-verdict" data-verdict="${VERDICT}">${VERDICT}</p>
    <p class="matchup-note">The simulator is unvalidated. Calibrated is false. This report is descriptive.</p>
    ${league}
    ${season}
    ${thin}
    <div class="matchup-sides">
      ${teamHtml(awayName, report.away, context?.away, awayEntry, version)}
      ${teamHtml(homeName, report.home, context?.home, homeEntry, version)}
    </div>
    <section>
      <h3>Injuries</h3>
      ${injuryHtml(rate?.players ?? [])}
    </section>
    <section>
      <h3>Points allowed</h3>
      ${defenseHtml(rate, card)}
    </section>
    <p class="matchup-omission">No simulated winner, score, margin, total, or win chance. No posted spread, total, moneyline, or price. No blowout rate.</p>
  </article>`;
}

export function renderMatchups(file: MatchupsFile | null, slate: Slate, card: RateCard): string {
  if (!file || !reportMatchesCard(file, card)) return '<p class="matchup-miss">The report is not for this card.</p>';
  const byId = new Map(file.games.map((game) => [game.event_id, game]));
  const rates = new Map(card.games.map((game) => [game.event_id, game]));
  const games = slate.games.map((game) => gameHtml(game, byId.get(game.event_id), rates.get(game.event_id) ?? null, card)).join('');
  return `<div class="matchup-page">${games}</div>`;
}

export function boardControlsHtml(view: BoardSubview): string {
  const shop = view === 'shop';
  return `<div class="board-switch" role="group" aria-label="Board view">
    <button type="button" data-board-view="shop" aria-pressed="${shop ? 'true' : 'false'}">Prices</button>
    <button type="button" data-board-view="matchups" aria-pressed="${shop ? 'false' : 'true'}">Matchups</button>
  </div>`;
}
