import type { Scalar } from './types';

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const plain = new Intl.NumberFormat();

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 100_000) return compact.format(value);
  if (!Number.isInteger(value)) return value.toFixed(Math.abs(value) < 10 ? 2 : 1);
  return plain.format(value);
}

export function formatBytes(value: number): string {
  const sign = value < 0 ? '−' : '+';
  const abs = Math.abs(value);
  if (abs < 1024) return `${sign}${abs} B`;
  if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)} kB`;
  return `${sign}${(abs / 1024 / 1024).toFixed(2)} MB`;
}

export function formatAgo(seconds: number): string {
  if (seconds < 1) return 'now';
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

export function formatWindow(seconds: number | null): string {
  if (seconds == null) return 'all buffered';
  if (seconds < 60) return `last ${seconds}s`;
  if (seconds < 3600) return `last ${Math.round(seconds / 60)}m`;
  return `last ${Math.round(seconds / 3600)}h`;
}

/** Render a result cell. Kept total: a live table must never crash on a value. */
export function formatCell(value: Scalar): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') return formatNumber(value);
  if (Array.isArray(value)) {
    return value.map(([k, n]) => `${k} (${formatNumber(n)})`).join(', ');
  }
  return String(value);
}

export function isNumericColumn(name: string, rows: Array<{ row: Scalar[] }>, index: number): boolean {
  void name;
  for (const { row } of rows) {
    const value = row[index];
    if (value === null || value === undefined) continue;
    return typeof value === 'number';
  }
  return false;
}

/** Wikipedia namespace ids, for the handful the UI surfaces. */
export const NAMESPACES: Record<number, string> = {
  0: 'article',
  1: 'talk',
  2: 'user',
  3: 'user talk',
  4: 'project',
  6: 'file',
  10: 'template',
  14: 'category',
};
