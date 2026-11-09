// Builds the one-shot dashboard payload: gifts with derived status and
// spend, per-person totals, orders, and the numbers for the top tiles.

import type {
  Dashboard,
  Item,
  ItemStatus,
  Order,
  OrderLine,
  Purchase,
  Recipient,
  RiskLevel,
  Shipment,
  Stats,
} from "../shared/types";
import type { ItemRow, LineRow, MutedVendorRow, OrderRow, RecipientRow, ShipmentRow, UserRow } from "./db";
import { addDays, daysBetween } from "./lib/util";

export interface DashboardInput {
  user: UserRow;
  recipients: RecipientRow[];
  items: ItemRow[];
  orders: OrderRow[];
  lines: LineRow[];
  shipments: ShipmentRow[];
  muted: MutedVendorRow[];
  failedEmailCount: number;
  today: string;
  devMode: boolean;
}

const RANK: Record<ItemStatus, number> = {
  idea: 0,
  ordered: 1,
  shipped: 2,
  out_for_delivery: 3,
  delivered: 4,
  wrapped: 5,
  cancelled: -1,
};

function later(a: ItemStatus, b: ItemStatus): ItemStatus {
  return RANK[a] >= RANK[b] ? a : b;
}

function earliest(statuses: ItemStatus[]): ItemStatus {
  return statuses.reduce((min, s) => (RANK[s] < RANK[min] ? s : min));
}

function fromShipment(status: ShipmentRow["status"]): ItemStatus {
  if (status === "delivered") return "delivered";
  if (status === "out_for_delivery") return "out_for_delivery";
  return "shipped";
}

function fromOrder(status: OrderRow["status"]): ItemStatus {
  if (status === "cancelled" || status === "returned") return "cancelled";
  return status;
}

function toShipment(s: ShipmentRow): Shipment {
  return {
    id: s.id,
    orderId: s.order_id,
    carrier: s.carrier,
    trackingNumber: s.tracking_number,
    trackingUrl: s.tracking_url,
    status: s.status,
    estimatedDelivery: s.estimated_delivery,
    deliveredAt: s.delivered_at,
  };
}

/** Where one order line is, using its own shipment when we know it. */
export function lineProgress(line: LineRow, order: OrderRow, orderShipments: ShipmentRow[]): ItemStatus {
  if (line.status !== "active") return "cancelled";
  const orderStatus = fromOrder(order.status);
  if (orderStatus === "cancelled") return "cancelled";
  const own = line.shipment_id ? orderShipments.find((s) => s.id === line.shipment_id) : undefined;
  if (own) return orderShipments.length <= 1 ? later(fromShipment(own.status), orderStatus) : fromShipment(own.status);
  if (orderShipments.length === 1) return later(fromShipment(orderShipments[0]!.status), orderStatus);
  if (orderShipments.length > 1) return earliest(orderShipments.map((s) => fromShipment(s.status)));
  return orderStatus;
}

function lineShipment(line: LineRow, orderShipments: ShipmentRow[]): ShipmentRow | null {
  if (line.shipment_id) return orderShipments.find((s) => s.id === line.shipment_id) ?? null;
  return orderShipments.length === 1 ? orderShipments[0]! : null;
}

function lineAmount(line: LineRow, order: OrderRow, orderLines: LineRow[]): number | null {
  if (line.unit_price_cents !== null) return line.unit_price_cents * line.quantity;
  if (orderLines.length === 1 && order.total_cents !== null) return order.total_cents;
  return null;
}

function riskFor(status: ItemStatus, eta: string | null, today: string, deadline: string): RiskLevel {
  const daysLeft = daysBetween(today, deadline);
  if (daysLeft < 0) return null;
  if (status === "idea") return daysLeft <= 10 ? "close" : null;
  if (status !== "ordered" && status !== "shipped" && status !== "out_for_delivery") return null;
  if (eta) {
    if (eta > deadline) return "late";
    if (eta > addDays(deadline, -3)) return "close";
    return null;
  }
  return daysLeft <= 7 ? "close" : null;
}

