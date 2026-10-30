import { formatTip } from './date.ts';
import { playerHeadshotUrl } from './display.ts';
import { escapeHtml, statusLabel, teamLogoMarkup } from './slate.ts';
import {
  decideVerdict,
  formatFairPrice,
  parseBookPrice,
  priceError,
  propContextFromPlayer,
  quoteProp,
  type PlayerSample,
  type PriceStyle,
  type PropMarket,
  type PropSide,
} from './props.ts';
import type { MarginForecast, MarginalRead, SimulatedPlayer, SimulatedTeam, Simulation } from './simulate.ts';
import type { ColumnKey, RatePlayer, SlateGame, TeamSide } from './types.ts';

export type BoxScenario = 'median' | 'upside';

const UPSIDE_LABEL = 'Explore simulations: one high-total game from the 10,000. The winner and the leading scorer can differ from the forecast.';

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

function expectedValue(player: SimulatedPlayer, key: ColumnKey): number | null {
  const expectation = player.expectation;
  if (!expectation) return null;
  if (key === 'min') return expectation.minMean;
  if (key === 'pts') return expectation.ptsMean;
  if (key === 'reb') return expectation.rebMean;
  if (key === 'ast') return expectation.astMean;
  return expectation.counts?.[key as keyof NonNullable<typeof expectation.counts>] ?? null;
}

function expectedCell(player: SimulatedPlayer, key: ColumnKey): string {
  const value = expectedValue(player, key);
  if (value === null) return `<td data-col="${key}">—</td>`;
  const shown = value.toFixed(1);
  if (key === 'min' && player.expectation) {
    return `<td data-col="min"><span class="stat">${shown}</span><span class="pct">${player.expectation.minP10}–${player.expectation.minP90}</span></td>`;
  }
  if (key === 'pts' && player.expectation) {
    return `<td data-col="pts"><span class="stat">${shown}</span><span class="pct">${player.expectation.ptsP10}–${player.expectation.ptsP90}</span></td>`;
  }
  return `<td data-col="${key}">${shown}</td>`;
}

