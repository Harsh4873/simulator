import { formatTip } from './date.ts';
import { playerHeadshotUrl } from './display.ts';
import { escapeHtml, statusLabel, teamLogoMarkup } from './slate.ts';
import type { MarginForecast, MarginalRead, SimulatedPlayer, SimulatedTeam, Simulation } from './simulate.ts';
import type { ColumnKey, RatePlayer, SlateGame, TeamSide } from './types.ts';

export type BoxScenario = 'median' | 'upside';

const UPSIDE_LABEL = 'Upside scenario: the 95th percentile of the combined score. Not the forecast.';

const COLUMNS: { key: ColumnKey; label: string }[] = [
  { key: 'min', label: 'MIN' },
  { key: 'fgm', label: 'FGM' },
  { key: 'fga', label: 'FGA' },
  { key: 'tpm', label: '3PM' },
  { key: 'tpa', label: '3PA' },
  { key: 'ftm', label: 'FTM' },
  { key: 'fta', label: 'FTA' },
  { key: 'pts', label: 'PTS' },
  { key: 'reb', label: 'REB' },
  { key: 'ast', label: 'AST' },
];

const COLUMN_KEYS = new Set<string>(COLUMNS.map((column) => column.key));

export type SortDirection = 'asc' | 'desc';

export interface BoxSort {
  key: ColumnKey;
  direction: SortDirection;
}

export const DEFAULT_BOX_SORT: BoxSort = { key: 'min', direction: 'desc' };

export interface SideSorts {
  away: BoxSort;
  home: BoxSort;
}

export const DEFAULT_SIDE_SORTS: SideSorts = {
  away: DEFAULT_BOX_SORT,
  home: DEFAULT_BOX_SORT,
};

export function isColumnKey(value: string): value is ColumnKey {
  return COLUMN_KEYS.has(value);
}

export function nextBoxSort(current: BoxSort, key: ColumnKey): BoxSort {
  if (current.key !== key) return { key, direction: 'desc' };
  return { key, direction: current.direction === 'desc' ? 'asc' : 'desc' };
}

const TONE_KEYS = new Set<ColumnKey>(['min', 'tpm', 'pts', 'reb', 'ast']);

type Counting = Pick<SimulatedPlayer, ColumnKey>;

type CardRow = Partial<RatePlayer>;

export interface PanelRate {
  event_id?: string;
  players: readonly CardRow[];
}

const RATE_LINES: { key: keyof RatePlayer; label: string }[] = [
  { key: 'fga_per_min', label: 'Field-goal attempts per minute' },
  { key: 'fta_per_min', label: 'Free-throw attempts per minute' },
  { key: 'tpa_given_fga', label: 'Three-point attempt share of field-goal attempts' },
  { key: 'fg2_pct', label: 'Two-point make rate' },
  { key: 'tp_pct', label: 'Three-point make rate' },
  { key: 'ft_pct', label: 'Free-throw make rate' },
  { key: 'reb_per_min', label: 'Rebounds per minute' },
  { key: 'ast_per_min', label: 'Assists per minute' },
];

export function columnSums(players: Counting[]): Record<ColumnKey, number> {
  const sums: Record<ColumnKey, number> = {
    min: 0,
    fgm: 0,
    fga: 0,
    tpm: 0,
    tpa: 0,
    ftm: 0,
    fta: 0,
    pts: 0,
    reb: 0,
    ast: 0,
  };
  for (const player of players) {
    for (const column of COLUMNS) sums[column.key] += player[column.key];
  }
  return sums;
}

function byName(a: SimulatedPlayer, b: SimulatedPlayer): number {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  if (a.athlete_id < b.athlete_id) return -1;
  if (a.athlete_id > b.athlete_id) return 1;
  return 0;
}

