const CHICAGO = 'America/Chicago';

export function chicagoDate(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CHICAGO,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const year = parts.find((part) => part.type === 'year')?.value ?? '0000';
  const month = parts.find((part) => part.type === 'month')?.value ?? '00';
  const day = parts.find((part) => part.type === 'day')?.value ?? '00';
  return `${year}-${month}-${day}`;
}

/** Today and the day before. Each extra day republishes another full set of matchup rates. */
export const PUBLISHED_SLATE_DAYS = 2;

export function shiftChicagoDate(date: string, days: number): string {
  const anchor = Date.parse(`${date}T18:00:00Z`);
  if (!Number.isFinite(anchor)) return date;
  return chicagoDate(new Date(anchor + days * 86400000));
}

export function recentChicagoDates(anchor: string, days = PUBLISHED_SLATE_DAYS): string[] {
  const count = Math.max(1, days);
  const dates: string[] = [];
  for (let ago = count - 1; ago >= 0; ago -= 1) dates.push(shiftChicagoDate(anchor, -ago));
  return dates;
}

export function formatTip(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: CHICAGO,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}