function playerRow(player: SimulatedPlayer, expected: boolean): string {
  const held = heldLabel(player);
  const cells = COLUMNS.map((column) => {
    if (expected && player.expectation) return expectedCell(player, column.key);
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

function sortValue(player: SimulatedPlayer, key: ColumnKey, expected: boolean): number {
  if (expected) {
    const value = expectedValue(player, key);
    if (value !== null) return value;
  }
  return player[key];
}

function teamSection(side: string, team: SimulatedTeam, sort: BoxSort, expected: boolean): string {
  const players = team.players.slice();
  const active = players.filter((player) => player.minutes_weight !== 0);
  const inactive = players.filter((player) => player.minutes_weight === 0);
  const direction = sort.direction === 'asc' ? 1 : -1;
  active.sort((a, b) => {
    const delta = sortValue(a, sort.key, expected) - sortValue(b, sort.key, expected);
    if (delta !== 0) return delta * direction;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  inactive.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const rows = [...active, ...inactive].map((player) => playerRow(player, expected)).join('');
  if (!expected) return `${rows}${footerRow(side, team)}`;
  const totals = {
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
  for (const player of team.players) {
    totals.min += player.expectation?.minMean ?? 0;
    totals.pts += player.expectation?.ptsMean ?? 0;
    totals.reb += player.expectation?.rebMean ?? 0;
    totals.ast += player.expectation?.astMean ?? 0;
  }
  const cells = COLUMNS.map((column) => {
    if (column.key === 'fgm' || column.key === 'fga' || column.key === 'tpm' || column.key === 'tpa' || column.key === 'ftm' || column.key === 'fta') {
      return `<td data-col="${column.key}">—</td>`;
    }
    return `<td data-col="${column.key}">${Math.round(totals[column.key])}</td>`;
  }).join('');
  return `${rows}<tr data-footer="${side}"><th scope="row">Expected</th>${cells}</tr>`;
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

function boxTable(side: 'away' | 'home', slateSide: TeamSide, team: SimulatedTeam, sort: BoxSort, expected: boolean): string {
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
      <tbody>${teamSection(side, team, sort, expected)}</tbody>
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
  const expected = scenario !== 'upside' && shown.away.players.some((player) => player.expectation);
  const eventId = textOf(rate?.event_id) || textOf(game.event_id);
  const note =
    scenario === 'upside'
      ? UPSIDE_LABEL
      : expected
        ? 'Each row is that player\'s average across all 10,000 games, including games they sit. The range under minutes and points is that player\'s own 10th to 90th percentile. It is not one box score.'
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
      ${boxTable('away', game.away, shown.away, sort.away, expected)}
      ${boxTable('home', game.home, shown.home, sort.home, expected)}
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
    sentences.push('Missing shooting: shot mix and accuracy use team/position priors. When at least three counting games exist, attempts are rescaled to the observed points rate.');
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
    sentences.push('Uncertain availability reduces participation and widens minutes conditional on playing. These status probabilities are uncalibrated scenario priors.');
  }
  if (weight === 1 && questionable === false) sentences.push('No absence flag on the card.');
  const participation=readNumber(row,'play_probability');
  if(participation!==undefined)sentences.push(`Input P(play): ${(participation*100).toFixed(1)}%. Joint draws are conditioned on a feasible rotation; the simulated play share can differ.`);
  const role=readString(row,'minutes_source');
  if(role)sentences.push(role);
  if (status === undefined) sentences.push('Injury status is not in the data.');
  if (scenario === 'upside') {
    sentences.push('This line is from the upside scenario: the 95th percentile of the combined score. Not the forecast.');
  } else {
    sentences.push(
      'The table shows this player\'s average across all 10,000 games. A 40-point game can still happen in the tail. It is not the line from one draw.',
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
      `<li>${escapeHtml(`Team volume shock this draw: ${shock.toFixed(2)}. Legacy volume multiplier; possession-model cards instead use shared pace and opponent-adjusted efficiency.`)}</li>`,
    );
  } else {
    items.push('<li>Team volume shock is not in the data.</li>');
  }
  if (score.overtime) {
    items.push(`<li>${escapeHtml(`This draw used ${teamMinutes} team-minutes (5 × ${playerMinutes}).`)}</li>`);
  }
  return `<ul class="rates">${items.join('')}</ul>`;
}

function expectedLine(line: SimulatedPlayer): string {
  const e=line.expectation!;
  const fields=[['MIN',e.minMean],['FGM',e.counts?.fgm],['FGA',e.counts?.fga],['3PM',e.counts?.tpm],['FTM',e.counts?.ftm],['FTA',e.counts?.fta],['PTS',e.ptsMean],['REB',e.rebMean],['AST',e.astMean],['STL',e.counts?.stl],['BLK',e.counts?.blk]] as const;
  return `<dl class="line">${fields.map(([k,v])=>`<dt>${k}</dt><dd>${v===undefined?'—':v.toFixed(1)}</dd>`).join('')}</dl><p>All-draw averages, including simulated DNPs. Plays in ${(e.playRate*100).toFixed(1)}% of draws. Prop probabilities below exclude DNPs and pushes.</p>`;
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
  return `<div class="photo"><img referrerpolicy="no-referrer" class="headshot" alt="${escapeHtml(name)}" src="${escapeHtml(url)}" width="56" height="56"><span class="mono" hidden>${letter}</span></div><p class="photo-note" hidden>Photo is not in the data.</p>`;
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

export interface PropFormState {
  market: PropMarket;
  side: PropSide;
  line: string;
  style: PriceStyle;
  odds: string;
  opposite: string;
}

export const DEFAULT_PROP_FORM: PropFormState = {
  market: 'pts',
  side: 'over',
  line: '',
  style: 'american',
  odds: '',
  opposite: '',
};

export type PanelTab = 'forecast' | 'props';

function percent(value: number): string {
  const tenths = Math.round(value * 1000) / 10;
  const text = Number.isInteger(tenths) ? tenths.toFixed(0) : tenths.toFixed(1);
  return `${text}%`;
}

const MARKET_LABEL: Record<PropMarket, string> = {
  pts: 'points',
  reb: 'rebounds',
  ast: 'assists',
  pra: 'points + rebounds + assists',
  tpm: 'threes', stl: 'steals', blk: 'blocks', tov: 'turnovers',
};

function signedPoints(value: number): string {
  const points = value * 100;
  return `${points >= 0 ? '+' : ''}${points.toFixed(1)} pp`;
}

export function renderPropResults(
  score: Simulation,
  athleteId: string,
  form: PropFormState,
  player: Parameters<typeof propContextFromPlayer>[0] = null,
): string {
  const sample = score.playerDraws?.get(athleteId) ?? null;
  if (!sample) return '<p class="prop-note">This player\'s simulations are not in the data.</p>';
  if (form.line.trim() === '' || form.odds.trim() === '') {
    return '<p class="prop-note">Enter a line and a price: American -110, multiplier 1.91, or percent 52.4. The book is not used in the simulation.</p>';
  }
  const line = Number(form.line);
  if(!Number.isFinite(line)||line<0||!Number.isInteger(line*2))return '<p class="prop-note">Enter a nonnegative whole or half-point line.</p>';
  if((form.market==='stl'||form.market==='blk'||form.market==='tov')&&!sample[form.market])return '<p class="prop-note">This stat is missing from the older card.</p>';
  const price = parseBookPrice(form.odds, form.style);
  if (!price) return `<p class="prop-note">${escapeHtml(priceError(form.odds, form.style))}</p>`;
  const opposite = form.opposite.trim() === '' ? null : parseBookPrice(form.opposite, form.style);
  if(form.opposite.trim()!==''&&!opposite)return '<p class="prop-note">The opposite-side price is invalid.</p>';
  const quote = quoteProp(sample as PlayerSample, form.market, form.side, line, price, opposite);
  if (!quote || quote.breakEven === null || quote.expectedReturn === null) {
    return `<p class="prop-note">${escapeHtml(priceError(form.odds, form.style))}</p>`;
  }
  const verdict = decideVerdict(quote, propContextFromPlayer(player), form.market);
  if (!verdict) return `<p class="prop-note">${escapeHtml(priceError(form.odds, form.style))}</p>`;
  const stats =
    quote.modelProbability === null || quote.edge === null
      ? ''
      : `<dl class="verdict-stats">
          <div><dt>Model chance</dt><dd>${percent(quote.modelProbability)}</dd></div>
          <div><dt>Book break-even</dt><dd>${percent(quote.breakEven)}</dd></div>
          <div><dt>Estimated edge</dt><dd>${signedPoints(quote.edge)}</dd></div>
        </dl>`;
  const side = form.side === 'over' ? 'Over' : 'Under';
  const caption = `${side} ${form.line} ${MARKET_LABEL[form.market]}`;
  const fair = quote.modelProbability === null ? 'not in the data' : (formatFairPrice(quote.modelProbability, price.style) ?? 'not in the data');
  const error = quote.standardError === null ? '' : ` Sampling noise about ±${(quote.standardError * 1.96 * 100).toFixed(1)} pp.`;
  const modelWidth = quote.modelProbability === null ? 0 : Math.max(0, Math.min(100, quote.modelProbability * 100));
  const bookWidth = Math.max(0, Math.min(100, quote.breakEven * 100));
  const oppositeNote =
    form.opposite.trim() !== '' && opposite === null
      ? '<p>The opposite price was not valid in this format, so the no-vig price is left out.</p>'
      : '';
  const noVig = quote.noVig === null ? '' : `<p>No-vig price on this side: ${percent(quote.noVig)}. That is not the break-even of the price you would bet.</p>`;
  return `<div class="prop-results">
    <p class="prop-caption">${escapeHtml(caption)}</p>
    <p class="verdict-mark ${verdict.verdict.toLowerCase()}">${verdict.verdict}</p>
    ${stats}
    <p class="verdict-why">Why: ${escapeHtml(verdict.text)}</p>
    <details class="prop-advanced">
      <summary>Advanced details</summary>
      <p>Expected return per $1 risked ${(quote.expectedReturn * 100).toFixed(1)}%</p>
      <p>Read as ${escapeHtml(price.label)}</p>
      <p>Model fair price ${escapeHtml(fair)}</p>
      <p>${quote.grade.wins} wins, ${quote.grade.losses} losses, ${quote.grade.pushes} pushes, ${quote.grade.voids} did not play, out of ${sample.min.length}.${error}</p>
      <div class="prop-compare" role="img" aria-label="Model ${quote.modelProbability === null ? 'not graded' : percent(quote.modelProbability)} versus book ${percent(quote.breakEven)}">
        <div class="prop-row"><span>Model</span><span class="prop-track"><span class="prop-fill model" style="width:${modelWidth}%"></span></span></div>
        <div class="prop-row"><span>Book</span><span class="prop-track"><span class="prop-fill book" style="width:${bookWidth}%"></span></span></div>
      </div>
      ${oppositeNote}
      ${noVig}
    </details>
  </div>`;
}

function propFormMarkup(form: PropFormState): string {
  const markets: { value: PropMarket; label: string }[] = [
    { value: 'pts', label: 'Points' },
    { value: 'reb', label: 'Rebounds' },
    { value: 'ast', label: 'Assists' },
    { value: 'pra', label: 'Points + rebounds + assists' },
    { value: 'tpm', label: 'Three-pointers made' },
    { value: 'stl', label: 'Steals' }, { value: 'blk', label: 'Blocks' }, { value: 'tov', label: 'Turnovers' },
  ];
  const options = markets
    .map((market) => `<option value="${market.value}"${form.market === market.value ? ' selected' : ''}>${market.label}</option>`)
    .join('');
  const styles: { value: PriceStyle; label: string }[] = [
    { value: 'american', label: 'American odds' },
    { value: 'multiplier', label: 'Multiplier' },
    { value: 'percent', label: 'Percent' },
  ];
  const styleOptions = styles
    .map((style) => `<option value="${style.value}"${form.style === style.value ? ' selected' : ''}>${style.label}</option>`)
    .join('');
  const priceLabel = form.style === 'multiplier' ? 'Multiplier' : form.style === 'percent' ? 'Percent' : 'American odds';
  const placeholder = form.style === 'multiplier' ? '1.91' : form.style === 'percent' ? '52.4' : '-110';
  return `<form class="prop-form" data-prop-form>
    <label>Market <select data-prop-market>${options}</select></label>
    <fieldset>
      <legend>Bet direction</legend>
      <label><input type="radio" name="prop-side" value="over" data-prop-side${form.side === 'over' ? ' checked' : ''}> Over</label>
      <label><input type="radio" name="prop-side" value="under" data-prop-side${form.side === 'under' ? ' checked' : ''}> Under</label>
    </fieldset>
    <label>Prop line <input data-prop-line inputmode="decimal" value="${escapeHtml(form.line)}"></label>
    <label>Price format <select data-prop-style>${styleOptions}</select></label>
    <label>${priceLabel} <input data-prop-odds inputmode="decimal" placeholder="${placeholder}" value="${escapeHtml(form.odds)}"></label>
    <label>Opposite side, same format, optional <input data-prop-opposite inputmode="decimal" placeholder="${placeholder}" value="${escapeHtml(form.opposite)}"></label>
    <p class="prop-note">The same price three ways: -110, 1.91x, or 52.4%. A trailing x or % sets the format for that box.</p>
  </form>`;
}

export function renderPlayerPanel(
  game: SlateGame,
  rate: PanelRate | null,
  score: Simulation,
  athleteId: string,
  scenario: BoxScenario = 'median',
  tab: PanelTab = 'forecast',
  form: PropFormState = DEFAULT_PROP_FORM,
): string {
  const shown = presented(score, scenario);
  const line = findLine(shown, athleteId);
  if (!line) {
    return `<button type="button" data-close>Close</button><p>This player is not in the data.</p>`;
  }
  const row = rate?.players.find((player) => player.athlete_id === athleteId) ?? null;
  const sentences = whySentences(row, scenario).map((sentence) => `<p>${escapeHtml(sentence)}</p>`).join('');
  const forecastHidden = tab === 'props' ? ' hidden' : '';
  const propsHidden = tab === 'forecast' ? ' hidden' : '';
  return `<button type="button" data-close>Close</button>
    ${whoBlock(game, line, row)}
    <div class="panel-tabs" role="tablist">
      <button type="button" role="tab" id="forecast-tab" aria-controls="forecast-panel" tabindex="${tab==='forecast'?0:-1}" data-panel-tab="forecast" aria-selected="${tab === 'forecast' ? 'true' : 'false'}">Player Forecast</button>
      <button type="button" role="tab" id="props-tab" aria-controls="props-panel" tabindex="${tab==='props'?0:-1}" data-panel-tab="props" aria-selected="${tab === 'props' ? 'true' : 'false'}">Prop Analyzer</button>
    </div>
    <div role="tabpanel" id="forecast-panel" aria-labelledby="forecast-tab" data-panel-view="forecast"${forecastHidden}>
      <h3>${scenario !== 'upside' && line.expectation ? 'Expected line' : 'One simulated draw'}</h3>
      ${scenario !== 'upside' && line.expectation ? expectedLine(line) : drawnLine(line)}
      <h3>Why</h3>
      <div class="why">${sentences}</div>
      <h3>Shrunk rates on the card</h3>
      ${samplingList(row, shown, shockFor(shown, line.team_id))}
    </div>
    <div role="tabpanel" id="props-panel" aria-labelledby="props-tab" data-panel-view="props"${propsHidden}>
      <h3>Prop Analyzer</h3>
      <p class="prop-note">The sportsbook is compared after the 10,000 games. It does not change them.</p>
      ${propFormMarkup(form)}
      <div data-prop-results aria-live="polite">${renderPropResults(score, athleteId, form, row)}</div>
    </div>`;
}