export function orderPlayers(players: SimulatedPlayer[], sort: BoxSort = DEFAULT_BOX_SORT): SimulatedPlayer[] {
  const active = players.filter((player) => player.minutes_weight !== 0);
  const inactive = players.filter((player) => player.minutes_weight === 0);
  const direction = sort.direction === 'asc' ? 1 : -1;
  active.sort((a, b) => {
    const delta = a[sort.key] - b[sort.key];
    if (delta !== 0) return delta * direction;
    return byName(a, b);
  });
  inactive.sort(byName);
  return [...active, ...inactive];
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function teamAbbr(side: TeamSide): string {
  const abbr = textOf(side.abbreviation);
  if (abbr) return abbr;
  return textOf(side.name);
}

function teamTitle(side: TeamSide): string {
  const name = textOf(side.name);
  if (name) return name;
  return textOf(side.abbreviation);
}

function teamName(game: SlateGame, teamId: string): string | null {
  if (game.away?.team_id === teamId) {
    const name = teamTitle(game.away);
    return name || null;
  }
  if (game.home?.team_id === teamId) {
    const name = teamTitle(game.home);
    return name || null;
  }
  return null;
}

function countPercent(count: number, total: number): string {
  if (!(total > 0)) return '0.0';
  return ((count / total) * 100).toFixed(1);
}

function heldLabel(player: Pick<SimulatedPlayer, 'minutes_weight' | 'injury_status'>): string | null {
  if (player.minutes_weight !== 0) return null;
  const status = textOf(player.injury_status);
  return status || 'not in the data';
}

function toneCell(key: ColumnKey, value: number, read: MarginalRead | undefined, held: string | null): string {
  if (!TONE_KEYS.has(key)) return `<td data-col="${key}">${value}</td>`;
  if (held !== null) {
    return `<td data-col="${key}"><span class="stat">${value}</span><span class="pct">${escapeHtml(held)}</span></td>`;
  }
  if (!read || read.constant) {
    const bucket = read?.constant ? ' data-bucket="0"' : '';
    return `<td data-col="${key}"${bucket}><span class="stat">${value}</span></td>`;
  }
  return `<td data-col="${key}" data-bucket="${read.bucket}"><span class="stat">${value}</span><span class="pct">${read.percent}%</span></td>`;
}

function toneSpan(value: number, read: MarginalRead | undefined, held: string | null): string {
  if (held !== null) {
    return `<span class="tone"><span class="stat">${value}</span><span class="pct">${escapeHtml(held)}</span></span>`;
  }
  if (!read || read.constant) {
    const bucket = read?.constant ? ' data-bucket="0"' : '';
    return `<span class="tone"${bucket}><span class="stat">${value}</span></span>`;
  }
  return `<span class="tone" data-bucket="${read.bucket}"><span class="stat">${value}</span><span class="pct">${read.percent}%</span></span>`;
}

function readOf(player: SimulatedPlayer, key: 'min' | 'tpm' | 'pts' | 'reb' | 'ast'): MarginalRead | undefined {
  return player.reads?.[key];
}

function playerRow(player: SimulatedPlayer): string {
  const held = heldLabel(player);
  const cells = COLUMNS.map((column) => {
    if (column.key === 'min' || column.key === 'tpm' || column.key === 'pts' || column.key === 'reb' || column.key === 'ast') {
      return toneCell(column.key, player[column.key], readOf(player, column.key), held);
    }
    return `<td data-col="${column.key}">${player[column.key]}</td>`;
  }).join('');
  const id = escapeHtml(player.athlete_id);
  return `<tr>
    <th scope="row"><button type="button" class="player-btn" data-athlete="${id}">${escapeHtml(player.name)}</button></th>
    ${cells}
  </tr>`;
}

function footerRow(side: string, team: SimulatedTeam): string {
  const sums = columnSums(team.players);
  const cells = COLUMNS.map((column) => {
    if (column.key === 'pts') return toneCell('pts', sums.pts, team.pointsRead, null);
    return `<td data-col="${column.key}">${sums[column.key]}</td>`;
  }).join('');
  return `<tr data-footer="${side}"><th scope="row">Total</th>${cells}</tr>`;
}

function teamSection(side: string, team: SimulatedTeam, sort: BoxSort): string {
  const rows = orderPlayers(team.players, sort).map(playerRow).join('');
  return `${rows}${footerRow(side, team)}`;
}

function sortMark(sort: BoxSort, key: ColumnKey): string {
  if (sort.key !== key) return '';
  return sort.direction === 'desc' ? ' ↓' : ' ↑';
}

function sortPressed(sort: BoxSort, key: ColumnKey): string {
  return sort.key === key ? 'true' : 'false';
}

function sortBar(side: 'away' | 'home', name: string, sort: BoxSort): string {
  const buttons = COLUMNS.map((column) => {
    const pressed = sortPressed(sort, column.key);
    return `<button type="button" class="sort-toggle" data-side="${side}" data-sort="${column.key}" aria-pressed="${pressed}">${column.label}${sortMark(sort, column.key)}</button>`;
  }).join('');
  return `<div class="sort-bar" role="group" aria-label="Sort ${escapeHtml(name)}">${buttons}</div>`;
}

function tailMarkup(side: string, read: MarginalRead | undefined): string {
  if (!read || read.constant) return '';
  return `<p class="team-pct ${side} tone" data-bucket="${read.bucket}">${read.percent}%</p>`;
}

function presented(score: Simulation, scenario: BoxScenario): Simulation {
  if (scenario !== 'upside') return score;
  return {
    ...score,
    overtime: score.upside.overtime,
    budget: score.upside.budget,
    overtimePeriods: score.upside.overtimePeriods,
    regulationAwayPts: score.upside.regulationAwayPts,
    regulationHomePts: score.upside.regulationHomePts,
    away: score.upside.away,
    home: score.upside.home,
  };
}

function periodCount(score: Pick<Simulation, 'overtime' | 'budget'>): number {
  if (!score.overtime) return 0;
  return Math.max(1, Math.round((score.budget - 240) / 25));
}

function minutesMarkup(score: Pick<Simulation, 'overtime' | 'budget'>): string {
  if (!score.overtime) return '<span class="ot-minutes">240 team-minutes · 5 × 48</span>';
  const periods = periodCount(score);
  const teamMinutes = 240 + 25 * periods;
  const playerMinutes = 48 + 5 * periods;
  return `<span class="ot">OT</span><span class="ot-minutes">${teamMinutes} team-minutes · 5 × ${playerMinutes}</span>`;
}

function scoreboard(game: SlateGame, score: Simulation, scenario: BoxScenario, forecast?: MarginForecast): string {
  const wins = score.wins ?? { away: 0, tie: 0, home: 0 };
  const total = wins.away + wins.tie + wins.home;
  const awayPct = countPercent(wins.away, total);
  const tiePct = countPercent(wins.tie, total);
  const homePct = countPercent(wins.home, total);
  const label = `Away wins ${awayPct}%. Tie ${tiePct}%. Home wins ${homePct}%.`;
  const useMeans = scenario !== 'upside' && forecast !== undefined;
  const awayScore = useMeans ? Math.round(forecast.awayMean) : score.away.pts;
  const homeScore = useMeans ? Math.round(forecast.homeMean) : score.home.pts;
  const caption = scenario === 'upside'
    ? UPSIDE_LABEL
    : useMeans
      ? 'Expected points from 10,000 games'
      : 'Nearest the median combined score';
  const margin = useMeans
    ? `<p class="margin-caption">Mean margin ${forecast.marginMean >= 0 ? '+' : ''}${forecast.marginMean.toFixed(1)} home. Median margin ${forecast.marginMedian >= 0 ? '+' : ''}${forecast.marginMedian.toFixed(1)}. Home by 10+ ${(forecast.homeBy10 * 100).toFixed(1)}%. Home by 20+ ${(forecast.homeBy20 * 100).toFixed(1)}%. Away by 10+ ${(forecast.awayBy10 * 100).toFixed(1)}%. Away by 20+ ${(forecast.awayBy20 * 100).toFixed(1)}%.</p>`
    : '';
  return `<div class="scoreboard">
    <div class="team-head away">${teamLogoMarkup(game.away)}<p class="abbr away">${escapeHtml(teamAbbr(game.away))}</p></div>
    <div class="bar-slot">
      <div class="winbar" role="img" aria-label="${label}">
        <span class="seg seg-away" style="flex-grow: ${wins.away}"></span>
        <span class="seg seg-tie" style="flex-grow: ${wins.tie}"></span>
        <span class="seg seg-home" style="flex-grow: ${wins.home}"></span>
      </div>
    </div>
    <div class="team-head home">${teamLogoMarkup(game.home)}<p class="abbr home">${escapeHtml(teamAbbr(game.home))}</p></div>
    <p class="club-name away">${escapeHtml(teamTitle(game.away))}</p>
    <p class="club-name home">${escapeHtml(teamTitle(game.home))}</p>
    <p class="score away">${awayScore}</p>
    <p class="score home">${homeScore}</p>
    <p class="interval away">${score.away.band.p05}–${score.away.band.p95}</p>
    <p class="interval home">${score.home.band.p05}–${score.home.band.p95}</p>
    <p class="interval-caption">5th to 95th percentile</p>
    <p class="percentile-caption">${caption}</p>
    ${margin}
    ${tailMarkup('away', score.away.pointsRead)}
    ${tailMarkup('home', score.home.pointsRead)}
    <p class="win-pct win-away">${awayPct}%</p>
    <p class="tie-line">Tie ${tiePct}%</p>
    <p class="win-pct win-home">${homePct}%</p>
    <p class="win-caption">Win rate in 10,000 games</p>
  </div>`;
}

function boxTable(side: 'away' | 'home', slateSide: TeamSide, team: SimulatedTeam, sort: BoxSort): string {
  const head = COLUMNS.map((column) => {
    const aria = sort.key === column.key ? (sort.direction === 'desc' ? 'descending' : 'ascending') : 'none';
    return `<th aria-sort="${aria}"><button type="button" class="sort-toggle" data-side="${side}" data-sort="${column.key}" aria-pressed="${sortPressed(sort, column.key)}">${column.label}${sortMark(sort, column.key)}</button></th>`;
  }).join('');
  const name = teamTitle(slateSide);
  return `<section class="team-box" data-side="${side}">
    <h2>${escapeHtml(name)}</h2>
    ${sortBar(side, name, sort)}
    <div class="table-scroll"><table>
      <thead><tr><th>Player</th>${head}</tr></thead>
      <tbody>${teamSection(side, team, sort)}</tbody>
    </table></div>
  </section>`;
}

export function renderBoxScore(
  game: SlateGame,
  rate: PanelRate | null,
  score: Simulation,
  now: Date,
  sort: SideSorts = DEFAULT_SIDE_SORTS,
  scenario: BoxScenario = 'median',
): string {
  const shown = presented(score, scenario);
  const eventId = textOf(rate?.event_id) || textOf(game.event_id);
  const note =
    scenario === 'upside'
      ? UPSIDE_LABEL
      : score.forecast
        ? 'The score above is the mean of 10,000 games. This box score is one draw near those team means. It is not each player\'s expected line. The percent in a cell is that stat\'s percentile rank, not a win probability.'
        : 'This box score is the simulated game nearest the median combined score. The range under each score is the 5th to 95th percentile.';
  const upsideChecked = scenario === 'upside' ? ' checked' : '';
  return `<div data-event="${escapeHtml(eventId)}">
      <button type="button" data-back>Back to slate</button>
      ${scoreboard(game, shown, scenario, score.forecast)}
      <p class="status-row">
        <span class="tip">${escapeHtml(formatTip(game.start_time))}</span>
        <span class="status">${escapeHtml(statusLabel(game, now))}</span>
        ${minutesMarkup(shown)}
      </p>
      <label class="color-choice"><input type="checkbox" data-probability-colors> Probability colors</label>
      <label class="scenario-choice"><input type="checkbox" data-upside-scenario${upsideChecked}> ${UPSIDE_LABEL}</label>
      ${boxTable('away', game.away, shown.away, sort.away)}
      ${boxTable('home', game.home, shown.home, sort.home)}
      <p class="note">${note}</p>
      <p class="note">The minutes column totals team-minutes: five players on the floor at once. Regulation is 240 (5 × 48). Overtime is 265 (5 × 53). It is not the length of the game.</p>
      <p class="legend">Brighter blue means that number is further from this player's middle in the 10,000 games. The percent is the share of those games at or below the number shown.</p>
    </div>`;
}

function field(row: CardRow | null, key: keyof RatePlayer): unknown {
  if (!row || !Object.prototype.hasOwnProperty.call(row, key)) return undefined;
  const value = row[key];
  if (value === undefined || value === null) return undefined;
  return value;
}

function readNumber(row: CardRow | null, key: keyof RatePlayer): number | undefined {
  const value = field(row, key);
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

function readBoolean(row: CardRow | null, key: keyof RatePlayer): boolean | undefined {
  const value = field(row, key);
  if (typeof value !== 'boolean') return undefined;
  return value;
}

function readString(row: CardRow | null, key: keyof RatePlayer): string | undefined {
  const value = field(row, key);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readWeight(row: CardRow | null): 0 | 1 | undefined {
  const value = field(row, 'minutes_weight');
  if (value === 0 || value === 1) return value;
  return undefined;
}

function findLine(score: Simulation, athleteId: string): SimulatedPlayer | null {
  return (
    score.away.players.find((player) => player.athlete_id === athleteId) ??
    score.home.players.find((player) => player.athlete_id === athleteId) ??
    null
  );
}

function shockFor(score: Simulation, teamId: string): number | undefined {
  if (teamId === score.away.team_id) return score.away.volumeShock;
  if (teamId === score.home.team_id) return score.home.volumeShock;
  return undefined;
}

function whySentences(row: CardRow | null, scenario: BoxScenario): string[] {
  const sentences: string[] = [];
  if (!row) sentences.push('This player is not on the rate card.');
  const games2026 = readNumber(row, 'games_2026');
  const games2027 = readNumber(row, 'games_2027');
  if (games2026 !== undefined && games2027 !== undefined) {
    sentences.push(`Prior season (2026): ${games2026} games. This season (2027): ${games2027} games.`);
  }
  const games = readNumber(row, 'games');
  const shooting = readNumber(row, 'shooting_games');
  const missing = readBoolean(row, 'missing_shooting');
  if (games !== undefined && shooting !== undefined && shooting !== games) {
    sentences.push(`Shooting sample: ${shooting} games.`);
  }
  if (shooting === 0 || missing === true) {
    sentences.push('Shot rates are the team and position prior.');
  }
  if (games2026 === 0 && games2027 !== undefined && games2027 < 8) {
    sentences.push('Thin sample: no games in 2026 and fewer than 8 in 2027.');
  }
  const weight = readWeight(row);
  const status = readString(row, 'injury_status');
  const questionable = readBoolean(row, 'questionable_widen');
  if (weight === 0 && status !== undefined) {
    sentences.push(
      `Out of the rotation (${status}). This player's line is fixed at zero because the card gives them no minutes.`,
    );
  }
  if (questionable === true) {
    sentences.push('Questionable. Minutes stay centered on the shrunk rate, with a wider draw.');
  }
  if (weight === 1 && questionable === false) sentences.push('No absence flag on the card.');
  if (status === undefined) sentences.push('Injury status is not in the data.');
  if (scenario === 'upside') {
    sentences.push('This line is from the upside scenario: the 95th percentile of the combined score. Not the forecast.');
  } else {
    sentences.push(
      'This line is from the simulated game nearest the median combined score. It is not a random draw and it is not a prediction.',
    );
  }
  return sentences;
}

function rateItem(label: string, value: string): string {
  return `<li>${escapeHtml(`${label}: ${value}`)}</li>`;
}

function samplingList(row: CardRow | null, score: Simulation, shock: number | undefined): string {
  const periods = periodCount(score);
  const teamMinutes = score.overtime ? 240 + 25 * periods : 240;
  const playerMinutes = score.overtime ? 48 + 5 * periods : 48;
  const scaled = `scaled to ${teamMinutes} team-minutes (5 × ${playerMinutes})`;
  const minutes = readNumber(row, 'minutes_mean');
  const minutesLabel = minutes === undefined ? 'not in the data' : minutes.toFixed(1);
  const items = [
    `<li>${escapeHtml(`Shrunk minutes rate: ${minutesLabel}. Active rates are ${scaled}, and this line is one share of that budget.`)}</li>`,
  ];
  for (const line of RATE_LINES) {
    const value = readNumber(row, line.key);
    items.push(rateItem(line.label, value === undefined ? 'not in the data' : value.toFixed(3)));
  }
  if (typeof shock === 'number' && Number.isFinite(shock)) {
    items.push(
      `<li>${escapeHtml(`Team volume shock this draw: ${shock.toFixed(2)}. It scales attempts, rebounds, and assists. It does not change make rates.`)}</li>`,
    );
  } else {
    items.push('<li>Team volume shock is not in the data.</li>');
  }
  if (score.overtime) {
    items.push(`<li>${escapeHtml(`This draw used ${teamMinutes} team-minutes (5 × ${playerMinutes}).`)}</li>`);
  }
  return `<ul class="rates">${items.join('')}</ul>`;
}

function drawnLine(line: SimulatedPlayer): string {
  const held = heldLabel(line);
  const fg = `${line.fgm}–${line.fga}`;
  const threes = `${toneSpan(line.tpm, readOf(line, 'tpm'), held)}–${line.tpa}`;
  const ft = `${line.ftm}–${line.fta}`;
  return `<dl class="line">
    <dt>MIN</dt><dd>${toneSpan(line.min, readOf(line, 'min'), held)}</dd>
    <dt>FG</dt><dd>${fg}</dd>
    <dt>3P</dt><dd>${threes}</dd>
    <dt>FT</dt><dd>${ft}</dd>
    <dt>PTS</dt><dd>${toneSpan(line.pts, readOf(line, 'pts'), held)}</dd>
    <dt>REB</dt><dd>${toneSpan(line.reb, readOf(line, 'reb'), held)}</dd>
    <dt>AST</dt><dd>${toneSpan(line.ast, readOf(line, 'ast'), held)}</dd>
  </dl>`;
}

function monogramLetter(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  return Array.from(trimmed)[0]?.toUpperCase() ?? '?';
}

function photoMarkup(name: string, url: string | null): string {
  const letter = escapeHtml(monogramLetter(name));
  if (!url) {
    return `<div class="photo"><span class="mono">${letter}</span></div><p class="photo-note">Photo is not in the data.</p>`;
  }
  return `<div class="photo"><img class="headshot" alt="${escapeHtml(name)}" src="${escapeHtml(url)}" width="56" height="56"><span class="mono" hidden>${letter}</span></div><p class="photo-note" hidden>Photo is not in the data.</p>`;
}

function whoBlock(game: SlateGame, line: SimulatedPlayer, row: CardRow | null): string {
  const team = teamName(game, line.team_id);
  const position = readString(row, 'position');
  const group = readString(row, 'position_group');
  const positionHtml = position
    ? `${escapeHtml(position)}${group ? ` <span class="pos-group">${escapeHtml(group)}</span>` : ''}`
    : 'Position is not in the data.';
  const url = playerHeadshotUrl({
    athlete_id: line.athlete_id,
    headshot_url: readString(row, 'headshot_url'),
  });
  return `<div class="who">
    ${photoMarkup(line.name, url)}
    <h2 class="who-name">${escapeHtml(line.name)}</h2>
    <p class="who-team">${escapeHtml(team ?? 'not in the data')}</p>
    <p class="who-pos">${positionHtml}</p>
  </div>`;
}

export function renderPlayerPanel(
  game: SlateGame,
  rate: PanelRate | null,
  score: Simulation,
  athleteId: string,
  scenario: BoxScenario = 'median',
): string {
  const shown = presented(score, scenario);
  const line = findLine(shown, athleteId);
  if (!line) {
    return `<button type="button" data-close>Close</button><p>This player is not in the data.</p>`;
  }
  const row = rate?.players.find((player) => player.athlete_id === athleteId) ?? null;
  const sentences = whySentences(row, scenario).map((sentence) => `<p>${escapeHtml(sentence)}</p>`).join('');
  return `<button type="button" data-close>Close</button>
    ${whoBlock(game, line, row)}
    <h3>This simulated game</h3>
    ${drawnLine(line)}
    <h3>Why</h3>
    <div class="why">${sentences}</div>
    <h3>Shrunk rates on the card</h3>
    ${samplingList(row, shown, shockFor(shown, line.team_id))}`;
}
