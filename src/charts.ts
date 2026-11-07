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
