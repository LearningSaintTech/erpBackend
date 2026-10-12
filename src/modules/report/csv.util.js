/**
 * Shared CSV helpers for server-side exports (reports, waste).
 * - RFC 4180 quoting (commas, quotes, CR/LF)
 * - neutralises spreadsheet formula injection (cells starting with = + - @ tab CR that are not plain numbers)
 * - human-readable labels for camelCase keys and ENUM_VALUES
 */

const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

export function csvCell(value) {
  if (value == null) return '';
  let s = value instanceof Date ? value.toISOString() : String(value);
  if (FORMULA_START.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(cells) {
  return cells.map(csvCell).join(',');
}

/** Lines joined with CRLF and prefixed with a UTF-8 BOM so Excel opens non-ASCII (₹, names) correctly. */
export function csvDocument(headers, rows) {
  return `﻿${[csvRow(headers), ...rows.map(csvRow)].join('\r\n')}\r\n`;
}

const ACRONYMS = new Set(['QC', 'PO', 'PR', 'GRN', 'RFQ', 'FG', 'RM', 'SKU', 'BOM', 'CAPA', 'WIP', 'MTD', 'ID', 'PCT']);

/** IN_PROGRESS → "In progress", QC_REJECT → "QC reject". */
export function humanizeEnum(value) {
  if (value == null || value === '') return '';
  const words = String(value).replace(/[_-]+/g, ' ').trim().split(/\s+/);
  return words.map((w, i) => {
    const up = w.toUpperCase();
    if (ACRONYMS.has(up)) return up;
    const lower = w.toLowerCase();
    return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
  }).join(' ');
}

/** totalPlannedQty → "Total planned qty", openPRs → "Open PRs". */
export function humanizeKey(key) {
  const spaced = String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_.]+/g, ' ')
    .trim();
  return spaced.split(/\s+/).map((w, i) => {
    const bare = w.replace(/s$/, '');
    if (ACRONYMS.has(w.toUpperCase())) return w.toUpperCase();
    if (w.length > 1 && ACRONYMS.has(bare.toUpperCase()) && /^[A-Z]+s$/.test(w)) return `${bare.toUpperCase()}s`;
    const lower = w.toLowerCase();
    return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
  }).join(' ');
}

/** YYYY-MM-DD (dates in exports are calendar dates, not raw ISO timestamps). */
export function csvDate(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}
