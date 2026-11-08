import { formatTip } from './date.ts';
import { paletteStyle, playerHeadshotUrl } from './display.ts';
import { avatarMarkup, escapeHtml, statusLabel, teamLogoMarkup } from './slate.ts';
import { histogramSvg } from './charts.ts';
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
import type { MarginForecast, SimulatedPlayer, SimulatedTeam, Simulation } from './simulate.ts';
import type { ColumnKey, RatePlayer, SlateGame, TeamSide } from './types.ts';

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

function toneCell(key: ColumnKey, value: number, held: string | null): string {
  if (held !== null && TONE_KEYS.has(key)) {
    return `<td data-col="${key}"><span class="stat">${value}</span><span class="pct">${escapeHtml(held)}</span></td>`;
  }
  return `<td data-col="${key}">${value}</td>`;
}

function heldSpan(value: number, held: string | null): string {
  return held === null ? String(value) : `<span class="stat">${value}</span> <span class="pct">${escapeHtml(held)}</span>`;
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
  const band=player.expectation?.bands?.[key];
  return `<td data-col="${key}">${shown}${band?`<span class="pct">${band.p10}–${band.p90}</span>`:''}</td>`;
}

function playerRow(player: SimulatedPlayer, expected: boolean): string {
  const held = heldLabel(player);
  const cells = COLUMNS.map((column) => {
    if (expected && player.expectation) return expectedCell(player, column.key);
    return toneCell(column.key, player[column.key], held);
  }).join('');
  const id = escapeHtml(player.athlete_id);
  return `<tr>
    <th scope="row"><span class="who-cell">${avatarMarkup(player.name, player.athlete_id)}<button type="button" class="player-btn" data-athlete="${id}">${escapeHtml(player.name)}</button></span></th>
    ${cells}
  </tr>`;
}

