import type { FeedStatus } from '../feed.ts';

export interface TickerSide {
  name: string;
  abbreviation: string;
}

export interface TickerMatch {
  id: string;
  start_time: string;
  status: FeedStatus;
  away: TickerSide;
  home: TickerSide;
  away_score: number | null;
  home_score: number | null;
  tournament: string;
  tournament_title: string;
  format_label: string | null;
}

export interface PopupMap {
  map: string;
  left: number;
  right: number;
}

export interface TournamentPopup {
  start_time: string;
  day: string;
  finished: boolean;
  format_label: string | null;
  left: string;
  right: string;
  maps: PopupMap[];
}

export interface TournamentPage {
  tier: string | null;
  popups: TournamentPopup[];
}

export interface MapResult {
  day: string;
  map: string;
  winner: string;
  loser: string;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(Number(digits)))
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#039;', "'")
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

function clean(value: string): string {
  return decodeHtml(value).replace(/\s+/g, ' ').trim();
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'team';
}

export function isPlaceholderTeam(name: string): boolean {
  return /^tbd$|^to be determined$|^tba$/i.test(name.trim());
}

function seriesTarget(label: string | null): number | null {
  const match = label?.match(/Bo([135])/i);
  if (!match) return null;
  return (Number(match[1]) + 1) / 2;
}

function tickerStatus(startMs: number, nowMs: number, awayScore: number | null, homeScore: number | null, label: string | null): FeedStatus {
  if (startMs > nowMs) return 'scheduled';
  const target = seriesTarget(label);
  if (target !== null && awayScore !== null && homeScore !== null && (awayScore >= target || homeScore >= target)) return 'final';
  return 'in_progress';
}

