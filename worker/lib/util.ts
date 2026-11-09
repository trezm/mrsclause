export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' for a timestamp, in UTC. */
export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

export function addDays(date: string, days: number): string {
  return isoDate(Date.parse(date) + days * DAY_MS);
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
}

/** The next Dec 25 on or after `today`. */
export function defaultDeadline(today: string): string {
  const year = Number(today.slice(0, 4));
  const thisYear = `${year}-12-25`;
  return today <= thisYear ? thisYear : `${year + 1}-12-25`;
}

export function toCents(amount: number | null | undefined): number | null {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return null;
  return Math.round(amount * 100);
}

/** "Amazon.com, Inc." -> "amazon" */
export function vendorKey(vendor: string): string {
  const plain = vendor.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const stripped = vendor
    .toLowerCase()
    .replace(/\.(com|net|org|co\.uk|ca)\b/g, " ")
    .replace(/\b(inc|llc|ltd|co|corp|corporation|store|shop|official)\b\.?/g, " ")
    .replace(/[^a-z0-9]+/g, "");
  return stripped || plain || "unknown";
}

/** "#112-4455-77" -> "112445577" */
export function orderKey(orderNumber: string | null | undefined): string | null {
  if (!orderNumber) return null;
  const key = orderNumber.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return key.length >= 4 ? key : null;
}

/** Text squashed to uppercase letters and digits, for "does X appear in this email" checks. */
export function squash(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function clampString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}
