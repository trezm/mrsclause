// JSON API for the dashboard. Every query is scoped to the signed-in user.

import { Hono, type Context } from "hono";
import { z } from "zod";
import { disconnectGmail, requireUser, sameOrigin, type AppEnv } from "./auth";
import type { ItemRow, LineRow, OrderRow, RecipientRow } from "./db";
import { loadDashboard } from "./dashboard";
import { resetDemoInbox } from "./dev/seed";
import { isIsoDate, newId, orderKey, vendorKey } from "./lib/util";
import { runScan, isDevUser } from "./scan/run";
import { detectCarrier, looksLikeTrackingNumber, normalizeTrackingNumber, trackingUrl } from "./scan/tracking";

export const api = new Hono<AppEnv>();
api.use("*", sameOrigin, requireUser);

class HttpError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

api.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: "Something went wrong" }, 500);
});

async function body<T extends z.ZodType>(c: Context<AppEnv>, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    raw = {};
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return parsed.data;
}

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) => text(max).nullable().optional().transform((v) => (v ? v : null));
const cents = z.number().int().min(0).max(100_000_000).nullable().optional();
const date = z.string().refine(isIsoDate, "must be YYYY-MM-DD");

async function owned<T>(c: Context<AppEnv>, table: string, id: string): Promise<T> {
  const row = await c.env.DB.prepare(`SELECT * FROM ${table} WHERE id = ? AND user_id = ?`)
    .bind(id, c.get("user").id)
    .first<T>();
  if (!row) throw new HttpError(404, "Not found");
  return row;
}

async function ensureRecipient(c: Context<AppEnv>, id: string | null | undefined): Promise<void> {
  if (id) await owned<RecipientRow>(c, "recipients", id);
}

/** Builds a dynamic UPDATE from the fields that were actually sent. */
function updateStatement(db: D1Database, table: string, id: string, userId: string, fields: Record<string, unknown>) {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return null;
  const sets = entries.map(([k]) => `${k} = ?`).join(", ");
  return db.prepare(`UPDATE ${table} SET ${sets} WHERE id = ? AND user_id = ?`).bind(...entries.map(([, v]) => v), id, userId);
}

const ok = (c: Context<AppEnv>) => c.json({ ok: true });

// ---- Dashboard -----------------------------------------------------------

api.get("/dashboard", async (c) => {
  const user = c.get("user");
  // Use the browser's calendar day so "arriving today" matches the viewer.
  const asked = c.req.query("today");
  const today =
    asked && isIsoDate(asked) && Math.abs(Date.parse(asked) - Date.now()) < 2 * 86_400_000
      ? asked
      : new Date().toISOString().slice(0, 10);
  return c.json(await loadDashboard(c.env.DB, user, isDevUser(c.env, user), today));
});

// ---- People --------------------------------------------------------------

const RecipientInput = z.object({
  name: text(80).min(1).optional(),
  budgetCents: cents,
  notes: optionalText(500),
});

api.post("/recipients", async (c) => {
  const input = await body(c, RecipientInput.required({ name: true }));
  const id = newId("rcp");
  await c.env.DB.prepare("INSERT INTO recipients (id, user_id, name, budget_cents, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, c.get("user").id, input.name, input.budgetCents ?? null, input.notes ?? null, Date.now())
    .run();
  return c.json({ id });
});

api.patch("/recipients/:id", async (c) => {
  await owned<RecipientRow>(c, "recipients", c.req.param("id"));
  const input = await body(c, RecipientInput);
  const stmt = updateStatement(c.env.DB, "recipients", c.req.param("id"), c.get("user").id, {
    name: input.name,
    budget_cents: input.budgetCents,
    notes: input.notes,
  });
  if (stmt) await stmt.run();
  return ok(c);
});

api.delete("/recipients/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM recipients WHERE id = ? AND user_id = ?").bind(c.req.param("id"), c.get("user").id).run();
  return ok(c);
});

// ---- Gift list -----------------------------------------------------------

