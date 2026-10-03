const UNIT_MS = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

export function parseDurationMs(value, fallbackMs) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d+)\s*(ms|s|m|h|d)$/i);
  if (!match) return fallbackMs;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  return amount * UNIT_MS[unit];
}
