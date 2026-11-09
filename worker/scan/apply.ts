// Merges what the model read from one email into orders, shipments and
// order lines, and links products to the gift list.
//
// Emails arrive in any mix (confirmation, then "shipped", then "delivered",
// sometimes with no order number), so every step looks for an existing order
// first: by order number, then by tracking number.

import { placeholders, type LineRow, type OrderRow, type ShipmentRow } from "../db";
import { clampString, isIsoDate, isoDate, newId, orderKey, squash, toCents, vendorKey } from "../lib/util";
import type { Extraction } from "./extract";
import type { MailMessage } from "./gmail";
import { SAME_PRODUCT_THRESHOLD, bestMatch, matchRecipientName, matchScore, sameProductScore } from "./matching";
import { appearsIn, detectCarrier, looksLikeTrackingNumber, normalizeTrackingNumber, trackingUrl } from "./tracking";

export interface ContextItem {
  id: string;
  name: string;
  recipientId: string | null;
  /** Already linked to a purchase; only suggest it, never auto-link again. */
  matched: boolean;
}

export interface ApplyContext {
  userId: string;
  items: ContextItem[];
  recipients: { id: string; name: string }[];
  mutedVendorKeys: Set<string>;
}

const PROGRESS: Record<string, number> = { ordered: 0, shipped: 1, out_for_delivery: 2, delivered: 3 };
const SHIP_PROGRESS: Record<string, number> = { in_transit: 1, exception: 1, out_for_delivery: 2, delivered: 3 };
const UNKNOWN_VENDOR = "Unknown store";

function orderStatusFor(kind: Extraction["kind"]): OrderRow["status"] | null {
  switch (kind) {
    case "order_confirmation":
      return "ordered";
    case "shipping_update":
      return "shipped";
    case "out_for_delivery":
      return "out_for_delivery";
    case "delivery_confirmation":
      return "delivered";
    default:
      return null;
  }
}

function shipmentStatusFor(kind: Extraction["kind"]): ShipmentRow["status"] | null {
  switch (kind) {
    case "shipping_update":
      return "in_transit";
    case "out_for_delivery":
      return "out_for_delivery";
    case "delivery_confirmation":
      return "delivered";
    default:
      return null;
  }
}

/** `"Target" <orders@target.com>` -> "Target", unless the sender is a carrier. */
export function senderName(from: string): string | null {
  const name = /^\s*"?([^"<]+?)"?\s*</.exec(from)?.[1]?.trim();
  if (!name || detectCarrier("", name)) return null;
  return name.slice(0, 80);
}

function currency(value: string | null): string {
  return value && /^[A-Za-z]{3}$/.test(value.trim()) ? value.trim().toUpperCase() : "USD";
}

