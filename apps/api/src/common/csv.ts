/**
 * One spreadsheet cell, safe to open in Excel: a value that starts like a formula (= + - @, or a
 * tab or carriage return) is prefixed with ' so it is shown, never run. Quotes and commas are
 * escaped. Every CSV export uses this.
 */
export function csvCell(v: unknown): string {
  let t = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

/** A CSV file from a header and rows, with a byte-order mark so Excel reads accents correctly. */
export function csvFile(header: string[], rows: unknown[][]): string {
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
