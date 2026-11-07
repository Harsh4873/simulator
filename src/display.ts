export interface WinCounts {
  away: number;
  tie: number;
  home: number;
}

export type TypicalityBucket = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export function empiricalPercent(sortedAsc: readonly number[], value: number): number {
  let lo = 0;
  let hi = sortedAsc.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedAsc[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return sortedAsc.length === 0 ? 50 : (100 * lo) / sortedAsc.length;
}

export function shownPercent(sortedAsc: readonly number[], value: number): number {
  return Math.round(empiricalPercent(sortedAsc, value));
}

export function typicalityBucket(percent: number, constant: boolean): TypicalityBucket {
  if (constant) return 0;
  const distance = Math.abs(percent - 50);
  if (distance < 8) return 0;
  if (distance < 16) return 1;
  if (distance < 24) return 2;
  if (distance < 32) return 3;
  if (distance < 40) return 4;
  if (distance < 46) return 5;
  return 6;
}

export function winCounts(awayPoints: ArrayLike<number>, homePoints: ArrayLike<number>): WinCounts {
  if (awayPoints.length !== homePoints.length) throw new Error('team point arrays differ in length');
  let away = 0;
  let tie = 0;
  let home = 0;
  for (let i = 0; i < awayPoints.length; i += 1) {
    if (awayPoints[i] > homePoints[i]) away += 1;
    else if (homePoints[i] > awayPoints[i]) home += 1;
    else tie += 1;
  }
  return { away, tie, home };
}

export function nextPanelAthlete(current: string | null, clicked: string | null): string | null {
  if (clicked === null) return null;
  if (current === clicked) return null;
  return clicked;
}

const ESPN_CDN = 'https://a.espncdn.com/';

export function themeFromStorage(stored: string | null, prefersLight: boolean): 'light' | 'dark' {
  if (stored === 'light' || stored === 'dark') return stored;
  return prefersLight ? 'light' : 'dark';
}

function espnCdnUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.startsWith(ESPN_CDN) ? trimmed : null;
}

export function teamLogoUrl(side: { abbreviation?: string | null; logo_url?: string | null }): string | null {
  const stored = espnCdnUrl(side.logo_url);
  if (stored) return stored;
  const abbreviation = (side.abbreviation ?? '').trim();
  if (!/^[A-Za-z]{2,3}$/.test(abbreviation)) return null;
  return `${ESPN_CDN}i/teamlogos/nba/500/scoreboard/${abbreviation.toLowerCase()}.png`;
}

export function playerHeadshotUrl(player: { athlete_id?: string | null; headshot_url?: string | null }): string | null {
  const stored = espnCdnUrl(player.headshot_url);
  if (stored) return stored;
  const athleteId = (player.athlete_id ?? '').trim();
  if (!/^\d+$/.test(athleteId)) return null;
  return `${ESPN_CDN}i/headshots/nba/players/full/${athleteId}.png`;
}

type Rgb = [number, number, number];
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const FALLBACK_AWAY = '#4da6ff';
const FALLBACK_HOME = '#00e5a0';

function rgbOf(hex: string): Rgb {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}

function hexOf(color: Rgb): string {
  return `#${color.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function mix(color: Rgb, target: Rgb, t: number): Rgb {
  return color.map((v, i) => v + (target[i] - v) * t) as Rgb;
}

/** Team colors are decorative. Lift near-black and deepen near-white so a bar or stripe stays visible in both themes. */
export function displayColor(hex: string): string {
  let color = rgbOf(hex);
  for (let i = 0; i < 10 && luminance(color) < 0.07; i += 1) color = mix(color, [255, 255, 255], 0.18);
  for (let i = 0; i < 10 && luminance(color) > 0.5; i += 1) color = mix(color, [0, 0, 0], 0.18);
  return hexOf(color);
}

function distance(a: string, b: string): number {
  const x = rgbOf(a);
  const y = rgbOf(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

function teamColor(side: { color?: string; alternate_color?: string }): string | null {
  const primary = side.color && HEX_COLOR.test(side.color) ? side.color : null;
  const alternate = side.alternate_color && HEX_COLOR.test(side.alternate_color) ? side.alternate_color : null;
  if (!primary) return alternate ? displayColor(alternate) : null;
  const l = luminance(rgbOf(primary));
  // A black or near-white primary reads poorly as an accent; a mid-tone alternate reads better.
  if (alternate && (l < 0.02 || l > 0.6)) {
    const a = luminance(rgbOf(alternate));
    if (a >= 0.02 && a <= 0.6) return displayColor(alternate);
  }
  return displayColor(primary);
}

/** Accent colors for one matchup, kept apart when both teams wear similar colors. */
export function teamPalette(
  away: { color?: string; alternate_color?: string },
  home: { color?: string; alternate_color?: string },
): { away: string; home: string } {
  const a = teamColor(away) ?? FALLBACK_AWAY;
  let h = teamColor(home) ?? FALLBACK_HOME;
  if (distance(a, h) < 90) {
    const alternate = home.alternate_color && HEX_COLOR.test(home.alternate_color) ? displayColor(home.alternate_color) : null;
    h = alternate && distance(a, alternate) >= 90 ? alternate : distance(a, FALLBACK_HOME) >= 90 ? FALLBACK_HOME : FALLBACK_AWAY;
  }
  return { away: a, home: h };
}

export function paletteStyle(away: { color?: string; alternate_color?: string }, home: { color?: string; alternate_color?: string }): string {
  const palette = teamPalette(away, home);
  return `--away: ${palette.away}; --home: ${palette.home};`;
}
