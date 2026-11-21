import { histogramSvg, propBarsSvg } from '../charts.ts';
import { nflHeadshotUrl, paletteStyle } from '../display.ts';
import type { FeedGame, FeedSide } from '../feed.ts';
import { formatFairPrice, parseBookPrice } from '../props.ts';
import { escapeHtml, viewToggles } from '../slate.ts';
import type { NflBoxResult } from './box.ts';
import { biasFor, calibrateTd, type NflPosition, type NflStat, type PlanPlayer } from './projection.ts';

/**
 * The NFL player panel, the same sheet the NBA box score opens: who he is, his expected line and its spread in the
 * 10,000 games, and a prop checker that reads a line against those games. Every number comes from the draws the box
 * score just played, with the card's calibration applied the way the box score applies it.
 */

export type NflMarket = 'pass_yds' | 'pass_cmp' | 'pass_att' | 'pass_td' | 'int' | 'rush_yds' | 'car' | 'rec' | 'rec_yds' | 'tgt' | 'td';
export type NflPanelTab = 'forecast' | 'props';

export interface NflPropForm {
  market: NflMarket;
  side: 'over' | 'under';
  line: string;
  odds: string;
}

const MARKETS: Record<NflMarket, { label: string; short: string; bin: number | null }> = {
  pass_yds: { label: 'Passing yards', short: 'Pass YDS', bin: 10 },
  pass_cmp: { label: 'Completions', short: 'CMP', bin: null },
  pass_att: { label: 'Pass attempts', short: 'ATT', bin: null },
  pass_td: { label: 'Passing touchdowns', short: 'Pass TD', bin: null },
  int: { label: 'Interceptions', short: 'INT', bin: null },
  rush_yds: { label: 'Rushing yards', short: 'Rush YDS', bin: 5 },
  car: { label: 'Carries', short: 'CAR', bin: null },
  rec: { label: 'Receptions', short: 'REC', bin: null },
  rec_yds: { label: 'Receiving yards', short: 'Rec YDS', bin: 5 },
  tgt: { label: 'Targets', short: 'TGT', bin: null },
  td: { label: 'Anytime touchdown', short: 'TD', bin: null },
};

const BY_POSITION: Record<NflPosition, NflMarket[]> = {
  QB: ['pass_yds', 'pass_td', 'pass_cmp', 'pass_att', 'int', 'rush_yds', 'td'],
  RB: ['rush_yds', 'car', 'rec', 'rec_yds', 'td'],
  WR: ['rec_yds', 'rec', 'tgt', 'td'],
  TE: ['rec_yds', 'rec', 'tgt', 'td'],
};

export function isNflMarket(value: string): value is NflMarket {
  return Object.prototype.hasOwnProperty.call(MARKETS, value);
}

export function marketsFor(position: NflPosition): NflMarket[] {
  return BY_POSITION[position];
}

export function findNflPlayer(game: FeedGame, id: string): { player: PlanPlayer; side: 'away' | 'home' } | null {
  const plan = game.sim?.plan;
  if (!plan) return null;
  const away = plan.away.players.find((player) => player.id === id);
  if (away) return { player: away, side: 'away' };
  const home = plan.home.players.find((player) => player.id === id);
  return home ? { player: home, side: 'home' } : null;
}

function quantile(sorted: ArrayLike<number>, q: number): number {
  if (!sorted.length) return 0;
  const position = (sorted.length - 1) * q;
  const lo = Math.floor(position);
  const hi = Math.ceil(position);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (position - lo);
}

/**
 * His values in the draws he plays. A stat the card calibrates is scaled by its mean bias and stretched around the
 * median by its range scale, as the box score's row and range are, then kept whole. A touchdown is 1 or 0.
 */
export function nflMarketValues(box: NflBoxResult, player: PlanPlayer, market: NflMarket): number[] {
  const row = box.result.raw.tally.get(player.id);
  if (!row) return [];
  const active = row.active!;
  const out: number[] = [];
  if (market === 'td') {
    for (let draw = 0; draw < active.length; draw += 1) if (active[draw]) out.push(row.rush_td![draw]! + row.rec_td![draw]! > 0 ? 1 : 0);
    return out;
  }
  const values = row[market]!;
  const stat = market === 'pass_att' ? null : (market as NflStat);
  const scale = stat ? biasFor(box.calibration, player.position, stat) : 1;
  const spread = stat ? box.calibration.spread[stat] ?? 1 : 1;
  for (let draw = 0; draw < values.length; draw += 1) if (active[draw]) out.push(values[draw]! * scale);
  if (scale === 1 && spread === 1) return out;
  const median = quantile(Float64Array.from(out).sort(), 0.5);
  const floor = market === 'rush_yds' ? -10 : 0;
  return out.map((value) => Math.max(floor, Math.round(median + (value - median) * spread)));
}

