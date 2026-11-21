import { histogramSvg } from '../charts.ts';
import { formatTip } from '../date.ts';
import { nflHeadshotUrl, paletteStyle } from '../display.ts';
import type { FeedGame, FeedPlayerSim, FeedSide, FeedStat } from '../feed.ts';
import { avatarMarkup, escapeHtml, viewToggles } from '../slate.ts';
import { biasFor, nflSeed, readCalibration, simulateGame, type NflCalibration, type NflStat, type SimulatedGame, type TeamPlan } from './projection.ts';

/**
 * The NFL box score the Simulate button opens. It plays the game's published plan 10,000 times on the page with the
 * seed the build used, so the numbers match the card, and lays the result out the way the NBA box score does.
 */

export const NFL_BOX_DRAWS = 10_000;

export interface NflBoxResult {
  result: SimulatedGame;
  calibration: NflCalibration;
}

/** Plays a game from its published plan, or null when the file carries no plan. */
export function playNflGame(game: FeedGame): NflBoxResult | null {
  const plan = game.sim?.plan;
  if (!plan) return null;
  const calibration = readCalibration(plan.calibration);
  return { result: simulateGame(plan.home, plan.away, plan.neutral, NFL_BOX_DRAWS, nflSeed(game.id), calibration), calibration };
}

function quantile(sorted: Float64Array, q: number): number {
  if (!sorted.length) return 0;
  const position = (sorted.length - 1) * q;
  const lo = Math.floor(position);
  const hi = Math.ceil(position);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (position - lo);
}

function sortedOf(values: ArrayLike<number>): Float64Array {
  return Float64Array.from(values).sort();
}

function logoMarkup(side: FeedSide): string {
  const url = side.logo_url;
  const mono = `<span class="mono"${url ? ' hidden' : ''}>${escapeHtml(side.abbreviation)}</span>`;
  const image = url ? `<img referrerpolicy="no-referrer" alt="${escapeHtml(side.name)}" src="${escapeHtml(url)}" width="56" height="56">` : '';
  return `<span class="logo">${image}${mono}</span>`;
}

