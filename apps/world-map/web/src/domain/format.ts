// Safe, presentational formatting. Never throws on missing/edge values; callers pass raw
// server values and get citizen-safe strings back.

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const plain = new Intl.NumberFormat("en-US");

/** Population as a compact label (e.g. 1.2M, 340K). */
export function formatPopulation(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "unknown";
  return compact.format(value);
}

/** Exact integer with thousands separators (used in detail rows). */
export function formatCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "0";
  return plain.format(value);
}

/**
 * Economy treasury summary. The server exposes only an aggregate treasury + currency label;
 * we never invent detail beyond that.
 */
export function formatTreasury(
  treasury: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (treasury == null || !Number.isFinite(treasury)) return "not reported";
  const unit = currency && currency.trim() ? currency.trim() : "credits";
  return `${compact.format(treasury)} ${unit}`;
}

/** Signed decimal to a fixed precision (metrics). */
export function formatDecimal(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

/** Bounded metric as a percentage of its known range (for bar widths / labels). */
export function toPercent(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || max === min) return 0;
  const clamped = Math.min(max, Math.max(min, value));
  return ((clamped - min) / (max - min)) * 100;
}

/** Title-cased stance/kind label, tolerating unknown open-set values. */
export function humanize(value: string | null | undefined): string {
  if (!value) return "unknown";
  return value.charAt(0).toUpperCase() + value.slice(1);
}
