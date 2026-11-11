import { BadRequestException } from '@nestjs/common';

export const REPORT_ZONE = 'Africa/Lagos';
const DAY = 86_400_000;
const dateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: REPORT_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});

function parseDay(value: string): number {
  const timestamp = Date.parse(value + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new BadRequestException('Use valid dates in YYYY-MM-DD format.');
  }
  return timestamp;
}

function isoDay(value: number) {
  return new Date(value).toISOString().slice(0, 10);
}

export function reportRange(from: string | undefined, to: string | undefined, now: Date) {
  const today = dateFormat.format(now);
  const start = parseDay(from ?? isoDay(parseDay(today) - 7 * DAY));
  const end = parseDay(to ?? isoDay(parseDay(today) - DAY));
  const days = (end - start) / DAY + 1;
  if (days < 1 || days > 92 || end > parseDay(today)) {
    throw new BadRequestException('Choose up to 92 days ending today or earlier.');
  }
  return {
    today, from: isoDay(start), to: isoDay(end), until: isoDay(end + DAY),
    previousFrom: isoDay(start - days * DAY), previousTo: isoDay(start - DAY),
    dates: Array.from({ length: days }, (_, index) => isoDay(start + index * DAY)),
  };
}

export const reportMetrics = [
  'spend', 'cpmSpend', 'cpcSpend', 'posted', 'credits', 'confirmed', 'pending', 'adjustments',
  'billableImpressions', 'billableClicks', 'impressions', 'clicks',
] as const;
export type ReportMetrics = Record<(typeof reportMetrics)[number], string>;

export function emptyReportMetrics(): ReportMetrics {
  return Object.fromEntries(reportMetrics.map(key => [key, '0'])) as ReportMetrics;
}

export function addReportMetrics(total: ReportMetrics, row: ReportMetrics) {
  for (const key of reportMetrics) total[key] = (BigInt(total[key]) + BigInt(row[key])).toString();
}