export async function applyExtraction(
  db: D1Database,
  ctx: ApplyContext,
  email: MailMessage,
  x: Extraction,
  /** Extra statements (e.g. marking the email done) committed in the same transaction. */
  finalize: (orderId: string | null) => D1PreparedStatement[] = () => [],
): Promise<{ orderId: string | null }> {
  const nothing = async () => {
    const extra = finalize(null);
    if (extra.length) await db.batch(extra);
    return { orderId: null };
  };
  if (x.kind === "not_order_related") return nothing();

  const now = Date.now();
  const haystack = squash(`${email.subject}\n${email.text}`);
  const emailDay = isoDate(email.date);
  const eta = isIsoDate(x.estimated_delivery) ? x.estimated_delivery : null;

  // Keep only identifiers that literally appear in the email.
  const orderNumber =
    x.order_number && appearsIn(x.order_number, haystack) ? x.order_number.trim().slice(0, 64) : null;
  const key = orderKey(orderNumber);
  const tracked = new Map<string, Extraction["shipments"][number]>();
  for (const s of x.shipments) {
    const number = normalizeTrackingNumber(s.tracking_number);
    if (tracked.size >= 20) break;
    if (looksLikeTrackingNumber(number) && number !== key && appearsIn(number, haystack)) tracked.set(number, s);
  }
  const products = x.items
    .map((i) => ({
      ...i,
      description: (clampString(i.description, 300) ?? "").replace(/\s+/g, " "),
      quantity: Math.max(1, Math.round(i.quantity ?? 1)),
      unitPriceCents: i.unit_price !== null && i.unit_price >= 0 ? toCents(i.unit_price) : null,
    }))
    .filter((i) => i.description.length > 1);

  if (!key && tracked.size === 0 && products.length === 0) return nothing();

  // 1. Find the order this email is about. Both lookups go in one batch,
  // which D1 counts as a single query against the per-request limit.
  const numbers = [...tracked.keys()];
  const [byKey, byTracking] = await db.batch([
    db.prepare("SELECT * FROM orders WHERE user_id = ? AND order_key = ?").bind(ctx.userId, key ?? ""),
    db
      .prepare(`SELECT * FROM shipments WHERE user_id = ? AND tracking_number IN (${placeholders(Math.max(1, numbers.length))})`)
      .bind(ctx.userId, ...(numbers.length ? numbers : [""])),
  ]);
  // Small shops reuse order numbers (#1001, #1002...), so a number only
  // identifies an order together with its store.
  const vendor = clampString(x.vendor, 80);
  const store = vendor ? vendorKey(vendor) : null;
  const sameStore = (o: OrderRow) =>
    !store || o.vendor === UNKNOWN_VENDOR || o.vendor_key.includes(store) || store.includes(o.vendor_key);
  let order: OrderRow | null = key ? ((byKey!.results as OrderRow[]).find(sameStore) ?? null) : null;
  const knownShipments = byTracking!.results as ShipmentRow[];
  if (!order) {
    const linked = knownShipments.find((s) => s.order_id);
    if (linked) order = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(linked.order_id).first<OrderRow>();
  }
  if (!order && (x.kind === "cancellation" || x.kind === "return_or_refund")) {
    return nothing(); // Nothing we know about to cancel.
  }

  const statements: D1PreparedStatement[] = [];
  const kindStatus = orderStatusFor(x.kind);
  const isNew = !order;
  const hadConfirmation = order?.has_confirmation === 1;

  if (!order) {
    const name = vendor ?? senderName(email.from) ?? UNKNOWN_VENDOR;
    const vKey = vendorKey(name);
    order = {
      id: newId("ord"),
      user_id: ctx.userId,
      vendor: name,
      vendor_key: vKey,
      order_number: orderNumber,
      order_key: key,
      order_date: isIsoDate(x.order_date) ? x.order_date : emailDay,
      total_cents: toCents(x.order_total),
      currency: currency(x.currency),
      status: kindStatus ?? "ordered",
      estimated_delivery: eta,
      has_confirmation: x.kind === "order_confirmation" ? 1 : 0,
      ignored: ctx.mutedVendorKeys.has(vKey) ? 1 : 0,
      source: "email",
      email_subject: email.subject.slice(0, 200),
      note: null,
      last_event_at: email.date,
      created_at: now,
      updated_at: now,
    };
    statements.push(
      db
        .prepare(
          `INSERT INTO orders (id, user_id, vendor, vendor_key, order_number, order_key, order_date, total_cents,
             currency, status, estimated_delivery, has_confirmation, ignored, source, email_subject, last_event_at,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          order.id, order.user_id, order.vendor, order.vendor_key, order.order_number, order.order_key,
          order.order_date, order.total_cents, order.currency, order.status, order.estimated_delivery,
          order.has_confirmation, order.ignored, order.source, order.email_subject, order.last_event_at,
          order.created_at, order.updated_at,
        ),
    );
  } else {
    const o = { ...order };
    if (o.vendor === UNKNOWN_VENDOR && vendor) {
      o.vendor = vendor;
      o.vendor_key = vendorKey(vendor);
    }
    if (!o.order_key && key) {
      o.order_number = orderNumber;
      o.order_key = key;
    }
    if (!o.order_date && isIsoDate(x.order_date)) o.order_date = x.order_date;
    if (x.order_total !== null && (o.total_cents === null || x.kind === "order_confirmation")) {
      o.total_cents = toCents(x.order_total);
    }
    if (x.kind === "order_confirmation") {
      o.has_confirmation = 1;
      o.email_subject = email.subject.slice(0, 200);
      if (x.currency) o.currency = currency(x.currency);
    }
    const newer = (o.last_event_at ?? 0) <= email.date;
    if (eta && (newer || !o.estimated_delivery)) o.estimated_delivery = eta;
    const active = o.status !== "cancelled" && o.status !== "returned";
    if (kindStatus && active && PROGRESS[kindStatus]! > PROGRESS[o.status]!) o.status = kindStatus;
    o.last_event_at = Math.max(o.last_event_at ?? 0, email.date);
    o.updated_at = now;
    statements.push(
      db
        .prepare(
          `UPDATE orders SET vendor = ?, vendor_key = ?, order_number = ?, order_key = ?, order_date = ?, total_cents = ?,
             currency = ?, status = ?, estimated_delivery = ?, has_confirmation = ?, email_subject = ?,
             last_event_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .bind(
          o.vendor, o.vendor_key, o.order_number, o.order_key, o.order_date, o.total_cents, o.currency, o.status,
          o.estimated_delivery, o.has_confirmation, o.email_subject, o.last_event_at, o.updated_at, o.id,
        ),
    );
    order = o;
  }
  const orderId = order.id;

  let existingLines: LineRow[] = [];
  let orderShipments: ShipmentRow[] = [];
  if (!isNew) {
    const [lineRows, shipmentRows] = await db.batch([
      db.prepare("SELECT * FROM order_lines WHERE order_id = ?").bind(orderId),
      db.prepare("SELECT * FROM shipments WHERE order_id = ?").bind(orderId),
    ]);
    existingLines = lineRows!.results as LineRow[];
    orderShipments = shipmentRows!.results as ShipmentRow[];
  }

  // An earlier email (often the carrier's) may have created a separate order
  // with no order number for a package that belongs to this order. Fold it in
  // so the purchase isn't counted twice.
  const strayIds = [
    ...new Set(knownShipments.map((s) => s.order_id).filter((id): id is string => !!id && id !== orderId)),
  ];
  if (!isNew && strayIds.length > 0) {
    const ph = placeholders(strayIds.length);
    const [strayOrders, strayLines, strayShipments] = await db.batch([
      db.prepare(`SELECT * FROM orders WHERE user_id = ? AND order_key IS NULL AND id IN (${ph})`).bind(ctx.userId, ...strayIds),
      db.prepare(`SELECT * FROM order_lines WHERE user_id = ? AND order_id IN (${ph})`).bind(ctx.userId, ...strayIds),
      db.prepare(`SELECT * FROM shipments WHERE user_id = ? AND order_id IN (${ph})`).bind(ctx.userId, ...strayIds),
    ]);
    const mergeable = new Set((strayOrders!.results as OrderRow[]).map((o) => o.id));
    for (const s of strayShipments!.results as ShipmentRow[]) {
      if (!s.order_id || !mergeable.has(s.order_id)) continue;
      statements.push(db.prepare("UPDATE shipments SET order_id = ? WHERE id = ?").bind(orderId, s.id));
      orderShipments.push({ ...s, order_id: orderId });
      const known = knownShipments.find((k) => k.id === s.id);
      if (known) known.order_id = orderId;
    }
    for (const l of strayLines!.results as LineRow[]) {
      if (!mergeable.has(l.order_id)) continue;
      const twin = existingLines.find((e) => sameProductScore(l.description, e.description) >= SAME_PRODUCT_THRESHOLD);
      if (!twin) {
        statements.push(db.prepare("UPDATE order_lines SET order_id = ? WHERE id = ?").bind(orderId, l.id));
        existingLines.push({ ...l, order_id: orderId });
        continue;
      }
      // Keep a decision the user already made on the duplicate.
      const decided = l.match_state === "matched" || l.match_state === "ignored";
      if (decided && (twin.match_state === "unmatched" || twin.match_state === "suggested")) {
        Object.assign(twin, { item_id: l.item_id, match_state: l.match_state, match_source: l.match_source });
        statements.push(
          db
            .prepare("UPDATE order_lines SET item_id = ?, match_state = ?, match_source = ? WHERE id = ?")
            .bind(l.item_id, l.match_state, l.match_source, twin.id),
        );
      }
      statements.push(db.prepare("DELETE FROM order_lines WHERE id = ?").bind(l.id));
    }
    for (const id of mergeable) statements.push(db.prepare("DELETE FROM orders WHERE id = ?").bind(id));
  }

  // 2. Shipments named in this email.
  const shipmentIdsInEmail: string[] = [];
  for (const [number, s] of tracked) {
    const existing = knownShipments.find((k) => k.tracking_number === number);
    const carrier = detectCarrier(number, s.carrier) ?? clampString(s.carrier, 40);
    const shipEta = isIsoDate(s.estimated_delivery) ? s.estimated_delivery : eta;
    if (existing) {
      const newer = (existing.last_event_at ?? 0) <= email.date;
      const status = newer && existing.status !== "delivered" ? s.status : existing.status;
      statements.push(
        db
          .prepare(
            `UPDATE shipments SET order_id = COALESCE(order_id, ?), carrier = COALESCE(carrier, ?),
               tracking_url = COALESCE(tracking_url, ?), status = ?, estimated_delivery = ?, delivered_at = ?,
               last_event_at = ?, updated_at = ?
             WHERE id = ?`,
          )
          .bind(
            orderId, carrier, trackingUrl(carrier, number), status,
            newer && shipEta ? shipEta : existing.estimated_delivery,
            status === "delivered" ? (existing.delivered_at ?? emailDay) : existing.delivered_at,
            Math.max(existing.last_event_at ?? 0, email.date), now, existing.id,
          ),
      );
      shipmentIdsInEmail.push(existing.id);
    } else {
      const id = newId("shp");
      statements.push(
        db
          .prepare(
            `INSERT INTO shipments (id, user_id, order_id, carrier, tracking_number, tracking_url, status,
               estimated_delivery, delivered_at, last_event_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            id, ctx.userId, orderId, carrier, number, trackingUrl(carrier, number), s.status, shipEta,
            s.status === "delivered" ? emailDay : null, email.date, now, now,
          ),
      );
      shipmentIdsInEmail.push(id);
    }
  }
  const emailShipmentId = shipmentIdsInEmail.length === 1 ? shipmentIdsInEmail[0]! : null;

  // 3. Products: reuse lines we already have, add new ones where allowed.
  // Once the confirmation has been read, it is the source of truth for what
  // was bought; later emails only refer back to those lines.
  const isCancelOrReturn = x.kind === "cancellation" || x.kind === "return_or_refund";
  const canAddLines = !isCancelOrReturn && (isNew || !hadConfirmation || x.kind === "order_confirmation");
  const lines = [...existingLines];
  const touched: LineRow[] = [];
  const shipToRecipient = matchRecipientName(x.ship_to_name, ctx.recipients);

  for (const p of products) {
    let line: LineRow | null = null;
    let bestScore = SAME_PRODUCT_THRESHOLD;
    for (const l of lines) {
      const score = sameProductScore(p.description, l.description);
      if (score >= bestScore && !touched.includes(l)) {
        bestScore = score;
        line = l;
      }
    }
    if (line) {
      touched.push(line);
      if (emailShipmentId && line.shipment_id !== emailShipmentId) {
        line.shipment_id = emailShipmentId;
        statements.push(db.prepare("UPDATE order_lines SET shipment_id = ? WHERE id = ?").bind(emailShipmentId, line.id));
      }
      continue;
    }
    if (!canAddLines) continue;

    // Decide how this product relates to the gift list.
    let matchState: LineRow["match_state"] = "unmatched";
    let matchSource: LineRow["match_source"] = null;
    let itemId: string | null = null;
    const aiPick = p.matched_list_item_id ? ctx.items.find((i) => i.id === p.matched_list_item_id) : undefined;
    // Auto-link only when the names also overlap, so a misleading email can't
    // quietly mark an unrelated gift as bought; otherwise just suggest it.
    const namesAgree = aiPick ? matchScore(aiPick.name, p.description) >= 0.5 : false;
    if (aiPick && p.match_confidence === "high" && !aiPick.matched && namesAgree) {
      matchState = "matched";
      matchSource = "ai";
      itemId = aiPick.id;
      aiPick.matched = true;
    } else if (aiPick && (p.match_confidence === "high" || p.match_confidence === "medium")) {
      matchState = "suggested";
      matchSource = "ai";
      itemId = aiPick.id;
    } else {
      const fuzzy = bestMatch(p.description, ctx.items.filter((i) => !i.matched));
      if (fuzzy) {
        matchState = "suggested";
        matchSource = "fuzzy";
        itemId = fuzzy.candidate.id;
      }
    }

    const newLine: LineRow = {
      id: newId("lin"),
      user_id: ctx.userId,
      order_id: orderId,
      description: p.description,
      quantity: p.quantity,
      unit_price_cents: p.unitPriceCents,
      status: "active",
      shipment_id: emailShipmentId,
      item_id: itemId,
      match_state: matchState,
      match_source: matchSource,
      suggested_recipient_id: shipToRecipient?.id ?? null,
      ship_to_name: clampString(x.ship_to_name, 80),
      created_at: now,
    };
    lines.push(newLine);
    touched.push(newLine);
    // The gift or person may have been deleted while the scan was running;
    // the joins turn a missing one into "no match" instead of a failed insert.
    statements.push(
      db
        .prepare(
          `INSERT INTO order_lines (id, user_id, order_id, description, quantity, unit_price_cents, status, shipment_id,
             item_id, match_state, match_source, suggested_recipient_id, ship_to_name, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, i.id,
             CASE WHEN i.id IS NULL THEN 'unmatched' ELSE ? END,
             CASE WHEN i.id IS NULL THEN NULL ELSE ? END,
             r.id, ?, ?
           FROM (SELECT 1) AS one
           LEFT JOIN items i ON i.id = ? AND i.user_id = ?
           LEFT JOIN recipients r ON r.id = ? AND r.user_id = ?`,
        )
        .bind(
          newLine.id, newLine.user_id, newLine.order_id, newLine.description, newLine.quantity,
          newLine.unit_price_cents, newLine.status, newLine.shipment_id, newLine.match_state, newLine.match_source,
          newLine.ship_to_name, newLine.created_at, newLine.item_id ?? "", ctx.userId,
          newLine.suggested_recipient_id ?? "", ctx.userId,
        ),
    );
  }

  // 4. Cancellations and returns, for the listed products or the whole order.
  if (isCancelOrReturn) {
    const lineStatus = x.kind === "cancellation" ? "cancelled" : "returned";
    const targets: LineRow[] = [];
    const unmatched: string[] = [];
    if (products.length === 0) {
      targets.push(...lines);
    } else {
      // Looser matching than for duplicates: cancellation emails often
      // shorten or reword product names.
      for (const p of products) {
        let best: LineRow | null = null;
        let bestScore = 0.5;
        for (const l of lines) {
          const score = Math.max(sameProductScore(p.description, l.description), matchScore(l.description, p.description));
          if (score >= bestScore && !targets.includes(l)) {
            best = l;
            bestScore = score;
          }
        }
        if (!best && lines.length === 1 && products.length === 1) best = lines[0]!;
        if (best) targets.push(best);
        else unmatched.push(p.description);
      }
    }
    for (const l of targets) {
      statements.push(db.prepare("UPDATE order_lines SET status = ? WHERE id = ?").bind(lineStatus, l.id));
    }
    if (products.length === 0 || (lines.length > 0 && targets.length === lines.length)) {
      statements.push(db.prepare("UPDATE orders SET status = ?, updated_at = ? WHERE id = ?").bind(lineStatus, now, orderId));
    }
    if (unmatched.length > 0) {
      const what = x.kind === "cancellation" ? "A cancellation" : "A return";
      const note = `${what} email mentioned \u201c${unmatched.join("\u201d, \u201c")}\u201d, which doesn't match a product on this order.`;
      statements.push(db.prepare("UPDATE orders SET note = ? WHERE id = ?").bind(note.slice(0, 500), orderId));
    }
  }

  // 5. "Out for delivery" / "Delivered" emails without a tracking number:
  // update the order's shipment when we can tell which one it is.
  // Only moves a package forward; a vague "shipped" email might be about a
  // second package, so it never changes a known one.
  const statusOnly = x.kind === "shipping_update" ? null : shipmentStatusFor(x.kind);
  if (statusOnly && tracked.size === 0 && orderShipments.length > 0) {
    const ids = new Set(touched.map((l) => l.shipment_id).filter((id): id is string => !!id));
    const targets = orderShipments.length === 1 ? orderShipments : orderShipments.filter((s) => ids.has(s.id));
    for (const s of targets) {
      if (SHIP_PROGRESS[statusOnly]! <= SHIP_PROGRESS[s.status]! || (s.last_event_at ?? 0) > email.date) continue;
      statements.push(
        db
          .prepare(
            "UPDATE shipments SET status = ?, delivered_at = ?, last_event_at = ?, estimated_delivery = COALESCE(?, estimated_delivery), updated_at = ? WHERE id = ?",
          )
          .bind(statusOnly, statusOnly === "delivered" ? emailDay : null, email.date, eta, now, s.id),
      );
    }
  }

  await db.batch([...statements, ...finalize(orderId)]);
  return { orderId };
}