const ItemInput = z.object({
  name: text(200).min(1).optional(),
  recipientId: z.string().nullable().optional(),
  notes: optionalText(1000),
  url: z
    .string()
    .trim()
    .max(1000)
    .refine((v) => v === "" || /^https?:\/\/[^\s]+$/i.test(v), "must be an http(s) link")
    .transform((v) => v || null)
    .nullable()
    .optional(),
  targetPriceCents: cents,
  manualStatus: z.enum(["in_hand", "wrapped"]).nullable().optional(),
  manualPriceCents: cents,
});

api.post("/items", async (c) => {
  const input = await body(c, ItemInput.required({ name: true }));
  await ensureRecipient(c, input.recipientId);
  const id = newId("itm");
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO items (id, user_id, recipient_id, name, notes, url, target_price_cents, manual_status, manual_price_cents,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id, c.get("user").id, input.recipientId ?? null, input.name, input.notes ?? null, input.url ?? null,
      input.targetPriceCents ?? null, input.manualStatus ?? null, input.manualPriceCents ?? null, now, now,
    )
    .run();
  return c.json({ id });
});

api.patch("/items/:id", async (c) => {
  await owned<ItemRow>(c, "items", c.req.param("id"));
  const input = await body(c, ItemInput);
  await ensureRecipient(c, input.recipientId);
  const stmt = updateStatement(c.env.DB, "items", c.req.param("id"), c.get("user").id, {
    name: input.name,
    recipient_id: input.recipientId,
    notes: input.notes,
    url: input.url,
    target_price_cents: input.targetPriceCents,
    manual_status: input.manualStatus,
    manual_price_cents: input.manualPriceCents,
    updated_at: Date.now(),
  });
  if (stmt) await stmt.run();
  return ok(c);
});

api.delete("/items/:id", async (c) => {
  const userId = c.get("user").id;
  const id = c.req.param("id");
  await c.env.DB.batch([
    // Purchases linked to a deleted gift go back to the review queue.
    c.env.DB.prepare(
      "UPDATE order_lines SET item_id = NULL, match_state = 'unmatched', match_source = NULL WHERE item_id = ? AND user_id = ?",
    ).bind(id, userId),
    c.env.DB.prepare("DELETE FROM items WHERE id = ? AND user_id = ?").bind(id, userId),
  ]);
  return ok(c);
});

