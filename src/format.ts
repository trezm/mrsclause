import type { ItemStatus, OrderStatus, ShipmentStatus } from "../shared/types";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const moneyRound = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function formatMoney(cents: number | null | undefined, round = false): string {
  if (cents === null || cents === undefined) return "—";
  return (round ? moneyRound : money).format(cents / 100);
}

/** "$12.50" / "12.5" / "" -> cents or null. */
export function parseMoney(input: string): number | null {
  const cleaned = input.replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

export function centsToInput(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? "" : (cents / 100).toFixed(2);
}

export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseDay(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}

export function dayDiff(from: string, to: string): number {
  return Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / 86_400_000);
}

/** "Today", "Tomorrow", "Wed, Nov 12" */
export function friendlyDay(day: string | null, today: string): string {
  if (!day) return "No date yet";
  const diff = dayDiff(today, day);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  const date = parseDay(day);
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  return date.toLocaleDateString("en-US", {
    weekday: Math.abs(diff) < 7 ? "short" : undefined,
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
}

/** friendlyDay for use mid-sentence: "arrives today", "arrives Dec 23". */
export function friendlyDayInline(day: string | null, today: string): string {
  const text = friendlyDay(day, today);
  return /^(Today|Tomorrow|Yesterday|No date yet)$/.test(text) ? text.toLowerCase() : text;
}

export function timeAgo(ms: number | null): string {
  if (!ms) return "never";
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export const ITEM_STATUS_LABEL: Record<ItemStatus, string> = {
  idea: "To buy",
  ordered: "Ordered",
  shipped: "Shipped",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  wrapped: "Wrapped",
  cancelled: "Cancelled",
};

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  ordered: "Ordered",
  shipped: "Shipped",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  cancelled: "Cancelled",
  returned: "Returned",
};

export const SHIPMENT_STATUS_LABEL: Record<ShipmentStatus, string> = {
  in_transit: "In transit",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  exception: "Delayed",
};