function footerRow(side: string, team: SimulatedTeam): string {
  const sums = columnSums(team.players);
  const cells = COLUMNS.map((column) => {
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

function scoreboard(game: SlateGame, score: Simulation, forecast?: MarginForecast): string {
  const wins = score.wins ?? { away: 0, tie: 0, home: 0 };
  const total = wins.away + wins.tie + wins.home;
  const awayPct = countPercent(wins.away, total);
  const tiePct = countPercent(wins.tie, total);
  const homePct = countPercent(wins.home, total);
  const label = `Away wins ${awayPct}%. Tie ${tiePct}%. Home wins ${homePct}%.`;
  const useMeans = forecast !== undefined;
  const awayScore = useMeans ? Math.round(forecast.awayMean) : score.away.pts;
  const homeScore = useMeans ? Math.round(forecast.homeMean) : score.home.pts;
  const caption = useMeans ? 'Expected points from 10,000 games' : 'Nearest the median combined score';
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
    <p class="win-pct win-away">${awayPct}%</p>
    <p class="tie-line">Tie ${tiePct}%</p>
    <p class="win-pct win-home">${homePct}%</p>
    <p class="win-caption">Win rate in 10,000 games</p>
  </div>`;
}

function distributionPanel(score:Simulation):string{
  if(!score.distributions)return '';
  return `<section class="dist-panel" aria-label="Game distributions"><h3>Check a line</h3><p>Includes overtime. Margin = home points minus away points; a positive margin favors home. Enter a margin threshold (the negative of a home spread).</p>${(['total','margin'] as const).map(kind=>{
    const d=score.distributions![kind];return `<p>${kind==='total'?'Total':'Home margin'}: mean ${d.mean.toFixed(1)}; median ${d.median.toFixed(1)}; 10–90% ${d.p10.toFixed(1)} to ${d.p90.toFixed(1)}; 5–95% ${d.p05.toFixed(1)} to ${d.p95.toFixed(1)}. Monte Carlo SE of mean ${d.standardError.toFixed(2)} (sampling noise only).</p><label>${kind} line <input type="number" step="0.5" data-game-line="${kind}"></label><p data-line-result="${kind}" role="status">Enter a line.</p>`;
  }).join('')}</section>`;
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

function signed(value: number): string {
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(1)}`;
}

export interface LineupNote {
  ruledOut: string[];
  ruledIn: string[];
}

function lineupBanner(edits: LineupNote | undefined): string {
  if (!edits || (!edits.ruledOut.length && !edits.ruledIn.length)) return '';
  const parts = [
    edits.ruledOut.length ? `Ruled out: ${edits.ruledOut.map(escapeHtml).join(', ')}` : '',
    edits.ruledIn.length ? `Ruled in: ${edits.ruledIn.map(escapeHtml).join(', ')}` : '',
  ].filter(Boolean);
  return `<div class="edit-banner" role="note"><p><strong>Your lineups.</strong> ${parts.join('. ')}.</p><button type="button" class="ghost" data-lineup-clear>Use the model</button></div>`;
}

function keyTiles(game: SlateGame, score: Simulation): string {
  const forecast = score.forecast;
  const wins = score.wins ?? { away: 0, tie: 0, home: 0 };
  const total = wins.away + wins.tie + wins.home;
  if (!forecast || !(total > 0)) return '';
  const homeFav = wins.home >= wins.away;
  const favorite = homeFav ? game.home : game.away;
  const share = (homeFav ? wins.home : wins.away) / total;
  const margin = forecast.marginMean;
  const leader = margin >= 0 ? game.home : game.away;
  const totals = score.distributions?.total;
  const expectedTotal = totals ? totals.mean : forecast.awayMean + forecast.homeMean;
  const scorers = [...score.away.players, ...score.home.players]
    .filter((p) => p.expectation)
    .sort((a, b) => (b.expectation!.ptsMean - a.expectation!.ptsMean) || (a.name < b.name ? -1 : 1));
  const top = scorers[0];
  const tile = (label: string, value: string, sub: string) => `<div class="tile"><p class="tile-label">${label}</p><p class="tile-value">${value}</p><p class="tile-sub">${sub}</p></div>`;
  return `<div class="tiles" aria-label="Key numbers">
    ${tile('Win chance', `${escapeHtml(teamAbbr(favorite))} ${(share * 100).toFixed(0)}%`, 'share of 10,000 games')}
    ${tile('Projected margin', `${escapeHtml(teamAbbr(leader))} by ${Math.abs(margin).toFixed(1)}`, `median home margin ${signed(forecast.marginMedian)}`)}
    ${tile('Projected total', expectedTotal.toFixed(1), totals ? `80% between ${totals.p10.toFixed(0)} and ${totals.p90.toFixed(0)}` : 'mean of 10,000 games')}
    ${top ? tile('Top scorer', `${top.expectation!.ptsMean.toFixed(1)}`, escapeHtml(top.name)) : ''}
  </div>`;
}

function chartsPanel(game: SlateGame, score: Simulation): string {
  if (!score.homeTotals?.length || !score.awayTotals?.length) return '';
  const margins = score.homeTotals.map((h, i) => h - score.awayTotals[i]);
  const away = escapeHtml(teamAbbr(game.away));
  const home = escapeHtml(teamAbbr(game.home));
  return `<div class="charts">
    <figure class="chart"><figcaption><span>Home margin</span><span class="legend-pair"><i class="key away"></i>${away} wins<i class="key home"></i>${home} wins</span></figcaption>${histogramSvg(margins, { label: `${home} margin (home minus away)`, binWidth: 2, split: 0, format: (v) => (v > 0 ? `+${v.toFixed(0)}` : v.toFixed(0)) })}</figure>
    <figure class="chart"><figcaption><span>Total points</span><span class="legend-pair">shaded: middle 80%</span></figcaption>${histogramSvg(score.combinedTotals, { label: 'Total points', binWidth: 4 })}</figure>
  </div>`;
}

export function renderBoxScore(
  game: SlateGame,
  rate: PanelRate | null,
  score: Simulation,
  now: Date,
  sort: SideSorts = DEFAULT_SIDE_SORTS,
  edits?: LineupNote,
): string {
  const shown = score;
  const expected = shown.away.players.some((player) => player.expectation);
  const eventId = textOf(rate?.event_id) || textOf(game.event_id);
  const note =
    expected
        ? 'Each row is that player\'s average across all 10,000 games, including games they sit, so minutes still sum to the team budget. The player panel expected line uses only draws with minutes. The range under each stat is that player\'s own 10th to 90th percentile. It is not one box score.'
        : 'This box score is the simulated game nearest the median combined score. The range under each score is the 5th to 95th percentile.';
  return `<div class="box-view" data-event="${escapeHtml(eventId)}" style="${paletteStyle(game.away, game.home)}">
      <div class="toolbar">
        <button type="button" data-back>Back to slate</button>
        <div class="toolbar-title"><h2>${escapeHtml(teamAbbr(game.away))} @ ${escapeHtml(teamAbbr(game.home))}</h2><p class="toolbar-sub">${escapeHtml(formatTip(game.start_time))}</p></div>
        <button type="button" class="ghost" data-lineup="${escapeHtml(game.event_id)}">Edit lineups</button>
      </div>
      ${lineupBanner(edits)}
      <section class="hero">${scoreboard(game, shown, score.forecast)}</section>
      <p class="status-row">
        <span class="tip">${escapeHtml(formatTip(game.start_time))}</span>
        <span class="status">${escapeHtml(statusLabel(game, now))}</span>
        ${minutesMarkup(shown)}
      </p>
      ${keyTiles(game, score)}
      ${chartsPanel(game, score)}
      ${distributionPanel(score)}
      ${boxTable('away', game.away, shown.away, sort.away, expected)}
      ${boxTable('home', game.home, shown.home, sort.home, expected)}
      ${score.thin_rotation ? '<p class="note" role="status">Thin rotation: labelled replacement-level minutes fill remaining spots from league-average rates. Those lines are not invented player stats.</p>' : ''}
      <p class="note">${note}</p>
      <p class="note">The minutes column totals team-minutes: five players on the floor at once. Regulation is 240 (5 × 48). Overtime is 265 (5 × 53). It is not the length of the game.</p>
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

interface WhyNote {
  text: string;
  kind: string;
  kicker: string;
}

function whyNotes(row: CardRow | null): WhyNote[] {
  const notes: WhyNote[] = [];
  const push = (text: string, kind: string, kicker: string) => notes.push({ text, kind, kicker });
  if (!row) push('This player is not on the rate card.', 'sample', 'Rate card');
  const games2026 = readNumber(row, 'games_2026');
  const games2027 = readNumber(row, 'games_2027');
  if (games2026 !== undefined && games2027 !== undefined) {
    push(`Prior season (2026): ${games2026} games. This season (2027): ${games2027} games.`, 'sample', 'Seasons');
  }
  const scale=readNumber(row,'points_scale');
  if(scale!==undefined)push(`Attempts scale: ${scale.toFixed(3)} from the exposure-weighted points blend.`, 'usage', 'Shot volume');
  const conditional=readNumber(row,'minutes_mean');
  if(conditional!==undefined)push(`Conditional minute target: ${conditional.toFixed(1)} before the team-minute allocation.`, 'minutes', 'Minute target');
  const restriction=readNumber(row,'minutes_restriction');
  if(restriction!==undefined)push(`Reported full-game minute cap: ${restriction}.`, 'minutes', 'Minute cap');
  if(row&&'evidence' in row&&row.evidence){
    const evidence=row.evidence as import('./model-evidence.ts').PlayerEvidence;
    const kickers = { minutes: 'Minutes evidence', shooting: 'Shooting evidence', reb: 'Rebound evidence', ast: 'Assist evidence' } as const;
    for(const key of ['minutes','shooting','reb','ast'] as const){const e=evidence[key];push(`${key}: ${e.state}; weighted exposure ${e.exposure.toFixed(1)}, prior contribution ${(100*e.prior_fraction).toFixed(1)}%, last observation ${e.last_observed??'unknown'}.`, 'evidence', kickers[key]);}
  }
  const games = readNumber(row, 'games');
  const shooting = readNumber(row, 'shooting_games');
  const missing = readBoolean(row, 'missing_shooting');
  if (games !== undefined && shooting !== undefined && shooting !== games) {
    push(`Shooting sample: ${shooting} games.`, 'shooting', 'Shooting sample');
  }
  if (shooting === 0 || missing === true) {
    push('Missing shooting: shot mix and accuracy use team/position priors. Counting-game points, including zeros, blend continuously with the shooting prior according to exposure.', 'shooting', 'Shooting prior');
  }
  if (games2026 === 0 && games2027 !== undefined && games2027 < 8) {
    push('Thin sample: no games in 2026 and fewer than 8 in 2027.', 'sample', 'Thin sample');
  }
  const weight = readWeight(row);
  const status = readString(row, 'injury_status');
  const questionable = readBoolean(row, 'questionable_widen');
  if (weight === 0 && status !== undefined) {
    push(
      `Out of the rotation (${status}). This player's line is fixed at zero because the card gives them no minutes.`,
      'out',
      'Out of rotation',
    );
  }
  if (questionable === true) {
    push('Uncertain availability reduces participation and widens minutes conditional on playing. These status probabilities are uncalibrated scenario priors.', 'availability', 'Uncertain availability');
  }
  if (weight === 1 && questionable === false) push('No absence flag on the card.', 'availability', 'No absence flag');
  const participation=readNumber(row,'play_probability');
  if(participation!==undefined)push(`Input P(play): ${(participation*100).toFixed(1)}%. Joint draws are conditioned on a feasible rotation; the simulated play share can differ.`, 'availability', 'Chance of playing');
  const role=readString(row,'minutes_source');
  if(role)push(role, 'role', 'Minutes fit');
  if (status === undefined) push('Injury status is not in the data.', 'availability', 'Injury status');
  push(
    'The table shows this player\'s average across all 10,000 games. A 40-point game can still happen in the tail. It is not the line from one draw.',
    'read',
    'Across 10,000 games',
  );
  return notes;
}

function whyMarkup(notes: WhyNote[]): string {
  const legend = notes.some((note) => note.kind === 'evidence')
    ? '<p class="why-legend">Each evidence line is one stat family. The state says whether this player\'s games or the prior is in charge. Exposure is the weighted game count, the prior percentage is how hard the baseline still pulls, and the timestamp is the last game counted.</p>'
    : '';
  const items = notes
    .map((note) => `<p class="why-item why-${note.kind}"><span class="why-kicker">${escapeHtml(note.kicker)}</span>${escapeHtml(note.text)}</p>`)
    .join('');
  return `<div class="why">${legend}${items}</div>`;
}

function rateItem(label: string, value: string): string {
  return `<li class="rate-row">${escapeHtml(`${label}: ${value}`)}</li>`;
}

function samplingList(row: CardRow | null, score: Simulation, shock: number | undefined): string {
  const periods = periodCount(score);
  const teamMinutes = score.overtime ? 240 + 25 * periods : 240;
  const playerMinutes = score.overtime ? 48 + 5 * periods : 48;
  const scaled = `scaled to ${teamMinutes} team-minutes (5 × ${playerMinutes})`;
  const minutes = readNumber(row, 'minutes_mean');
  const minutesLabel = minutes === undefined ? 'not in the data' : minutes.toFixed(1);
  const items = [
    `<li class="rate-row">${escapeHtml(`Shrunk minutes rate: ${minutesLabel}. Active rates are ${scaled}, and this line is one share of that budget.`)}</li>`,
  ];
  for (const line of RATE_LINES) {
    const value = readNumber(row, line.key);
    items.push(rateItem(line.label, value === undefined ? 'not in the data' : value.toFixed(3)));
  }
  if (typeof shock === 'number' && Number.isFinite(shock)) {
    items.push(
      `<li class="rate-row">${escapeHtml(`Team volume shock this draw: ${shock.toFixed(2)}. Legacy volume multiplier; possession-model cards instead use shared pace and opponent-adjusted efficiency.`)}</li>`,
    );
  } else {
    items.push('<li class="rate-row">Team volume shock is not in the data.</li>');
  }
  if (score.overtime) {
    items.push(`<li class="rate-row">${escapeHtml(`This draw used ${teamMinutes} team-minutes (5 × ${playerMinutes}).`)}</li>`);
  }
  return `<ul class="rates">${items.join('')}</ul>`;
}

function statCell(label: string, value: string, tone: '' | 'hero' | 'lead', name: string): string {
  const cls = tone ? `stat-tile stat-${tone}` : 'stat-tile';
  return `<div class="${cls}"><dt>${label}</dt><dd>${value}</dd><span class="stat-name">${escapeHtml(name)}</span></div>`;
}

function meanText(value: number | undefined): string {
  return value === undefined ? '—' : value.toFixed(1);
}

function expectedLine(line: SimulatedPlayer): string {
  const e=line.expectation!;
  const shown=e.played??e;
  const share=(e.playRate*100).toFixed(1);
  const hero=[
    statCell('PTS', meanText(shown.ptsMean), 'hero', 'Points when playing'),
    statCell('MIN', meanText(shown.minMean), 'lead', 'Minutes'),
    statCell('REB', meanText(shown.rebMean), 'lead', 'Rebounds'),
    statCell('AST', meanText(shown.astMean), 'lead', 'Assists'),
  ].join('');
  const shooting=[
    statCell('FGM', meanText(shown.counts?.fgm??e.counts?.fgm), '', 'Field goals'),
    statCell('FGA', meanText(shown.counts?.fga??e.counts?.fga), '', 'Attempts'),
    statCell('3PM', meanText(shown.counts?.tpm??e.counts?.tpm), '', 'Threes'),
    statCell('FTM', meanText(shown.counts?.ftm??e.counts?.ftm), '', 'Free throws'),
    statCell('FTA', meanText(shown.counts?.fta??e.counts?.fta), '', 'FT attempts'),
  ].join('');
  const stocks=[
    statCell('STL', meanText(shown.counts?.stl??e.counts?.stl), '', 'Steals'),
    statCell('BLK', meanText(shown.counts?.blk??e.counts?.blk), '', 'Blocks'),
  ].join('');
  return `<dl class="line line-hero">${hero}</dl>
    <div class="play-meter"><p class="play-meter-label"><span>Share of draws played</span><span class="play-meter-value">${share}%</span></p><span class="play-track" aria-hidden="true"><span class="play-fill" style="width:${share}%"></span></span></div>
    <p class="stat-group-label">Shooting</p>
    <dl class="line line-compact">${shooting}</dl>
    <p class="stat-group-label">Steals and blocks</p>
    <dl class="line line-pair">${stocks}</dl>
    <p class="line-read">Averages in the draws this player appeared (minutes greater than 0). Plays in ${share}% of draws. The roster table still counts sit-outs so team minutes sum to 240. Prop probabilities below exclude DNPs and pushes.</p>`;
}

function drawnLine(line: SimulatedPlayer): string {
  const held = heldLabel(line);
  const fg = `${line.fgm}–${line.fga}`;
  const threes = `${heldSpan(line.tpm, held)}–${line.tpa}`;
  const ft = `${line.ftm}–${line.fta}`;
  return `<dl class="line line-compact">
    ${statCell('MIN', heldSpan(line.min, held), '', 'Minutes')}
    ${statCell('FG', fg, '', 'Field goals')}
    ${statCell('3P', threes, '', 'Threes')}
    ${statCell('FT', ft, '', 'Free throws')}
    ${statCell('PTS', heldSpan(line.pts, held), 'lead', 'Points')}
    ${statCell('REB', heldSpan(line.reb, held), '', 'Rebounds')}
    ${statCell('AST', heldSpan(line.ast, held), '', 'Assists')}
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
    return `<div class="photo"><span class="mono">${letter}</span></div>`;
  }
  return `<div class="photo"><img referrerpolicy="no-referrer" class="headshot" alt="${escapeHtml(name)}" src="${escapeHtml(url)}" width="64" height="64"><span class="mono" hidden>${letter}</span></div>`;
}

function whoBlock(game: SlateGame, line: SimulatedPlayer, row: CardRow | null): string {
  const team = teamName(game, line.team_id);
  const position = readString(row, 'position');
  const group = readString(row, 'position_group');
  const positionHtml = position
    ? `<span class="chip">${escapeHtml(position)}</span>${group ? `<span class="chip">${escapeHtml(group)}</span>` : ''}`
    : 'Position is not in the data.';
  const url = playerHeadshotUrl({
    athlete_id: line.athlete_id,
    headshot_url: readString(row, 'headshot_url'),
  });
  const note = url ? '' : '<p class="photo-note">Photo is not in the data.</p>';
  return `<div class="who">
    ${photoMarkup(line.name, url)}
    <div class="who-copy">
      <h2 class="who-name">${escapeHtml(line.name)}</h2>
      <p class="who-team">${escapeHtml(team ?? 'not in the data')}</p>
      <p class="who-pos">${positionHtml}</p>
      ${note}
    </div>
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
  pa:'points + assists',pr:'points + rebounds',ra:'rebounds + assists',dd:'double-double (yes = over 0.5)',td:'triple-double (yes = over 0.5)',
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
  if (!sample) return propPrompt('This player\'s simulations are not in the data.');
  if (form.line.trim() === '' || form.odds.trim() === '') {
    return propPrompt('Enter a line and a price: American -110, multiplier 1.91, or percent 52.4. The book is not used in the simulation.', 'Add a line and a price');
  }
  const line = Number(form.line);
  if(!Number.isFinite(line)||line<0||!Number.isInteger(line*2))return propPrompt('Enter a nonnegative whole or half-point line.');
  if((form.market==='stl'||form.market==='blk'||form.market==='tov')&&!sample[form.market])return propPrompt('This stat is missing from the older card.');
  const price = parseBookPrice(form.odds, form.style);
  if (!price) return propPrompt(priceError(form.odds, form.style));
  const opposite = form.opposite.trim() === '' ? null : parseBookPrice(form.opposite, form.style);
  if(form.opposite.trim()!==''&&!opposite)return propPrompt('The opposite-side price is invalid.');
  const quote = quoteProp(sample as PlayerSample, form.market, form.side, line, price, opposite);
  if (!quote || quote.breakEven === null || quote.expectedReturn === null) {
    return propPrompt(priceError(form.odds, form.style));
  }
  const verdict = decideVerdict(quote, propContextFromPlayer(player), form.market);
  if (!verdict) return propPrompt(priceError(form.odds, form.style));
  const edgeAttr = quote.edge !== null && quote.edge > 0 ? ' class="edge-up"' : quote.edge !== null && quote.edge < 0 ? ' class="edge-down"' : '';
  const modelPct = quote.modelProbability === null ? '—' : percent(quote.modelProbability);
  const bookPct = percent(quote.breakEven);
  const stats =
    quote.modelProbability === null || quote.edge === null
      ? ''
      : `<dl class="verdict-stats">
          <div><dt>Model chance</dt><dd>${percent(quote.modelProbability)}</dd></div>
          <div><dt>Book break-even</dt><dd>${bookPct}</dd></div>
          <div><dt>Estimated edge</dt><dd${edgeAttr}>${signedPoints(quote.edge)}</dd></div>
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
  return `<div class="prop-results" data-verdict="${verdict.verdict.toLowerCase()}">
    <p class="prop-caption">${escapeHtml(caption)}</p>
    <p class="verdict-mark ${verdict.verdict.toLowerCase()}">${verdict.verdict}</p>
    ${stats}
    <p class="verdict-why"><span class="why-kicker">Why this call</span>${escapeHtml(verdict.text)}</p>
    <p class="stat-group-label">Model against the book</p>
    <div class="prop-compare" role="img" aria-label="Model ${quote.modelProbability === null ? 'not graded' : percent(quote.modelProbability)} versus book ${percent(quote.breakEven)}">
      <div class="prop-row"><span>Model</span><span class="prop-track"><span class="prop-fill model" style="width:${modelWidth}%"></span></span><span class="prop-pct">${modelPct}</span></div>
      <div class="prop-row"><span>Book</span><span class="prop-track"><span class="prop-fill book" style="width:${bookWidth}%"></span></span><span class="prop-pct">${bookPct}</span></div>
    </div>
    <details class="prop-advanced">
      <summary>Grade, fair price, and sampling noise</summary>
      <p>Expected return per $1 risked ${(quote.expectedReturn * 100).toFixed(1)}%</p>
      <p>Read as ${escapeHtml(price.label)}</p>
      <p>Model fair price ${escapeHtml(fair)}</p>
      <p>${quote.grade.wins} wins, ${quote.grade.losses} losses, ${quote.grade.pushes} pushes, ${quote.grade.voids} did not play, out of ${sample.min.length}.${error}</p>
      ${oppositeNote}
      ${noVig}
    </details>
  </div>`;
}

function propFormMarkup(form: PropFormState): string {
  const markets: { value: PropMarket; label: string }[] = [
    {value:'pa',label:'Points + assists'},{value:'pr',label:'Points + rebounds'},{value:'ra',label:'Rebounds + assists'},
    {value:'dd',label:'Double-double (line 0.5)'},{value:'td',label:'Triple-double (line 0.5)'},
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
    <label class="field"><span class="field-label">Market</span><select data-prop-market>${options}</select></label>
    <fieldset class="side-toggle">
      <legend class="field-label">Bet direction</legend>
      <div class="side-options">
        <label class="side-opt"><input type="radio" name="prop-side" value="over" data-prop-side${form.side === 'over' ? ' checked' : ''}><span>Over</span></label>
        <label class="side-opt"><input type="radio" name="prop-side" value="under" data-prop-side${form.side === 'under' ? ' checked' : ''}><span>Under</span></label>
      </div>
    </fieldset>
    <label class="field"><span class="field-label">Prop line</span><span class="field-hint">Whole or half point.</span><input data-prop-line inputmode="decimal" value="${escapeHtml(form.line)}"></label>
    <label class="field"><span class="field-label">Price format</span><select data-prop-style>${styleOptions}</select></label>
    <label class="field"><span class="field-label">${priceLabel}</span><input data-prop-odds inputmode="decimal" placeholder="${placeholder}" value="${escapeHtml(form.odds)}"></label>
    <label class="field"><span class="field-label">Opposite side, same format, optional</span><input data-prop-opposite inputmode="decimal" placeholder="${placeholder}" value="${escapeHtml(form.opposite)}"></label>
    <p class="prop-note">The same price three ways: -110, 1.91x, or 52.4%. A trailing x or % sets the format for that box.</p>
  </form>`;
}

function propPrompt(message: string, title?: string): string {
  const heading = title ? `<p class="prop-prompt-title">${escapeHtml(title)}</p>` : '';
  return `<div class="prop-prompt">${heading}<p class="prop-note">${escapeHtml(message)}</p></div>`;
}

export function renderPlayerPanel(
  game: SlateGame,
  rate: PanelRate | null,
  score: Simulation,
  athleteId: string,
  tab: PanelTab = 'forecast',
  form: PropFormState = DEFAULT_PROP_FORM,
): string {
  const shown = score;
  const line = findLine(shown, athleteId);
  if (!line) {
    return `<div class="panel-fallback"><button type="button" data-close>Close</button><p>This player is not in the data.</p></div>`;
  }
  const row = rate?.players.find((player) => player.athlete_id === athleteId) ?? null;
  const forecastHidden = tab === 'props' ? ' hidden' : '';
  const propsHidden = tab === 'forecast' ? ' hidden' : '';
  const side = line.team_id === game.away.team_id ? 'away' : line.team_id === game.home.team_id ? 'home' : '';
  const lineLede = line.expectation
    ? 'Means from the draws this player actually played.'
    : 'The single game on the board, not an average across the 10,000.';
  return `<div class="panel-sheet"${side ? ` data-side="${side}"` : ''} style="${paletteStyle(game.away, game.home)}">
    <div class="panel-head">
      <div class="panel-top"><button type="button" data-close>Close</button></div>
      ${whoBlock(game, line, row)}
      <div class="panel-tabs" role="tablist">
        <button type="button" role="tab" id="forecast-tab" aria-controls="forecast-panel" tabindex="${tab==='forecast'?0:-1}" data-panel-tab="forecast" aria-selected="${tab === 'forecast' ? 'true' : 'false'}">Player Forecast</button>
        <button type="button" role="tab" id="props-tab" aria-controls="props-panel" tabindex="${tab==='props'?0:-1}" data-panel-tab="props" aria-selected="${tab === 'props' ? 'true' : 'false'}">Prop Analyzer</button>
      </div>
    </div>
    <div class="panel-scroll">
      <div role="tabpanel" id="forecast-panel" aria-labelledby="forecast-tab" data-panel-view="forecast"${forecastHidden}>
        <section class="panel-section">
          <h3>${line.expectation ? 'Expected line' : 'One simulated draw'}</h3>
          <p class="panel-lede">${lineLede}</p>
          ${line.expectation ? expectedLine(line) : drawnLine(line)}
        </section>
        <section class="panel-section">
          <h3>Why</h3>
          <p class="panel-lede">Games in the sample, how hard the prior still pulls, and the chance of playing.</p>
          ${whyMarkup(whyNotes(row))}
        </section>
        <section class="panel-section">
          <h3>Shrunk rates on the card</h3>
          <p class="panel-lede">Per-minute rates after the prior is blended in. The simulator then gives this player a share of the team minute budget.</p>
          ${samplingList(row, shown, shockFor(shown, line.team_id))}
        </section>
      </div>
      <div role="tabpanel" id="props-panel" aria-labelledby="props-tab" data-panel-view="props"${propsHidden}>
        <section class="panel-section">
          <h3>Price a prop</h3>
          <p class="panel-lede">The sportsbook is compared after the 10,000 games. It does not change them.</p>
          ${propFormMarkup(form)}
          <div data-prop-results aria-live="polite">${renderPropResults(score, athleteId, form, row)}</div>
        </section>
      </div>
    </div>
  </div>`;
}