/** The calibrated anytime-touchdown chance, as the card states it. */
export function touchdownChance(box: NflBoxResult, values: readonly number[]): number {
  if (!values.length) return 0;
  let scored = 0;
  for (const value of values) scored += value;
  return calibrateTd(scored / values.length, box.calibration);
}

/** Share of the draws he plays. */
export function playShare(box: NflBoxResult, player: PlanPlayer): number {
  const active = box.result.raw.tally.get(player.id)?.active;
  if (!active?.length) return 0;
  let played = 0;
  for (const value of active) played += value ? 1 : 0;
  return played / active.length;
}

function meanOf(values: readonly number[]): number {
  if (!values.length) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** The nearest half point to his simulated median, so a default line never pushes. */
export function defaultNflLine(values: readonly number[], market: NflMarket): string {
  if (market === 'td') return '0.5';
  if (!values.length) return '';
  const median = quantile(Float64Array.from(values).sort(), 0.5);
  return String(Math.max(0.5, Math.floor(median) + 0.5));
}

export function defaultNflForm(box: NflBoxResult, player: PlanPlayer, market: NflMarket = marketsFor(player.position)[0]!): NflPropForm {
  return { market, side: 'over', line: defaultNflLine(nflMarketValues(box, player, market), market), odds: '' };
}

function percent(share: number): string {
  const tenths = Math.round(share * 1000) / 10;
  return `${Number.isInteger(tenths) ? tenths.toFixed(0) : tenths.toFixed(1)}%`;
}

function shown(market: NflMarket, value: number): string {
  if (MARKETS[market].bin !== null) return String(Math.round(value));
  return value.toFixed(1);
}

export interface NflChances {
  over: number | null;
  under: number | null;
  pushes: number;
  decided: number;
}

/** Over and under among the draws he plays, pushes left out, as the NBA analyzer counts them. */
export function nflChances(box: NflBoxResult, values: readonly number[], market: NflMarket, line: number): NflChances {
  if (market === 'td') {
    const chance = touchdownChance(box, values);
    return { over: chance, under: 1 - chance, pushes: 0, decided: values.length };
  }
  let over = 0;
  let under = 0;
  let pushes = 0;
  for (const value of values) {
    if (value > line) over += 1;
    else if (value < line) under += 1;
    else pushes += 1;
  }
  const decided = over + under;
  return { over: decided ? over / decided : null, under: decided ? under / decided : null, pushes, decided };
}

function validLine(raw: string): number | null {
  if (raw.trim() === '') return null;
  const line = Number(raw);
  if (!Number.isFinite(line) || line < -10 || !Number.isInteger(line * 2)) return null;
  return line;
}

function distributionSvg(values: readonly number[], market: NflMarket, line: number | null, label: string): string {
  if (!values.length) return '';
  const bin = MARKETS[market].bin;
  if (bin === null) return propBarsSvg(values, line, label);
  return lineHistogramSvg(values, line, bin, label);
}

/**
 * A yards histogram whose bin edges sit on the line's half point, so every bar is wholly over or wholly under it.
 * Without a line it is the plain histogram with the middle 80% shaded.
 */
export function lineHistogramSvg(values: readonly number[], line: number | null, width: number, label: string): string {
  if (line === null) return histogramSvg(values, { label, binWidth: width });
  const sorted = Float64Array.from(values).sort();
  if (!sorted.length) return '';
  const anchor = Math.floor(line) + 0.5;
  const low = quantile(sorted, 0.005);
  const high = quantile(sorted, 0.995);
  const lo = anchor + Math.floor((Math.min(low, line) - anchor) / width) * width;
  const hi = anchor + Math.ceil((Math.max(high, line) - anchor + 1e-9) / width) * width;
  const bins = Math.max(1, Math.round((hi - lo) / width));
  const counts = new Array<number>(bins).fill(0);
  for (const value of sorted) {
    const index = Math.floor((value - lo) / width);
    if (index >= 0 && index < bins) counts[index] += 1;
  }
  const peak = Math.max(1, ...counts);
  const W = 320;
  const top = 8;
  const base = 96;
  const x = (value: number) => ((value - lo) / (hi - lo)) * W;
  const bars = counts
    .map((count, index) => {
      const from = lo + index * width;
      const height = (count / peak) * (base - top);
      const side = from + width / 2 > line ? 'over' : 'under';
      return `<rect class="bar ${side}" x="${(x(from) + 0.6).toFixed(1)}" y="${(base - height).toFixed(1)}" width="${Math.max(0.8, (W * width) / (hi - lo) - 1.2).toFixed(1)}" height="${Math.max(count ? 1 : 0, height).toFixed(1)}" rx="1.5"></rect>`;
    })
    .join('');
  const mark = `<line class="prop-line" x1="${x(line).toFixed(1)}" x2="${x(line).toFixed(1)}" y1="${top}" y2="${base}"></line>`;
  return `<svg class="prop-bars" viewBox="0 0 ${W} 132" role="img" aria-label="${escapeHtml(label)}" preserveAspectRatio="xMidYMid meet">
    ${bars}${mark}
    <line class="axis" x1="0" x2="${W}" y1="${base}" y2="${base}"></line>
    <text class="tick" x="2" y="124">${Math.round(lo + 0.5)}</text>
    <text class="tick mid" x="${x(line).toFixed(1)}" y="124" text-anchor="middle">${line}</text>
    <text class="tick" x="${W - 2}" y="124" text-anchor="end">${Math.round(hi - 0.5)}</text>
  </svg>`;
}

function teamLine(game: FeedGame, side: 'away' | 'home'): string {
  const team = side === 'away' ? game.away : game.home;
  const opponent = side === 'away' ? game.home : game.away;
  if (game.neutral_site) return `${side === 'away' ? 'Away' : 'Home'} · ${team.name} vs ${opponent.name} · neutral site`;
  return side === 'away' ? `Away · ${team.name} at ${opponent.name}` : `Home · ${team.name} vs ${opponent.name}`;
}

function photo(name: string, id: string): string {
  const url = nflHeadshotUrl(id);
  const letter = escapeHtml(Array.from(name.trim())[0]?.toUpperCase() ?? '?');
  if (!url) return `<div class="photo"><span class="mono">${letter}</span></div>`;
  return `<div class="photo"><img referrerpolicy="no-referrer" class="headshot" alt="${escapeHtml(name)}" src="${escapeHtml(url)}" width="64" height="64"><span class="mono" hidden>${letter}</span></div>`;
}

function who(game: FeedGame, player: PlanPlayer, side: 'away' | 'home', share: number): string {
  const chips = [
    `<span class="chip">${escapeHtml(player.position)}</span>`,
    player.status ? `<span class="chip chip-warn">${escapeHtml(player.status)}</span>` : '',
    share < 0.995 ? `<span class="chip">Plays in ${escapeHtml(percent(share))} of games</span>` : '',
  ].join('');
  return `<div class="who">
    ${photo(player.name, player.id)}
    <div class="who-copy">
      <h2 class="who-name">${escapeHtml(player.name)}</h2>
      <p class="who-team">${escapeHtml(teamLine(game, side))}</p>
      <p class="who-pos">${chips}</p>
    </div>
  </div>`;
}

function tile(market: NflMarket, box: NflBoxResult, values: readonly number[], tone: '' | 'hero' | 'lead'): string {
  const cls = tone ? `stat-tile stat-${tone}` : 'stat-tile';
  if (market === 'td') {
    return `<div class="${cls}"><dt>TD</dt><dd>${escapeHtml(percent(touchdownChance(box, values)))}</dd><span class="stat-name">Anytime touchdown</span></div>`;
  }
  const sorted = Float64Array.from(values).sort();
  const range = values.length ? `${shown(market, quantile(sorted, 0.1))}–${shown(market, quantile(sorted, 0.9))}` : '';
  return `<div class="${cls}"><dt>${escapeHtml(MARKETS[market].short)}</dt><dd>${values.length ? escapeHtml(shown(market, meanOf(values))) : '—'}</dd><span class="stat-name">${escapeHtml(range ? `${MARKETS[market].label}, 8 in 10: ${range}` : MARKETS[market].label)}</span></div>`;
}

function forecast(box: NflBoxResult, player: PlanPlayer, share: number): string {
  const markets = marketsFor(player.position);
  const values = new Map(markets.map((market) => [market, nflMarketValues(box, player, market)]));
  const tiles = markets.map((market, index) => tile(market, box, values.get(market)!, index === 0 ? 'hero' : index < 3 ? 'lead' : '')).join('');
  const charts = markets
    .filter((market) => market !== 'td')
    .slice(0, 2)
    .map((market) => {
      const list = values.get(market)!;
      if (!list.length) return '';
      return `<figure class="chart projection-chart"><figcaption><span>${escapeHtml(MARKETS[market].label)}</span><span class="legend-pair">${MARKETS[market].bin === null ? 'one bar per count' : 'shaded: middle 80%'}</span></figcaption>${distributionSvg(list, market, null, `${MARKETS[market].label} in the simulated games he plays`)}</figure>`;
    })
    .join('');
  const width = Math.max(0, Math.min(100, share * 100)).toFixed(1);
  return `<section class="panel-section" data-block="nfl-panel-line">
      <h3>Expected line</h3>
      <p class="panel-lede">Averages in the games he plays. The range is his 10th to 90th percentile.</p>
      <dl class="line line-hero">${tiles}</dl>
      <div class="play-meter"><p class="play-meter-label"><span>Share of games played</span><span class="play-meter-value">${escapeHtml(percent(share))}</span></p><span class="play-track" aria-hidden="true"><span class="play-fill" style="width:${width}%"></span></span></div>
    </section>
    ${charts ? `<section class="panel-section" data-block="nfl-panel-charts"><h3>Distribution</h3><p class="panel-lede">How his ${escapeHtml(MARKETS[markets[0]!].label.toLowerCase())} spread across the games he plays.</p><div class="charts">${charts}</div></section>` : ''}
    <section class="panel-section" data-block="nfl-panel-why">
      <h3>Playing time</h3>
      <p class="panel-lede">Recent share of the offense, and his injury status.</p>
      ${whyList(player)}
    </section>`;
}

function whyList(player: PlanPlayer): string {
  const rows: [string, string][] = [];
  if (player.position === 'QB') {
    rows.push(['Interceptions per attempt', player.intRate.toFixed(3)]);
    rows.push(['Pass attempts, latest game', player.lastPassAtt.toFixed(0)]);
  }
  if (player.targetShare > 0) {
    rows.push(['Target share', percent(player.targetShare)]);
    rows.push(['Catch rate', percent(player.catchRate)]);
    rows.push(['Yards per catch', player.ypr.toFixed(1)]);
    rows.push(['Touchdowns per catch', player.tdPerRec.toFixed(3)]);
  }
  if (player.carryShare > 0) {
    rows.push(['Carry share', percent(player.carryShare)]);
    rows.push(['Yards per carry', player.ypc.toFixed(1)]);
    rows.push(['Touchdowns per carry', player.tdPerCarry.toFixed(3)]);
  }
  rows.push(['Injury status', player.status ?? 'none listed']);
  return `<ul class="rates">${rows.map(([label, value]) => `<li class="rate-row">${escapeHtml(`${label}: ${value}`)}</li>`).join('')}</ul>`;
}

function marketPills(markets: readonly NflMarket[], form: NflPropForm): string {
  const buttons = markets
    .map((market) => `<button type="button" class="market-pill" data-nfl-market="${market}" aria-pressed="${form.market === market ? 'true' : 'false'}"><span class="pill-name">${escapeHtml(MARKETS[market].short)}</span></button>`)
    .join('');
  return `<div class="market-pills" role="group" aria-label="Stat">${buttons}</div>`;
}

export function nflPropFormMarkup(form: NflPropForm): string {
  const locked = form.market === 'td';
  return `<form class="prop-form" data-nfl-prop-form>
    <fieldset class="side-toggle">
      <legend class="field-label">Side</legend>
      <div class="side-options">
        <label class="side-opt"><input type="radio" name="nfl-prop-side" value="over" data-nfl-prop-side${form.side === 'over' ? ' checked' : ''}><span>${locked ? 'Scores' : 'Over'}</span></label>
        <label class="side-opt"><input type="radio" name="nfl-prop-side" value="under" data-nfl-prop-side${form.side === 'under' ? ' checked' : ''}><span>${locked ? 'No score' : 'Under'}</span></label>
      </div>
    </fieldset>
    <label class="field"><span class="field-label">Line</span><span class="field-hint">${locked ? 'An anytime touchdown is over 0.5.' : 'Whole or half point.'}</span><input data-nfl-prop-line inputmode="decimal" value="${escapeHtml(form.line)}"${locked ? ' readonly' : ''}></label>
    <div class="line-step-row">
      <button type="button" class="ghost" data-nfl-nudge="-0.5"${locked ? ' disabled' : ''}>−0.5</button>
      <button type="button" class="ghost" data-nfl-nudge="0.5"${locked ? ' disabled' : ''}>+0.5</button>
      <button type="button" class="ghost" data-nfl-nudge="median"${locked ? ' disabled' : ''}>Simulated median</button>
    </div>
    <label class="field"><span class="field-label">Price, optional</span><span class="field-hint">American -110, multiplier 1.91x, or percent 52.4%.</span><input data-nfl-prop-odds inputmode="decimal" placeholder="-110" value="${escapeHtml(form.odds)}"></label>
  </form>`;
}

/** The chances at the line, the games drawn against it, and the price when one is entered. */
export function renderNflPropResults(box: NflBoxResult, player: PlanPlayer, form: NflPropForm): string {
  const values = nflMarketValues(box, player, form.market);
  if (!values.length) return '<div class="prop-prompt"><p class="prop-note">He does not play in the simulated games.</p></div>';
  const line = form.market === 'td' ? 0.5 : validLine(form.line);
  if (line === null) return '<div class="prop-prompt"><p class="prop-prompt-title">Add a line</p><p class="prop-note">Enter a whole or half-point line.</p></div>';
  const chances = nflChances(box, values, form.market, line);
  const label = MARKETS[form.market].label;
  const overName = form.market === 'td' ? 'Scores' : `Over ${line}`;
  const underName = form.market === 'td' ? 'No score' : `Under ${line}`;
  const tiles = `<dl class="line line-pair projection-chances">
      <div class="stat-tile${form.side === 'over' ? ' stat-lead' : ''}"><dt>${escapeHtml(overName)}</dt><dd>${chances.over === null ? '—' : escapeHtml(percent(chances.over))}</dd><span class="stat-name">Model chance</span></div>
      <div class="stat-tile${form.side === 'under' ? ' stat-lead' : ''}"><dt>${escapeHtml(underName)}</dt><dd>${chances.under === null ? '—' : escapeHtml(percent(chances.under))}</dd><span class="stat-name">Model chance</span></div>
    </dl>`;
  const chart =
    form.market === 'td'
      ? ''
      : `<figure class="chart projection-chart"><figcaption><span>${escapeHtml(label)} in 10,000 simulated games</span><span class="legend-pair"><i class="key under"></i>Under<i class="key push"></i>Push<i class="key over"></i>Over</span></figcaption>${distributionSvg(values, form.market, line, `${label} in the simulated games he plays, against ${line}`)}</figure>`;
  const sits = 1 - values.length / Math.max(1, box.result.raw.tally.get(player.id)?.active?.length ?? values.length);
  const note = `<p class="prop-note">${form.market === 'td' ? 'Calibrated on earlier weeks.' : `${chances.pushes.toLocaleString('en-US')} pushes.`}${sits > 0.0005 ? ` He sits in ${escapeHtml(percent(sits))} of games; a game he sits voids the line and stays out of the chance.` : ''}</p>`;
  return `<div class="prop-results" data-nfl-prop-chances>${tiles}${chart}${priceCompare(form, chances)}${note}</div>`;
}

function priceCompare(form: NflPropForm, chances: NflChances): string {
  if (form.odds.trim() === '') return '<p class="prop-note">Add a price to compare it with the model chance. The price is not used in the simulation.</p>';
  const price = parseBookPrice(form.odds, 'american');
  const model = form.side === 'over' ? chances.over : chances.under;
  if (!price) return '<p class="prop-note" role="status">That price is not valid. American odds are -100 or lower, or +100 or higher.</p>';
  if (model === null) return '';
  const edge = model - price.breakEven;
  const fair = formatFairPrice(model, price.style) ?? '—';
  const tone = edge > 0 ? 'edge-up' : edge < 0 ? 'edge-down' : '';
  return `<p class="stat-group-label">Model against the price</p>
    <div class="prop-compare" role="img" aria-label="Model ${escapeHtml(percent(model))} versus break-even ${escapeHtml(percent(price.breakEven))}">
      <div class="prop-row"><span>Model</span><span class="prop-track"><span class="prop-fill model" style="width:${(model * 100).toFixed(1)}%"></span></span><span class="prop-pct">${escapeHtml(percent(model))}</span></div>
      <div class="prop-row"><span>Price</span><span class="prop-track"><span class="prop-fill book" style="width:${(price.breakEven * 100).toFixed(1)}%"></span></span><span class="prop-pct">${escapeHtml(percent(price.breakEven))}</span></div>
    </div>
    <dl class="verdict-stats">
      <div><dt>Model chance</dt><dd>${escapeHtml(percent(model))}</dd></div>
      <div><dt>Break-even</dt><dd>${escapeHtml(percent(price.breakEven))}</dd></div>
      <div><dt>Gap</dt><dd class="${tone}">${edge >= 0 ? '+' : '−'}${Math.abs(edge * 100).toFixed(1)} pp</dd></div>
    </dl>
    <p class="prop-note">Fair price ${escapeHtml(fair)}. NFL props have no graded record here yet, so this is the simulation alone, not a recommendation.</p>`;
}

export function renderNflPlayerPanel(game: FeedGame, box: NflBoxResult, playerId: string, tab: NflPanelTab, form: NflPropForm): string {
  const found = findNflPlayer(game, playerId);
  if (!found) return '<div class="panel-fallback"><button type="button" data-close>Close</button><p>This player is not in the data.</p></div>';
  const { player, side } = found;
  const share = playShare(box, player);
  const accent = (team: FeedSide) => ({ color: team.color ?? undefined, alternate_color: team.alternate_color ?? undefined });
  const markets = marketsFor(player.position);
  const shownForm = markets.includes(form.market) ? form : defaultNflForm(box, player);
  return `<div class="panel-sheet" data-side="${side}" data-nfl-panel="${escapeHtml(player.id)}" style="${paletteStyle(accent(game.away), accent(game.home))}">
    <div class="panel-head">
      <div class="panel-top"><button type="button" data-close>Close</button></div>
      ${who(game, player, side, share)}
      <div class="panel-tabs" role="tablist">
        <button type="button" role="tab" id="forecast-tab" aria-controls="forecast-panel" tabindex="${tab === 'forecast' ? 0 : -1}" data-panel-tab="forecast" aria-selected="${tab === 'forecast' ? 'true' : 'false'}">Player Forecast</button>
        <button type="button" role="tab" id="props-tab" aria-controls="props-panel" tabindex="${tab === 'props' ? 0 : -1}" data-panel-tab="props" aria-selected="${tab === 'props' ? 'true' : 'false'}">Prop Analyzer</button>
      </div>
    </div>
    <div class="panel-scroll">
      <div role="tabpanel" id="forecast-panel" aria-labelledby="forecast-tab" data-panel-view="forecast"${tab === 'props' ? ' hidden' : ''}>
        ${viewToggles([
          { id: 'nfl-panel-line', label: 'Line' },
          { id: 'nfl-panel-charts', label: 'Charts' },
          { id: 'nfl-panel-why', label: 'Playing' },
        ])}
        ${forecast(box, player, share)}
      </div>
      <div role="tabpanel" id="props-panel" aria-labelledby="props-tab" data-panel-view="props"${tab === 'forecast' ? ' hidden' : ''}>
        <section class="panel-section">
          <h3>Check a line</h3>
          <p class="panel-lede">Pick a stat, set a line, and see how often he clears it in the 10,000 games.</p>
          ${marketPills(markets, shownForm)}
          ${nflPropFormMarkup(shownForm)}
          <div data-nfl-prop-results aria-live="polite">${renderNflPropResults(box, player, shownForm)}</div>
        </section>
      </div>
    </div>
  </div>`;
}