/** Upcoming and recent matches from the rendered Liquipedia matches ticker. */
export function parseTicker(html: string, now: Date): TickerMatch[] {
  const decoded = decodeHtml(html);
  const cards = decoded.split('<div class="match-ticker-card">').slice(1);
  const matches: TickerMatch[] = [];
  for (const card of cards) {
    const stamp = card.match(/data-timestamp="(\d+)"/);
    const names = [...card.matchAll(/class="team-name">([^<]+)</g)].map((match) => clean(match[1] ?? ''));
    const shorts = [...card.matchAll(/class="team-shortname">([^<]+)</g)].map((match) => clean(match[1] ?? ''));
    const scores = [...card.matchAll(/class="team-name">[^<]+<\/div><\/a><\/span><\/div><div>([^<]*)<\/div>/g)].map((match) => (match[1] ?? '').trim());
    const tournament = card.match(/match-ticker-card-tournament-name"><a [^>]*>([^<]+)<\/a>/);
    const href = card.match(/match-ticker-card-tournament-name"><a href="([^"]+)"/);
    const header = card.match(/data-timestamp="\d+"[\s\S]*?<\/span><\/span><div>([^<]*)<\/div>/);
    if (!stamp || names.length < 2 || !names[0] || !names[1]) continue;
    const startMs = Number(stamp[1]) * 1000;
    if (!Number.isFinite(startMs)) continue;
    const label = header?.[1] ? clean(header[1]) : null;
    const awayScore = scores[0] !== undefined && scores[0] !== '' && Number.isFinite(Number(scores[0])) ? Number(scores[0]) : null;
    const homeScore = scores[1] !== undefined && scores[1] !== '' && Number.isFinite(Number(scores[1])) ? Number(scores[1]) : null;
    const status = tickerStatus(startMs, now.getTime(), awayScore, homeScore, label);
    const showScore = status !== 'scheduled';
    const title = href?.[1]?.split('#')[0]?.replace(/^\/counterstrike\//, '').replace(/_/g, ' ') ?? '';
    const id = `lp-${stamp[1]}-${slug(names[0])}-${slug(names[1])}`;
    matches.push({
      id,
      start_time: new Date(startMs).toISOString(),
      status,
      away: { name: names[0], abbreviation: shorts[0] || names[0].slice(0, 12) },
      home: { name: names[1], abbreviation: shorts[1] || names[1].slice(0, 12) },
      away_score: showScore ? awayScore ?? 0 : null,
      home_score: showScore ? homeScore ?? 0 : null,
      tournament: tournament?.[1] ? clean(tournament[1]) : title,
      tournament_title: title.replace(/ /g, '_'),
      format_label: label,
    });
  }
  return matches;
}

function teamName(chunk: string): string | null {
  const match = chunk.match(/class="team-name">([^<]+)</);
  return match?.[1] ? clean(match[1]) : null;
}

/** Series popups and the Liquipedia tier from one tournament page. */
export function parseTournamentPage(html: string): TournamentPage {
  const decoded = decodeHtml(html);
  const tierMatch = decoded.match(/Liquipedia Tier:<\/div><div>(?:<a [^>]*>)?([^<]+)/);
  const tier = tierMatch?.[1] ? clean(tierMatch[1]) : null;
  const chunks = decoded.split('brkts-match-info-popup').slice(1);
  const popups: TournamentPopup[] = [];
  for (const chunk of chunks) {
    const stamp = chunk.match(/data-timestamp="(\d+)"/);
    if (!stamp) continue;
    const startMs = Number(stamp[1]) * 1000;
    if (!Number.isFinite(startMs)) continue;
    const headerEnd = chunk.indexOf('brkts-popup-body');
    const header = headerEnd >= 0 ? chunk.slice(0, headerEnd) : chunk;
    const body = headerEnd >= 0 ? chunk.slice(headerEnd) : '';
    const leftChunk = header.match(/match-info-header-opponent-left[\s\S]*?(?=match-info-header-scoreholder)/)?.[0] ?? '';
    const rightChunk = header.match(/match-info-header-scoreholder[\s\S]*/)?.[0] ?? '';
    const left = teamName(leftChunk);
    const right = teamName(rightChunk);
    if (!left || !right) continue;
    const format = chunk.match(/\(Bo[135]\)/i)?.[0] ?? null;
    const maps: PopupMap[] = [];
    for (const row of body.split('brkts-popup-body-grid-row').slice(1)) {
      const mains = [...row.matchAll(/brkts-popup-body-detailed-scores-main-score">(\d+)</g)].map((match) => Number(match[1]));
      const map = row.match(/<a [^>]*>([^<]+)<\/a>/);
      if (mains.length < 2 || !map?.[1] || !Number.isFinite(mains[0]) || !Number.isFinite(mains[1])) continue;
      maps.push({ map: clean(map[1]), left: mains[0]!, right: mains[1]! });
    }
    popups.push({
      start_time: new Date(startMs).toISOString(),
      day: new Date(startMs).toISOString().slice(0, 10),
      finished: /data-finished="finished"/.test(chunk),
      format_label: format ? clean(format).replace(/[()]/g, '') : null,
      left,
      right,
      maps,
    });
  }
  return { tier, popups };
}

/** Finished maps only. A map counts when a side has reached 13. */
export function mapResultsFrom(page: TournamentPage, now: Date): MapResult[] {
  if (page.tier !== 'S-Tier') return [];
  const results: MapResult[] = [];
  for (const popup of page.popups) {
    if (Date.parse(popup.start_time) > now.getTime()) continue;
    if (isPlaceholderTeam(popup.left) || isPlaceholderTeam(popup.right) || popup.left === popup.right) continue;
    for (const map of popup.maps) {
      if (map.left === map.right || Math.max(map.left, map.right) < 13) continue;
      const leftWon = map.left > map.right;
      results.push({ day: popup.day, map: map.map, winner: leftWon ? popup.left : popup.right, loser: leftWon ? popup.right : popup.left });
    }
  }
  return results;
}

/** 2026 S-tier category titles first, then ticker pages, until `limit`. Qualifiers and user pages are skipped. */
export function selectTournamentTitles(tickerTitles: readonly string[], categoryTitles: readonly string[], limit: number): string[] {
  const chosen: string[] = [];
  const add = (title: string) => {
    const normalized = title.trim().replace(/ /g, '_');
    if (!normalized || chosen.length >= limit || chosen.includes(normalized)) return;
    if (/qualifier|^user:/i.test(normalized)) return;
    chosen.push(normalized);
  };
  for (const title of categoryTitles) {
    if (!/2026|Season_2[1-4]|Season 2[1-4]/.test(title)) continue;
    if (/2027|2028/.test(title)) continue;
    add(title);
  }
  for (const title of tickerTitles) {
    if (!/2026|Major|Premier|Pro_League|StarLadder|PGL|Intel_Extreme_Masters/.test(title)) continue;
    add(title);
  }
  return chosen;
}

export function parentTitle(title: string): string | null {
  const parts = title.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return parts.slice(0, -1).join('/');
}
