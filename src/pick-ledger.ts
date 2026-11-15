import { bookKey, type BookLine } from './book-lines.ts';
import { overShare, playedSummary, type LedgerFile, type LedgerRow } from './picks.ts';
import type { CompletedEvent, ParsedPlayerGame } from './parse-summary.ts';
import type { PlayerSample, PropMarket } from './props.ts';
import type { RateGame, SlateGame } from './types.ts';

/**
 * The ledger is the record the page cannot keep by itself: each posted line is logged once, with the model's chance
 * at that line, before the game tips. Later runs add the last posted price before the tip and the box-score result.
 * A row's opening line, price and model chance are never rewritten.
 */
const round = (value: number, places: number) => Number(value.toFixed(places));

export function ledgerKey(row: Pick<LedgerRow, 'e' | 'a' | 'm'>): string {
  return `${row.e}:${row.a}:${row.m}`;
}

export function emptyLedger(date: string, source: LedgerFile['source'] = 'live'): LedgerFile {
  return { schema_version: 1, date, source, rows: [] };
}

/** Rows for every posted line in a game that has not tipped, as of the card that was simulated. */
export function openRows(
  game: SlateGame,
  rate: RateGame,
  draws: ReadonlyMap<string, PlayerSample>,
  lines: ReadonlyMap<string, BookLine>,
  cardAt: string,
): LedgerRow[] {
  const tip = Date.parse(game.start_time);
  if (!Number.isFinite(tip) || !(Date.parse(cardAt) < tip)) return [];
  const players = new Map(rate.players.map((player) => [player.athlete_id, player]));
  const rows: LedgerRow[] = [];
  for (const line of lines.values()) {
    if (line.event_id !== game.event_id || !(Date.parse(line.priced_at) < tip)) continue;
    const player = players.get(line.athlete_id);
    const sample = draws.get(line.athlete_id);
    if (!player || !sample || player.replacement_level || player.minutes_weight === 0) continue;
    const share = overShare(sample, line.market, line.line);
    const summary = playedSummary(sample, line.market);
    if (!share || !summary) continue;
    rows.push({
      e: game.event_id,
      a: player.athlete_id,
      m: line.market,
      name: player.name,
      team: player.team_id,
      tip: game.start_time,
      book: line.book,
      open: {
        at: cardAt,
        priced_at: line.priced_at,
        line: line.line,
        over: line.over_odds,
        under: line.under_odds,
        p: round(share.over, 4),
        play: round(summary.play, 3),
        min: round(summary.minutes, 1),
      },
    });
  }
  return rows;
}

/** Adds rows whose player and stat are not in the file yet. An existing row keeps the line it opened with. */
export function mergeOpen(file: LedgerFile, rows: readonly LedgerRow[]): number {
  const known = new Set(file.rows.map(ledgerKey));
  let added = 0;
  for (const row of rows) {
    const key = ledgerKey(row);
    if (known.has(key)) continue;
    known.add(key);
    file.rows.push(row);
    added += 1;
  }
  return added;
}

/**
 * A later comparison for a line already logged (a later card, or the same card against a newer price) becomes its `last`
 * snapshot while the game has not started. The opening snapshot is untouched. Rows that are settled, or whose new
 * comparison is not later, are left alone.
 */
export function refreshLast(file: LedgerFile, rows: readonly LedgerRow[]): number {
  const known = new Map(file.rows.map((row) => [ledgerKey(row), row]));
  let changed = 0;
  for (const fresh of rows) {
    const row = known.get(ledgerKey(fresh));
    if (!row || row.result) continue;
    const at = Date.parse(fresh.open.at);
    const current = row.last ?? row.open;
    // Later means a later card, or the same card against a later price.
    const later = at > Date.parse(current.at) || (at === Date.parse(current.at) && Date.parse(fresh.open.priced_at) > Date.parse(current.priced_at));
    if (!later || !(at < Date.parse(row.tip))) continue;
    row.last = fresh.open;
    changed += 1;
  }
  return changed;
}

/**
 * The last price the feed posted before the tip, when it is later than the opening price. The feed stops refreshing
 * a game once it starts, so this is the last pre-game price it saw, not a confirmed closing line.
 */
