export interface HistogramOptions {
  /** Short name used in the accessible label, for example "Home margin". */
  label: string;
  binWidth: number;
  /** Bars below this value use the away color, above it the home color. Omit for one color. */
  split?: number;
  format?: (value: number) => string;
}

function quantile(sorted: Float64Array, p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
}

/** One SVG histogram of the simulated draws, with the 10th to 90th percentile band and the median marked. */
export function histogramSvg(values: ArrayLike<number>, options: HistogramOptions): string {
  const sorted = Float64Array.from(values).sort();
  if (!sorted.length) return '';
  const format = options.format ?? ((value: number) => value.toFixed(0));
  const width = options.binWidth;
  const lo = Math.floor(quantile(sorted, 0.005) / width) * width;
  const hi = Math.ceil((quantile(sorted, 0.995) + 1e-9) / width) * width;
  const bins = Math.max(1, Math.round((hi - lo) / width));
  const counts = new Array<number>(bins).fill(0);
  for (const value of sorted) {
    const index = Math.floor((value - lo) / width);
    if (index >= 0 && index < bins) counts[index] += 1;
  }
  const peak = Math.max(1, ...counts);
  const W = 320;
  const H = 118;
  const top = 8;
  const base = 96;
  const x = (value: number) => ((value - lo) / (hi - lo)) * W;
  const median = quantile(sorted, 0.5);
  const p10 = quantile(sorted, 0.1);
  const p90 = quantile(sorted, 0.9);
  const bars = counts
    .map((count, i) => {
      const from = lo + i * width;
      const height = (count / peak) * (base - top);
      const center = from + width / 2;
      const side = options.split === undefined ? 'one' : center < options.split ? 'low' : 'high';
      return `<rect class="bar ${side}" x="${(x(from) + 0.6).toFixed(1)}" y="${(base - height).toFixed(1)}" width="${Math.max(0.8, (W * width) / (hi - lo) - 1.2).toFixed(1)}" height="${height.toFixed(1)}" rx="1.5"></rect>`;
    })
    .join('');
  const split =
    options.split !== undefined && options.split > lo && options.split < hi
      ? `<line class="split" x1="${x(options.split).toFixed(1)}" x2="${x(options.split).toFixed(1)}" y1="${top}" y2="${base}"></line>`
      : '';
  const label = `${options.label}: median ${format(median)}; 80% of simulations between ${format(p10)} and ${format(p90)}.`;
  return `<svg class="hist" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}" preserveAspectRatio="none">
    <rect class="mid80" x="${x(p10).toFixed(1)}" y="${top}" width="${Math.max(1, x(p90) - x(p10)).toFixed(1)}" height="${base - top}"></rect>
    ${bars}${split}
    <line class="median" x1="${x(median).toFixed(1)}" x2="${x(median).toFixed(1)}" y1="${top - 4}" y2="${base}"></line>
    <line class="axis" x1="0" x2="${W}" y1="${base}" y2="${base}"></line>
    <text class="tick" x="2" y="${H - 6}">${format(lo)}</text>
    <text class="tick mid" x="${x(median).toFixed(1)}" y="${H - 6}" text-anchor="middle">${format(median)}</text>
    <text class="tick" x="${W - 2}" y="${H - 6}" text-anchor="end">${format(hi)}</text>
  </svg>`;
}

function chartText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * One bar per integer among played draws.
 * A half-point line is compared to the integer itself, the same way gradeProp compares a stat:
 * under the line, over the line, or push. Bin centers are not used.
 */
export function propBarsSvg(playedValues: ArrayLike<number>, line: number | null, label: string): string {
  const counts = new Map<number, number>();
  for (let index = 0; index < playedValues.length; index += 1) {
    const value = playedValues[index];
    if (!Number.isFinite(value)) continue;
    const stat = Math.round(value);
    counts.set(stat, (counts.get(stat) ?? 0) + 1);
  }
  const stats = [...counts.keys()].sort((a, b) => a - b);
  if (!stats.length) return '';
  const lo = stats[0];
  const hi = stats[stats.length - 1];
  const W = 320;
  const H = 118;
  const top = 8;
  const base = 96;
  const pad = 8;
  const peak = Math.max(1, ...counts.values());
  const span = Math.max(1, hi - lo);
  const barW = Math.max(1, Math.min(22, ((W - pad * 2) / (span + 1)) * 0.72));
  const graded = line !== null && Number.isFinite(line);
  const xAt = (value: number) => pad + ((value - lo) / span) * (W - pad * 2);
  const bars = stats
    .map((stat) => {
      const count = counts.get(stat) ?? 0;
      const height = (count / peak) * (base - top);
      const side = !graded ? 'plain' : stat === line ? 'push' : stat > (line as number) ? 'over' : 'under';
      const left = xAt(stat) - barW / 2;
      return `<rect class="bar ${side}" x="${left.toFixed(1)}" y="${(base - height).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, height).toFixed(1)}" rx="1.5"></rect>`;
    })
    .join('');
  const mark =
    graded && (line as number) >= lo && (line as number) <= hi
      ? `<line class="prop-line" x1="${xAt(line as number).toFixed(1)}" x2="${xAt(line as number).toFixed(1)}" y1="${top}" y2="${base}"></line>`
      : '';
  const caption = chartText(label);
  return `<svg class="prop-bars" viewBox="0 0 ${W} ${H}" role="img" aria-label="${caption}" preserveAspectRatio="none">
    ${bars}${mark}
    <line class="axis" x1="0" x2="${W}" y1="${base}" y2="${base}"></line>
    <text class="tick" x="2" y="${H - 6}">${lo}</text>
    <text class="tick" x="${W - 2}" y="${H - 6}" text-anchor="end">${hi}</text>
  </svg>`;
}

