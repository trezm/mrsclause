// Row types mirroring migrations/0001_init.sql, plus a few shared queries.

export interface UserRow {
  id: string;
  google_sub: string;
  email: string;
  name: string | null;
  picture: string | null;
  gmail_refresh_token: string | null;
  gmail_connected_at: number | null;
  scan_since: string;
  deadline: string;
  last_scan_at: number | null;
  last_scan_error: string | null;
  scan_started_at: number | null;
  created_at: number;
}

export interface RecipientRow {
  id: string;
  user_id: string;
  name: string;
  budget_cents: number | null;
  notes: string | null;
  created_at: number;
}

export interface ItemRow {
  id: string;
  user_id: string;
  recipient_id: string | null;
  name: string;
  notes: string | null;
  url: string | null;
  target_price_cents: number | null;
  manual_status: "in_hand" | "wrapped" | null;
  manual_price_cents: number | null;
  created_at: number;
  updated_at: number;
}

export interface OrderRow {
  id: string;
  user_id: string;
  vendor: string;
  vendor_key: string;
  order_number: string | null;
  order_key: string | null;
  order_date: string | null;
  total_cents: number | null;
  currency: string;
  status: "ordered" | "shipped" | "out_for_delivery" | "delivered" | "cancelled" | "returned";
  estimated_delivery: string | null;
  has_confirmation: number;
  ignored: number;
  source: "email" | "manual";
  email_subject: string | null;
  note: string | null;
  last_event_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ShipmentRow {
  id: string;
  user_id: string;
  order_id: string | null;
  carrier: string | null;
  tracking_number: string;
  tracking_url: string | null;
  status: "in_transit" | "out_for_delivery" | "delivered" | "exception";
  estimated_delivery: string | null;
  delivered_at: string | null;
  last_event_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface LineRow {
  id: string;
  user_id: string;
  order_id: string;
  description: string;
  quantity: number;
  unit_price_cents: number | null;
  status: "active" | "cancelled" | "returned";
  shipment_id: string | null;
  item_id: string | null;
  match_state: "unmatched" | "suggested" | "matched" | "ignored";
  match_source: "ai" | "fuzzy" | "user" | null;
  suggested_recipient_id: string | null;
  ship_to_name: string | null;
  created_at: number;
}

export interface MutedVendorRow {
  user_id: string;
  vendor_key: string;
  vendor: string;
  created_at: number;
}

export async function getUser(db: D1Database, userId: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<UserRow>();
}

export async function allRows<T>(stmt: D1PreparedStatement): Promise<T[]> {
  const { results } = await stmt.all<T>();
  return results;
}

export function placeholders(count: number): string {
  return new Array(count).fill("?").join(", ");
}