export function updateClose(file: LedgerFile, feed: readonly BookLine[]): number {
  const latest = new Map<string, BookLine>();
  for (const line of feed) {
    const key = bookKey(line);
    const previous = latest.get(key);
    if (!previous || Date.parse(line.priced_at) > Date.parse(previous.priced_at)) latest.set(key, line);
  }
  let changed = 0;
  for (const row of file.rows) {
    if (row.result) continue;
    const line = latest.get(`${row.e}:${row.a}:${row.m}`);
    if (!line) continue;
    const at = Date.parse(line.priced_at);
    if (!(at < Date.parse(row.tip)) || !(at > Date.parse(row.close?.priced_at ?? row.open.priced_at))) continue;
    row.close = { priced_at: line.priced_at, line: line.line, over: line.over_odds, under: line.under_odds };
    changed += 1;
  }
  return changed;
}

export function boxValue(box: ParsedPlayerGame, market: PropMarket): number | null {
  const stat = (value: number | undefined) => (value === undefined || !Number.isFinite(value) ? null : value);
  if (market === 'pts') return box.pts;
  if (market === 'reb') return box.reb;
  if (market === 'ast') return box.ast;
  if (market === 'tpm') return box.tpm;
  if (market === 'pra') return box.pts + box.reb + box.ast;
  if (market === 'pa') return box.pts + box.ast;
  if (market === 'pr') return box.pts + box.reb;
  if (market === 'ra') return box.reb + box.ast;
  if (market === 'stl') return stat(box.stl);
  if (market === 'blk') return stat(box.blk);
  if (market === 'tov') return stat(box.tov);
  return null;
}

/** Grades rows whose game has a validated final box score. A player who did not play voids the line. */
export function settle(file: LedgerFile, events: ReadonlyMap<string, CompletedEvent>): number {
  let settled = 0;
  for (const row of file.rows) {
    if (row.result) continue;
    const event = events.get(row.e);
    if (!event) continue;
    const box = event.players.find((player) => player.athlete_id === row.a);
    if (!box || !(box.minutes > 0)) {
      row.result = { void: 'dnp' };
      settled += 1;
      continue;
    }
    const actual = boxValue(box, row.m);
    if (actual === null) continue;
    row.result = { actual, min: round(box.minutes, 1) };
    settled += 1;
  }
  return settled;
}

/** One row a line, in a fixed order, so a later run changes only the rows it touched. */
export function serializeLedger(file: LedgerFile): string {
  const rows = [...file.rows].sort((a, b) => a.e.localeCompare(b.e) || a.a.localeCompare(b.a) || a.m.localeCompare(b.m));
  const head = JSON.stringify({ schema_version: 1, date: file.date, source: file.source });
  return `${head.slice(0, -1)},"rows":[\n${rows.map((row) => JSON.stringify(row)).join(',\n')}\n]}\n`;
}

const MARKETS = new Set<string>(['pts', 'reb', 'ast', 'pra', 'tpm', 'stl', 'blk', 'pa', 'pr', 'ra']);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const stamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function parseLedger(text: string): LedgerFile {
  const file = JSON.parse(text) as LedgerFile;
  if (file?.schema_version !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(String(file.date)) || (file.source !== 'live' && file.source !== 'replay') || !Array.isArray(file.rows)) throw new Error('Invalid pick ledger');
  const seen = new Set<string>();
  for (const row of file.rows) {
    const open = row?.open;
    if (!row || typeof row.e !== 'string' || typeof row.a !== 'string' || !MARKETS.has(row.m) || !stamp(row.tip) || !open) throw new Error('Invalid pick ledger row');
    for (const snap of row.last ? [open, row.last] : [open]) {
      if (!stamp(snap.at) || !stamp(snap.priced_at) || !finite(snap.line) || !finite(snap.over) || !finite(snap.under) || !finite(snap.p) || snap.p < 0 || snap.p > 1) throw new Error('Invalid pick ledger opening');
      // A row is evidence only if the model's number was fixed before the game started.
      if (!(Date.parse(snap.at) < Date.parse(row.tip)) || !(Date.parse(snap.priced_at) < Date.parse(row.tip))) throw new Error('Pick ledger row opened after the tip');
    }
    if (row.close && (!stamp(row.close.priced_at) || !(Date.parse(row.close.priced_at) < Date.parse(row.tip)) || !finite(row.close.line))) throw new Error('Invalid pick ledger close');
    const key = ledgerKey(row);
    if (seen.has(key)) throw new Error('Duplicate pick ledger row');
    seen.add(key);
  }
  return file;
}