export interface HistoryBarPoint {
  oppLabel: string;
  shortDate: string;
  value: number;
  ariaLabel: string;
}

/**
 * Last-N game bar chart against the viewer's line.
 * Bars above the line are marked over, below under, equal push.
 */
export function historyBarsSvg(
  points: readonly HistoryBarPoint[],
  line: number | null,
  selectedIndex: number | null,
  label: string,
): string {
  if (!points.length) return '';
  const W = 760;
  const H = 228;
  const left = 32;
  const right = 748;
  const top = 24;
  const base = 184;
  const plotW = right - left;
  const plotH = base - top;
  const graded = line !== null && Number.isFinite(line);
  const rawMax = Math.max(1, ...points.map((p) => p.value), graded ? (line as number) * 1.12 : 1);
  const step = rawMax <= 6 ? 2 : rawMax <= 16 ? 5 : rawMax <= 35 ? 10 : 15;
  const yMax = Math.max(step, Math.ceil(rawMax / step) * step);
  const yAt = (val: number) => base - (Math.max(0, val) / yMax) * plotH;

  const gridLines: string[] = [];
  for (let tick = 0; tick <= yMax; tick += step) {
    const y = yAt(tick);
    gridLines.push(
      `<line class="history-grid" x1="${left}" x2="${right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"></line>` +
        `<text class="tick" x="${left - 6}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${tick}</text>`,
    );
  }

  const slotW = plotW / Math.max(points.length, 8);
  const barW = Math.max(12, Math.min(28, slotW * 0.62));
  const totalSlotsW = slotW * points.length;
  const startX = left + (plotW - totalSlotsW) / 2;

  const cols = points
    .map((pt, idx) => {
      const cx = startX + idx * slotW + slotW / 2;
      const bx = cx - barW / 2;
      const h = Math.max(pt.value > 0 ? 4 : 2, (pt.value / yMax) * plotH);
      const by = base - h;
      const tone = !graded ? 'plain' : pt.value === line ? 'push' : pt.value > (line as number) ? 'over' : 'under';
      const active = selectedIndex === idx;
      const shown = Number.isInteger(pt.value) ? String(pt.value) : pt.value.toFixed(1);
      return `<g class="history-col${active ? ' is-selected' : ''}" data-history-bar="${idx}" role="button" tabindex="0" aria-pressed="${active ? 'true' : 'false'}" aria-label="${chartText(pt.ariaLabel)}">
        ${active ? `<rect class="history-band" x="${(cx - slotW * 0.46).toFixed(1)}" y="${top - 14}" width="${(slotW * 0.92).toFixed(1)}" height="${(base - top + 14).toFixed(1)}" rx="6"></rect>` : ''}
        <rect class="bar ${tone}" x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="4"></rect>
        <text class="history-val" x="${cx.toFixed(1)}" y="${Math.max(13, by - 5).toFixed(1)}" text-anchor="middle">${shown}</text>
        <text class="history-opp" x="${cx.toFixed(1)}" y="${base + 16}" text-anchor="middle">${chartText(pt.oppLabel)}</text>
        <text class="history-date" x="${cx.toFixed(1)}" y="${base + 30}" text-anchor="middle">${chartText(pt.shortDate)}</text>
        <rect class="history-hit" x="${(cx - slotW / 2).toFixed(1)}" y="${top - 14}" width="${slotW.toFixed(1)}" height="${H - top + 10}" fill="transparent"></rect>
      </g>`;
    })
    .join('');

  let lineOverlay = '';
  if (graded && (line as number) >= 0 && (line as number) <= yMax) {
    const ly = yAt(line as number);
    const lineText = Number.isInteger(line) ? (line as number).toFixed(1) : String(line);
    const badgeW = Math.max(34, lineText.length * 7.5 + 12);
    lineOverlay = `<line class="history-rule" x1="${left}" x2="${right}" y1="${ly.toFixed(1)}" y2="${ly.toFixed(1)}"></line>
      <g class="history-line-pill" transform="translate(${(right - badgeW - 2).toFixed(1)}, ${(ly - 10).toFixed(1)})">
        <rect width="${badgeW.toFixed(1)}" height="20" rx="5"></rect>
        <text x="${(badgeW / 2).toFixed(1)}" y="14" text-anchor="middle">${chartText(lineText)}</text>
      </g>`;
  }

  return `<svg class="history-bars" viewBox="0 0 ${W} ${H}" role="img" aria-label="${chartText(label)}">
    ${gridLines.join('')}
    <line class="axis" x1="${left}" x2="${right}" y1="${base}" y2="${base}"></line>
    ${cols}
    ${lineOverlay}
  </svg>`;
}