export function buildDashboard(input: DashboardInput): Dashboard {
  const { user, today } = input;
  const deadline = user.deadline;

  const shipmentsByOrder = new Map<string, ShipmentRow[]>();
  for (const s of input.shipments) {
    if (!s.order_id) continue;
    const list = shipmentsByOrder.get(s.order_id) ?? [];
    list.push(s);
    shipmentsByOrder.set(s.order_id, list);
  }
  const linesByOrder = new Map<string, LineRow[]>();
  for (const l of input.lines) {
    const list = linesByOrder.get(l.order_id) ?? [];
    list.push(l);
    linesByOrder.set(l.order_id, list);
  }
  const ordersById = new Map(input.orders.map((o) => [o.id, o]));

  const orders: Order[] = input.orders.map((o) => {
    const ships = shipmentsByOrder.get(o.id) ?? [];
    const lines = linesByOrder.get(o.id) ?? [];
    // An order is as far along as its least-advanced active product.
    let status: Order["status"] = o.status;
    if (o.status !== "cancelled" && o.status !== "returned") {
      const active = lines.filter((l) => l.status === "active");
      let progress: ItemStatus = fromOrder(o.status);
      if (active.length > 0) progress = earliest(active.map((l) => lineProgress(l, o, ships)));
      else if (lines.length > 0) progress = "cancelled";
      else if (ships.length > 0) progress = later(earliest(ships.map((x) => fromShipment(x.status))), progress);
      status = progress === "idea" || progress === "wrapped" ? "ordered" : progress;
    }
    return {
      id: o.id,
      vendor: o.vendor,
      orderNumber: o.order_number,
      orderDate: o.order_date,
      totalCents: o.total_cents,
      currency: o.currency,
      status,
      estimatedDelivery: o.estimated_delivery,
      ignored: o.ignored === 1,
      source: o.source,
      emailSubject: o.email_subject,
      note: o.note,
      shipments: ships.map(toShipment),
      lines: lines.map(
        (l): OrderLine => ({
          id: l.id,
          orderId: l.order_id,
          description: l.description,
          quantity: l.quantity,
          unitPriceCents: l.unit_price_cents,
          amountCents: lineAmount(l, o, lines),
          status: l.status,
          shipmentId: l.shipment_id,
          itemId: l.item_id,
          matchState: l.match_state,
          matchSource: l.match_source,
          suggestedRecipientId: l.suggested_recipient_id,
          shipToName: l.ship_to_name,
        }),
      ),
    };
  });

  const purchasesByItem = new Map<string, Purchase[]>();
  for (const l of input.lines) {
    if (l.match_state !== "matched" || !l.item_id) continue;
    const order = ordersById.get(l.order_id);
    if (!order || order.ignored) continue;
    const ships = shipmentsByOrder.get(order.id) ?? [];
    const status = lineProgress(l, order, ships);
    const shipment = lineShipment(l, ships);
    const list = purchasesByItem.get(l.item_id) ?? [];
    list.push({
      lineId: l.id,
      orderId: order.id,
      vendor: order.vendor,
      orderNumber: order.order_number,
      orderDate: order.order_date,
      description: l.description,
      amountCents: lineAmount(l, order, linesByOrder.get(order.id) ?? []),
      status,
      eta: status === "delivered" ? null : (shipment?.estimated_delivery ?? order.estimated_delivery),
      shipment: shipment ? toShipment(shipment) : null,
    });
    purchasesByItem.set(l.item_id, list);
  }

  const items: Item[] = input.items.map((row) => {
    const purchases = purchasesByItem.get(row.id) ?? [];
    const active = purchases.filter((p) => p.status !== "cancelled");
    let status: ItemStatus;
    if (row.manual_status === "wrapped") status = "wrapped";
    else if (row.manual_status === "in_hand") status = "delivered";
    else if (active.length > 0) status = earliest(active.map((p) => p.status));
    else if (purchases.length > 0) status = "cancelled";
    else status = "idea";
    const etas = active.map((p) => p.eta).filter((e): e is string => !!e);
    const eta = RANK[status] >= RANK.delivered ? null : (etas.sort().at(-1) ?? null);
    const spentCents =
      active.reduce((sum, p) => sum + (p.amountCents ?? 0), 0) + (row.manual_price_cents ?? 0);
    return {
      id: row.id,
      name: row.name,
      recipientId: row.recipient_id,
      notes: row.notes,
      url: row.url,
      targetPriceCents: row.target_price_cents,
      manualStatus: row.manual_status,
      manualPriceCents: row.manual_price_cents,
      status,
      spentCents,
      eta,
      risk: riskFor(status, eta, today, deadline),
      purchases,
    };
  });

  const recipients: Recipient[] = input.recipients.map((r) => {
    const mine = items.filter((i) => i.recipientId === r.id);
    return {
      id: r.id,
      name: r.name,
      budgetCents: r.budget_cents,
      notes: r.notes,
      spentCents: mine.reduce((sum, i) => sum + i.spentCents, 0),
      itemCount: mine.length,
      boughtCount: mine.filter((i) => i.status !== "idea" && i.status !== "cancelled").length,
    };
  });

  // Totals across everything bought, including purchases not yet sorted.
  let spentCents = input.items.reduce((sum, i) => sum + (i.manual_price_cents ?? 0), 0);
  let unsortedCents = 0;
  let needsReviewCount = 0;
  for (const o of orders) {
    if (o.ignored || o.status === "cancelled" || o.status === "returned") continue;
    if (o.lines.length === 0) {
      spentCents += o.totalCents ?? 0;
      unsortedCents += o.totalCents ?? 0;
      needsReviewCount++;
      continue;
    }
    for (const l of o.lines) {
      if (l.status !== "active" || l.matchState === "ignored") continue;
      spentCents += l.amountCents ?? 0;
      if (l.matchState !== "matched") {
        unsortedCents += l.amountCents ?? 0;
        needsReviewCount++;
      }
    }
  }

  const weekOut = addDays(today, 7);
  let inTransitCount = 0;
  let arrivingThisWeekCount = 0;
  for (const o of orders) {
    if (o.ignored || o.status === "cancelled" || o.status === "returned") continue;
    for (const s of o.shipments) {
      if (s.status === "delivered") continue;
      inTransitCount++;
      const eta = s.estimatedDelivery ?? o.estimatedDelivery;
      if (eta && eta <= weekOut) arrivingThisWeekCount++;
    }
    if (o.shipments.length === 0 && o.status !== "delivered" && o.estimatedDelivery && o.estimatedDelivery <= weekOut) {
      arrivingThisWeekCount++;
    }
  }

  const stats: Stats = {
    spentCents,
    unsortedCents,
    budgetCents: input.recipients.reduce((sum, r) => sum + (r.budget_cents ?? 0), 0),
    itemCount: items.length,
    boughtCount: items.filter((i) => i.status !== "idea" && i.status !== "cancelled").length,
    inTransitCount,
    arrivingThisWeekCount,
    needsReviewCount,
    atRiskCount: items.filter((i) => i.risk).length,
    daysUntilDeadline: daysBetween(today, deadline),
  };

  return {
    me: {
      id: user.id,
      email: user.email,
      name: user.name,
      picture: user.picture,
      gmailConnected: !!user.gmail_refresh_token,
      lastScanAt: user.last_scan_at,
      lastScanError: user.last_scan_error,
      failedEmailCount: input.failedEmailCount,
      scanSince: user.scan_since,
      deadline: user.deadline,
      devMode: input.devMode,
    },
    today,
    stats,
    recipients,
    items,
    orders,
    mutedVendors: input.muted.map((m) => ({ vendorKey: m.vendor_key, vendor: m.vendor })),
  };
}