const percent = (share: number) => (share * 100).toFixed(share > 0 && share < 0.01 ? 1 : 0);
const signed = (value: number) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(1)}`;

/** Outright wins on each side once the calibrated win chance is applied; ties stay as drawn. */
export function sideShares(result: SimulatedGame, draws: number): { away: number; tie: number; home: number } {
  const tie = result.raw.wins.tie / draws;
  const home = Math.max(0, Math.min(1 - tie, result.projection.home_win - tie / 2));
  return { away: Math.max(0, 1 - tie - home), tie, home };
}

function scoreboard(game: FeedGame, result: SimulatedGame, draws: number): string {
  const shares = sideShares(result, draws);
  const away = sortedOf(result.raw.awayPoints);
  const home = sortedOf(result.raw.homePoints);
  const margins = result.raw.margins;
  const share = (test: (value: number) => boolean) => {
    let count = 0;
    for (const value of margins) if (test(value)) count += 1;
    return count / Math.max(1, margins.length);
  };
  const projection = result.projection;
  const label = `Away wins ${percent(shares.away)}%. Tie ${percent(shares.tie)}%. Home wins ${percent(shares.home)}%.`;
  return `<div class="scoreboard">
    <div class="team-head away">${logoMarkup(game.away)}<div class="head-id"><span class="side-role">Away</span><p class="abbr away">${escapeHtml(game.away.abbreviation)}</p></div></div>
    <div class="bar-slot">
      <div class="winbar" role="img" aria-label="${label}">
        <span class="seg seg-away" style="flex-grow: ${shares.away}"></span>
        <span class="seg seg-tie" style="flex-grow: ${shares.tie}"></span>
        <span class="seg seg-home" style="flex-grow: ${shares.home}"></span>
      </div>
    </div>
    <div class="team-head home">${logoMarkup(game.home)}<div class="head-id"><span class="side-role">Home</span><p class="abbr home">${escapeHtml(game.home.abbreviation)}</p></div></div>
    <p class="club-name away">${escapeHtml(game.away.name)}</p>
    <p class="club-name home">${escapeHtml(game.home.name)}</p>
    <p class="score away">${Math.round(projection.away_points.mean)}</p>
    <p class="score home">${Math.round(projection.home_points.mean)}</p>
    <p class="interval away">${Math.round(quantile(away, 0.05))}–${Math.round(quantile(away, 0.95))}</p>
    <p class="interval home">${Math.round(quantile(home, 0.05))}–${Math.round(quantile(home, 0.95))}</p>
    <p class="interval-caption">5th to 95th percentile</p>
    <p class="percentile-caption">Expected points from ${draws.toLocaleString('en-US')} games</p>
    <p class="margin-caption">Mean margin ${signed(projection.margin.mean)} home. Median margin ${signed(projection.margin.p50)}. Home by 7+ ${percent(share((value) => value >= 7))}%. Home by 14+ ${percent(share((value) => value >= 14))}%. Away by 7+ ${percent(share((value) => value <= -7))}%. Away by 14+ ${percent(share((value) => value <= -14))}%.</p>
    <p class="win-pct win-away">${percent(shares.away)}%</p>
    <p class="tie-line">Tie ${percent(shares.tie)}%</p>
    <p class="win-pct win-home">${percent(shares.home)}%</p>
    <p class="win-caption">Win chance, calibrated on earlier weeks</p>
  </div>`;
}

export interface BoxLine {
  /** Average over every draw, games he sits included, so a team's rows add up the way a box score does. */
  mean: number;
  /** His 10th and 90th percentile in the games he plays. */
  p10: number;
  p90: number;
}

/** One player's line for one stat, with the card's calibration: the mean-bias scale, then the range scale. */
export function boxLine(result: SimulatedGame, calibration: NflCalibration, player: TeamPlan['players'][number], stat: NflStat | 'rush_td' | 'rec_td' | 'pass_att'): BoxLine {
  const row = result.raw.tally.get(player.id);
  if (!row) return { mean: 0, p10: 0, p90: 0 };
  const values = row[stat]!;
  const active = row.active!;
  const scale = stat === 'rush_td' || stat === 'rec_td' || stat === 'pass_att' ? 1 : biasFor(calibration, player.position, stat);
  const spread = stat === 'rush_td' || stat === 'rec_td' || stat === 'pass_att' ? 1 : calibration.spread[stat] ?? 1;
  let sum = 0;
  const played: number[] = [];
  for (let draw = 0; draw < values.length; draw += 1) {
    sum += values[draw]! * scale;
    if (active[draw]) played.push(values[draw]! * scale);
  }
  const sorted = sortedOf(played);
  const p50 = quantile(sorted, 0.5);
  const floor = stat === 'rush_yds' ? -10 : 0;
  return {
    mean: values.length ? sum / values.length : 0,
    p10: Math.max(floor, Math.round(p50 - (p50 - quantile(sorted, 0.1)) * spread)),
    p90: Math.round(p50 + (quantile(sorted, 0.9) - p50) * spread),
  };
}

type Column = { key: NflStat | 'rush_td' | 'rec_td' | 'pass_att'; label: string; title: string; yards?: boolean };

const PASSING: Column[] = [
  { key: 'pass_cmp', label: 'CMP', title: 'Completions' },
  { key: 'pass_att', label: 'ATT', title: 'Pass attempts' },
  { key: 'pass_yds', label: 'YDS', title: 'Passing yards', yards: true },
  { key: 'pass_td', label: 'TD', title: 'Passing touchdowns' },
  { key: 'int', label: 'INT', title: 'Interceptions' },
];
const RUSHING: Column[] = [
  { key: 'car', label: 'CAR', title: 'Carries' },
  { key: 'rush_yds', label: 'YDS', title: 'Rushing yards', yards: true },
  { key: 'rush_td', label: 'TD', title: 'Rushing touchdowns' },
];
const RECEIVING: Column[] = [
  { key: 'tgt', label: 'TGT', title: 'Targets' },
  { key: 'rec', label: 'REC', title: 'Receptions' },
  { key: 'rec_yds', label: 'YDS', title: 'Receiving yards', yards: true },
  { key: 'rec_td', label: 'TD', title: 'Receiving touchdowns' },
];

function statusMark(player: TeamPlan['players'][number]): string {
  if (!player.status) return '';
  return ` <span class="chip" title="${escapeHtml(`${player.status}: plays in ${Math.round(player.play * 100)}% of draws`)}">${escapeHtml(player.status.slice(0, 1).toUpperCase())}</span>`;
}

/** Players with a real role in a table: an average of at least `min` of its lead stat. */
function table(title: string, columns: Column[], lead: Column['key'], min: number, plan: TeamPlan, result: SimulatedGame, calibration: NflCalibration, actual: Map<string, FeedPlayerSim>): string {
  const rows = plan.players
    .map((player) => ({ player, lines: columns.map((column) => boxLine(result, calibration, player, column.key)) }))
    .filter((row) => row.lines[columns.findIndex((column) => column.key === lead)]!.mean >= min)
    .sort((a, b) => {
      const yards = columns.findIndex((column) => column.yards);
      return b.lines[yards]!.mean - a.lines[yards]!.mean || a.player.name.localeCompare(b.player.name);
    });
  if (!rows.length) return '';
  const head = columns.map((column) => `<th title="${escapeHtml(column.title)}">${column.label}</th>`).join('');
  const body = rows
    .map(({ player, lines }) => {
      const played = actual.get(player.id)?.actual ?? null;
      const cells = columns
        .map((column, index) => {
          const line = lines[index]!;
          const shown = column.yards ? String(Math.round(line.mean)) : line.mean.toFixed(1);
          const did = played && typeof played[column.key as FeedStat] === 'number' ? `<span class="pct" data-actual>Played ${played[column.key as FeedStat]}</span>` : '';
          return `<td data-col="${column.key}" data-label="${escapeHtml(column.label)}"><span class="stat">${shown}</span><span class="pct">${line.p10}–${line.p90}</span>${did}</td>`;
        })
        .join('');
      return `<tr><th scope="row"><span class="who-cell">${avatarMarkup(player.name, player.id, nflHeadshotUrl(player.id))}<button type="button" class="player-btn" data-nfl-athlete="${escapeHtml(player.id)}">${escapeHtml(player.name)}</button><span class="side-role">${escapeHtml(player.position)}</span>${statusMark(player)}</span></th>${cells}</tr>`;
    })
    .join('');
  const totals = columns
    .map((column, index) => {
      const sum = rows.reduce((total, row) => total + row.lines[index]!.mean, 0);
      return `<td data-col="${column.key}" data-label="${escapeHtml(column.label)}">${column.yards ? Math.round(sum) : sum.toFixed(1)}</td>`;
    })
    .join('');
  return `<h3 class="stat-group-label">${escapeHtml(title)}</h3><div class="table-scroll"><table><thead><tr><th>Player</th>${head}</tr></thead><tbody>${body}<tr data-footer><th scope="row">Expected</th>${totals}</tr></tbody></table></div>`;
}

function teamBox(side: 'away' | 'home', game: FeedGame, plan: TeamPlan, result: SimulatedGame, calibration: NflCalibration, actual: Map<string, FeedPlayerSim>): string {
  const team = side === 'away' ? game.away : game.home;
  return `<section class="team-box" data-side="${side}">
    <h2>${side === 'away' ? 'Away' : 'Home'} · ${escapeHtml(team.name)}</h2>
    ${table('Passing', PASSING, 'pass_att', 0.5, plan, result, calibration, actual)}
    ${table('Rushing', RUSHING, 'car', 0.3, plan, result, calibration, actual)}
    ${table('Receiving', RECEIVING, 'tgt', 0.3, plan, result, calibration, actual)}
  </section>`;
}

function keyTiles(game: FeedGame, box: NflBoxResult, draws: number): string {
  const { result, calibration } = box;
  const projection = result.projection;
  const shares = sideShares(result, draws);
  const favorite = shares.home >= shares.away ? game.home : game.away;
  const leader = projection.margin.mean >= 0 ? game.home : game.away;
  const tile = (label: string, value: string, sub: string) => `<div class="tile"><p class="tile-label">${label}</p><p class="tile-value">${value}</p><p class="tile-sub">${sub}</p></div>`;
  const plan = game.sim!.plan!;
  const passers = [...plan.away.players, ...plan.home.players].filter((player) => player.position === 'QB');
  const top = passers
    .map((player) => ({ player, yards: boxLine(result, calibration, player, 'pass_yds').mean }))
    .sort((a, b) => b.yards - a.yards)[0];
  return `<div class="tiles" aria-label="Key numbers">
    ${tile('Win chance', `${escapeHtml(favorite.abbreviation)} ${percent(Math.max(shares.home, shares.away))}%`, `share of ${draws.toLocaleString('en-US')} games, calibrated`)}
    ${tile('Projected margin', `${escapeHtml(leader.abbreviation)} by ${Math.abs(projection.margin.mean).toFixed(1)}`, `median home margin ${signed(projection.margin.p50)}`)}
    ${tile('Projected total', projection.combined.mean.toFixed(1), `80% between ${Math.round(projection.combined.p10)} and ${Math.round(projection.combined.p90)}`)}
    ${top ? tile('Top passer', String(Math.round(top.yards)), `${escapeHtml(top.player.name)} passing yards`) : ''}
  </div>`;
}

function chartsPanel(game: FeedGame, result: SimulatedGame): string {
  const away = escapeHtml(game.away.abbreviation);
  const home = escapeHtml(game.home.abbreviation);
  return `<div class="charts" data-block="nfl-box-charts">
    <figure class="chart"><figcaption><span>Home margin</span><span class="legend-pair"><i class="key away"></i>${away} wins<i class="key home"></i>${home} wins</span></figcaption>${histogramSvg(result.raw.margins, { label: `${home} margin (home minus away)`, binWidth: 3, split: 0, format: (value) => (value > 0 ? `+${value.toFixed(0)}` : value.toFixed(0)) })}</figure>
    <figure class="chart"><figcaption><span>Total points</span><span class="legend-pair">shaded: middle 80%</span></figcaption>${histogramSvg(result.raw.combined, { label: 'Total points', binWidth: 3 })}</figure>
  </div>`;
}

/**
 * The game's totals or home margins with the card's range scale applied around the median, kept whole, so a line is
 * read against the same spread the score and the charts show.
 */
export function nflGameLineValues(box: NflBoxResult, kind: 'total' | 'margin'): number[] {
  const raw = kind === 'total' ? box.result.raw.combined : box.result.raw.margins;
  const spread = box.calibration.spread[kind === 'total' ? 'combined' : 'margin'] ?? 1;
  if (spread === 1) return Array.from(raw);
  const median = quantile(sortedOf(raw), 0.5);
  return Array.from(raw, (value) => Math.round(median + (value - median) * spread));
}

function linesPanel(box: NflBoxResult): string {
  const describe = (kind: 'total' | 'margin') => {
    const values = sortedOf(nflGameLineValues(box, kind));
    let sum = 0;
    for (const value of values) sum += value;
    const mean = values.length ? sum / values.length : 0;
    const name = kind === 'total' ? 'Total' : 'Home margin';
    return `<p>${name}: mean ${mean.toFixed(1)}; median ${quantile(values, 0.5).toFixed(1)}; 10–90% ${quantile(values, 0.1).toFixed(1)} to ${quantile(values, 0.9).toFixed(1)}; 5–95% ${quantile(values, 0.05).toFixed(1)} to ${quantile(values, 0.95).toFixed(1)}.</p><label>${kind} line <input type="number" step="0.5" data-game-line="${kind}"></label><p data-line-result="${kind}" role="status">Enter a line.</p>`;
  };
  return `<section class="dist-panel" data-block="nfl-box-lines" aria-label="Game distributions"><h3>Check a line</h3><p>Includes overtime. Margin = home points minus away points; a positive margin favors home. Enter a margin threshold (the negative of a home spread).</p>${describe('total')}${describe('margin')}</section>`;
}

function statusLine(game: FeedGame): string {
  if (game.status === 'final' && game.away.score !== null && game.home.score !== null) return `Final: ${game.away.abbreviation} ${game.away.score}, ${game.home.abbreviation} ${game.home.score}`;
  if (game.status === 'in_progress') return 'In progress';
  return 'Scheduled';
}

export function renderNflBox(game: FeedGame, box: NflBoxResult, now: Date = new Date()): string {
  const plan = game.sim?.plan;
  if (!plan) return '<p class="state" role="alert">This game has no simulation plan.</p>';
  const { result, calibration } = box;
  const draws = result.projection.draws;
  const actual = new Map((game.sim?.players ?? []).map((player) => [player.id, player]));
  const toggles = [
    { id: 'nfl-box-score', label: 'Score' },
    { id: 'nfl-box-charts', label: 'Charts' },
    { id: 'nfl-box-lines', label: 'Line check' },
    { id: 'nfl-box-players', label: 'Box scores' },
    { id: 'nfl-box-notes', label: 'Notes' },
  ];
  const where = game.neutral_site ? `Neutral site${game.venue ? ` · ${game.venue}` : ''}` : game.venue ?? `At ${game.home.name}`;
  const accent = (side: FeedSide) => ({ color: side.color ?? undefined, alternate_color: side.alternate_color ?? undefined });
  const questionable = [...plan.away.players, ...plan.home.players].filter((player) => player.status && player.play > 0 && player.play < 1);
  return `<div class="box-view" data-nfl-event="${escapeHtml(game.id)}" style="${paletteStyle(accent(game.away), accent(game.home))}">
      <div class="toolbar">
        <button type="button" data-nfl-back>Back to games</button>
        <div class="toolbar-title"><h2>${escapeHtml(game.away.abbreviation)} @ ${escapeHtml(game.home.abbreviation)}</h2><p class="toolbar-sub">${escapeHtml(`Away ${game.away.name}${game.away.record ? ` (${game.away.record})` : ''} · Home ${game.home.name}${game.home.record ? ` (${game.home.record})` : ''} · ${where} · ${formatTip(game.start_time)}`)}</p></div>
      </div>
      ${viewToggles(toggles)}
      <div data-block="nfl-box-score">
      <section class="hero"><p class="where">${escapeHtml(where)}</p>${scoreboard(game, result, draws)}</section>
      <p class="status-row"><span class="tip">${escapeHtml(formatTip(game.start_time))}</span><span class="status">${escapeHtml(statusLine(game))}</span></p>
      ${keyTiles(game, box, draws)}
      </div>
      ${chartsPanel(game, result)}
      ${linesPanel(box)}
      <div data-block="nfl-box-players">
      ${teamBox('away', game, plan.away, result, calibration, actual)}
      ${teamBox('home', game, plan.home, result, calibration, actual)}
      </div>
      <div data-block="nfl-box-notes">
      <p class="note">Each row is that player's average over all ${draws.toLocaleString('en-US')} games, counting the games he sits, so a team's rows add up. The range under it is his 10th to 90th percentile in the games he plays.${questionable.length ? ` Questionable and playing three draws in four: ${escapeHtml(questionable.map((player) => player.name).join(', '))}.` : ''}</p>
      <p class="note">Team points are played out drive by drive from offense and defense ratings; targets, carries, yards and touchdowns are split by each player's recent share. Win chances, ranges and player averages are calibrated on earlier weeks, each projected only from the weeks before it. Each stat is calibrated on its own, so passing and receiving totals can differ by a few yards. No market line is used. Generated ${escapeHtml(formatTip(now.toISOString()))}.</p>
      </div>
    </div>`;
}