/** Records a purchase by hand (bought somewhere whose email we can't read). */
api.post("/items/:id/purchase", async (c) => {
  const item = await owned<ItemRow>(c, "items", c.req.param("id"));
  const input = await body(
    c,
    z.object({
      vendor: text(80).min(1),
      orderNumber: optionalText(64),
      priceCents: cents,
      orderDate: date.nullable().optional(),
      trackingNumber: optionalText(40),
      carrier: optionalText(40),
      estimatedDelivery: date.nullable().optional(),
    }),
  );
  const db = c.env.DB;
  const userId = c.get("user").id;
  const now = Date.now();
  const key = orderKey(input.orderNumber);
  if (key) {
    const clash = await db
      .prepare("SELECT id FROM orders WHERE user_id = ? AND order_key = ? AND vendor_key = ?")
      .bind(userId, key, vendorKey(input.vendor))
      .first();
    if (clash) throw new HttpError(409, "That order is already being tracked. Link the gift from the Orders tab instead.");
  }
  const tracking = input.trackingNumber ? normalizeTrackingNumber(input.trackingNumber) : null;
  if (tracking && !looksLikeTrackingNumber(tracking)) throw new HttpError(400, "That doesn't look like a tracking number");
  if (tracking) {
    const clash = await db.prepare("SELECT id FROM shipments WHERE user_id = ? AND tracking_number = ?").bind(userId, tracking).first();
    if (clash) throw new HttpError(409, "That tracking number is already being tracked.");
  }

  const orderId = newId("ord");
  const shipmentId = tracking ? newId("shp") : null;
  const statements = [
    db
      .prepare(
        `INSERT INTO orders (id, user_id, vendor, vendor_key, order_number, order_key, order_date, total_cents, status,
           estimated_delivery, has_confirmation, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'manual', ?, ?)`,
      )
      .bind(
        orderId, userId, input.vendor, vendorKey(input.vendor), input.orderNumber ?? null, key,
        input.orderDate ?? new Date(now).toISOString().slice(0, 10), input.priceCents ?? null,
        tracking ? "shipped" : "ordered", input.estimatedDelivery ?? null, now, now,
      ),
  ];
  if (tracking && shipmentId) {
    const carrier = detectCarrier(tracking, input.carrier) ?? input.carrier ?? null;
    statements.push(
      db
        .prepare(
          `INSERT INTO shipments (id, user_id, order_id, carrier, tracking_number, tracking_url, status, estimated_delivery,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'in_transit', ?, ?, ?)`,
        )
        .bind(shipmentId, userId, orderId, carrier, tracking, trackingUrl(carrier, tracking), input.estimatedDelivery ?? null, now, now),
    );
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO order_lines (id, user_id, order_id, description, quantity, unit_price_cents, shipment_id, item_id,
           match_state, match_source, created_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'matched', 'user', ?)`,
      )
      .bind(newId("lin"), userId, orderId, item.name, input.priceCents ?? null, shipmentId, item.id, now),
  );
  await db.batch(statements);
  return c.json({ orderId });
});

// ---- Review queue: linking purchases to gifts ----------------------------

async function setLine(c: Context<AppEnv>, fields: Partial<Pick<LineRow, "item_id" | "match_state" | "match_source">>) {
  await owned<LineRow>(c, "order_lines", c.req.param("id")!);
  const stmt = updateStatement(c.env.DB, "order_lines", c.req.param("id")!, c.get("user").id, fields);
  if (stmt) await stmt.run();
  return ok(c);
}

api.post("/lines/:id/link", async (c) => {
  const { itemId } = await body(c, z.object({ itemId: z.string() }));
  await owned<ItemRow>(c, "items", itemId);
  return setLine(c, { item_id: itemId, match_state: "matched", match_source: "user" });
});

/** Turns a purchase into a new gift on the list. */
api.post("/lines/:id/new-item", async (c) => {
  const line = await owned<LineRow>(c, "order_lines", c.req.param("id"));
  const input = await body(c, z.object({ name: text(200).min(1).optional(), recipientId: z.string().nullable().optional() }));
  await ensureRecipient(c, input.recipientId);
  const id = newId("itm");
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO items (id, user_id, recipient_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, c.get("user").id, input.recipientId ?? null, input.name ?? line.description.slice(0, 200), now, now),
    c.env.DB.prepare(
      "UPDATE order_lines SET item_id = ?, match_state = 'matched', match_source = 'user' WHERE id = ? AND user_id = ?",
    ).bind(id, line.id, c.get("user").id),
  ]);
  return c.json({ id });
});

/** "Not this one": reject a suggested match. */
api.post("/lines/:id/unlink", (c) => setLine(c, { item_id: null, match_state: "unmatched", match_source: null }));
/** "Not a gift": hide this purchase from the review queue and totals. */
api.post("/lines/:id/ignore", (c) => setLine(c, { item_id: null, match_state: "ignored", match_source: "user" }));

// ---- Orders and shipments ------------------------------------------------

api.patch("/orders/:id", async (c) => {
  await owned<OrderRow>(c, "orders", c.req.param("id"));
  const input = await body(
    c,
    z.object({
      ignored: z.boolean().optional(),
      vendor: text(80).min(1).optional(),
      estimatedDelivery: date.nullable().optional(),
      status: z.enum(["ordered", "shipped", "out_for_delivery", "delivered", "cancelled", "returned"]).optional(),
      note: z.null().optional(),
    }),
  );
  const stmt = updateStatement(c.env.DB, "orders", c.req.param("id"), c.get("user").id, {
    note: input.note,
    ignored: input.ignored === undefined ? undefined : input.ignored ? 1 : 0,
    vendor: input.vendor,
    vendor_key: input.vendor ? vendorKey(input.vendor) : undefined,
    estimated_delivery: input.estimatedDelivery,
    status: input.status,
    updated_at: Date.now(),
  });
  if (stmt) await stmt.run();
  return ok(c);
});

/** Links an order that has no product details (just a total) to a gift. */
api.post("/orders/:id/link", async (c) => {
  const order = await owned<OrderRow>(c, "orders", c.req.param("id"));
  const { itemId } = await body(c, z.object({ itemId: z.string() }));
  await owned<ItemRow>(c, "items", itemId);
  const userId = c.get("user").id;
  const lines = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM order_lines WHERE order_id = ?").bind(order.id).first<{ n: number }>();
  if (lines && lines.n > 0) throw new HttpError(409, "This order already lists its products; link one of those instead.");
  await c.env.DB.prepare(
    `INSERT INTO order_lines (id, user_id, order_id, description, quantity, unit_price_cents, item_id, match_state,
       match_source, created_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, 'matched', 'user', ?)`,
  )
    .bind(newId("lin"), userId, order.id, `${order.vendor} order${order.order_number ? ` ${order.order_number}` : ""}`, order.total_cents, itemId, Date.now())
    .run();
  return ok(c);
});

api.delete("/orders/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM orders WHERE id = ? AND user_id = ?").bind(c.req.param("id"), c.get("user").id).run();
  return ok(c);
});

api.patch("/shipments/:id", async (c) => {
  await owned(c, "shipments", c.req.param("id"));
  const input = await body(
    c,
    z.object({
      status: z.enum(["in_transit", "out_for_delivery", "delivered", "exception"]).optional(),
      estimatedDelivery: date.nullable().optional(),
    }),
  );
  const stmt = updateStatement(c.env.DB, "shipments", c.req.param("id"), c.get("user").id, {
    status: input.status,
    estimated_delivery: input.estimatedDelivery,
    delivered_at: input.status === "delivered" ? new Date().toISOString().slice(0, 10) : input.status ? null : undefined,
    // A manual change wins over older emails.
    last_event_at: input.status ? Date.now() : undefined,
    updated_at: Date.now(),
  });
  if (stmt) await stmt.run();
  return ok(c);
});

// ---- Muted stores --------------------------------------------------------

api.post("/muted-vendors", async (c) => {
  const { vendor } = await body(c, z.object({ vendor: text(80).min(1) }));
  const userId = c.get("user").id;
  const key = vendorKey(vendor);
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO muted_vendors (user_id, vendor_key, vendor, created_at) VALUES (?, ?, ?, ?)",
    ).bind(userId, key, vendor, Date.now()),
    c.env.DB.prepare("UPDATE orders SET ignored = 1 WHERE user_id = ? AND vendor_key = ?").bind(userId, key),
  ]);
  return ok(c);
});

api.delete("/muted-vendors/:key", async (c) => {
  const userId = c.get("user").id;
  const key = c.req.param("key");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM muted_vendors WHERE user_id = ? AND vendor_key = ?").bind(userId, key),
    c.env.DB.prepare("UPDATE orders SET ignored = 0 WHERE user_id = ? AND vendor_key = ?").bind(userId, key),
  ]);
  return ok(c);
});

// ---- Settings, scanning, Gmail -------------------------------------------

api.patch("/settings", async (c) => {
  const input = await body(c, z.object({ scanSince: date.optional(), deadline: date.optional() }));
  await c.env.DB.prepare("UPDATE users SET scan_since = COALESCE(?, scan_since), deadline = COALESCE(?, deadline) WHERE id = ?")
    .bind(input.scanSince ?? null, input.deadline ?? null, c.get("user").id)
    .run();
  return ok(c);
});

api.post("/scan", async (c) => c.json(await runScan(c.env, c.get("user"))));

/** Lets emails that failed to read be tried again on the next scan. */
api.post("/scan/retry-failed", async (c) => {
  await c.env.DB.prepare("DELETE FROM emails WHERE user_id = ? AND kind = 'error'").bind(c.get("user").id).run();
  return ok(c);
});

api.post("/gmail/disconnect", async (c) => {
  await disconnectGmail(c.env, c.get("user"));
  return ok(c);
});

/** Demo account only: clear scanned orders so the demo inbox can be scanned again. */
api.post("/dev/reset", async (c) => {
  const user = c.get("user");
  if (!isDevUser(c.env, user)) return c.notFound();
  await resetDemoInbox(c.env.DB, user.id);
  return ok(c);
});
