export type CsvCell = string | number | null | undefined;

const FORMULA_START = /^[=+@\t\r]|^-(?!\d)/;

function cell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  // Spreadsheet formula injection guard.
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** RFC 4180 CSV with CRLF line endings. */
export function toCsv(headers: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  return [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** Cents → "12.34" for CSV columns. */
export const csvPoints = (cents: number): string => (cents / 100).toFixed(2);