export async function loadDashboard(db: D1Database, user: UserRow, devMode: boolean, today: string): Promise<Dashboard> {
  const [recipients, items, orders, lines, shipments, muted, failed] = await db.batch([
    db.prepare("SELECT * FROM recipients WHERE user_id = ? ORDER BY created_at").bind(user.id),
    db.prepare("SELECT * FROM items WHERE user_id = ? ORDER BY created_at").bind(user.id),
    db.prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY COALESCE(order_date, '') DESC, created_at DESC").bind(user.id),
    db.prepare("SELECT * FROM order_lines WHERE user_id = ? ORDER BY created_at").bind(user.id),
    db.prepare("SELECT * FROM shipments WHERE user_id = ? ORDER BY created_at").bind(user.id),
    db.prepare("SELECT * FROM muted_vendors WHERE user_id = ? ORDER BY vendor").bind(user.id),
    db.prepare("SELECT COUNT(*) AS n FROM emails WHERE user_id = ? AND kind = 'error'").bind(user.id),
  ]);
  return buildDashboard({
    user,
    recipients: recipients!.results as RecipientRow[],
    items: items!.results as ItemRow[],
    orders: orders!.results as OrderRow[],
    lines: lines!.results as LineRow[],
    shipments: shipments!.results as ShipmentRow[],
    muted: muted!.results as MutedVendorRow[],
    failedEmailCount: (failed!.results[0] as { n: number } | undefined)?.n ?? 0,
    today,
    devMode,
  });
}
