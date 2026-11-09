// Regression tests for issues found in code review: the scanner must never
// stall or silently drop email, and orders must not merge or split wrongly.
import Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import type { UserRow } from "../worker/db";
import { loadDashboard } from "../worker/dashboard";
import { applyExtraction } from "../worker/scan/apply";
import type { Extraction, Extractor } from "../worker/scan/extract";
import { GmailApiError, type MailMessage, type MailSource } from "../worker/scan/gmail";
import { htmlToText } from "../worker/scan/email-text";
import { loadContext, scanBatch } from "../worker/scan/scanner";
import { isoDate } from "../worker/lib/util";
import { createD1, insertUser } from "./d1";

const NOW = Date.now();
const DAY = 86_400_000;

const base: Extraction = {
  kind: "order_confirmation",
  vendor: "Shop",
  order_number: null,
  order_date: null,
  currency: "USD",
  order_total: null,
  estimated_delivery: null,
  ship_to_name: null,
  items: [],
  shipments: [],
};

const product = (description: string, unit_price: number | null = null, pick: string | null = null) => ({
  description,
  quantity: 1,
  unit_price,
  matched_list_item_id: pick,
  match_confidence: pick ? ("high" as const) : null,
});

const mail = (id: string, text: string, daysAgo: number, from = '"Shop" <a@shop.example>'): MailMessage => ({
  id,
  from,
  subject: "Order update",
  date: NOW - daysAgo * DAY,
  text,
});

let db: D1Database;
let user: UserRow;

beforeEach(async () => {
  db = createD1();
  user = await insertUser(db);
});

async function apply(x: Extraction, m: MailMessage) {
  const { ctx } = await loadContext(db, user.id);
  return applyExtraction(db, ctx, m, x);
}

async function addItem(name: string) {
  const id = `itm_${name.replace(/\W/g, "")}`;
  await db
    .prepare("INSERT INTO items (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, 1, 1)")
    .bind(id, user.id, name)
    .run();
  return id;
}

/** Inbox of simple emails; `fail` decides what happens for each id. */
function inbox(ids: string[], fail: (id: string, call: number) => Error | null = () => null) {
  const calls = new Map<string, number>();
  const messages = ids.map((id, i) => mail(id, `Order ${id.toUpperCase()}-1000 for a thing`, ids.length - i));
  const source: MailSource = {
    listMessageIds: async () => [...messages].reverse().map((m) => m.id),
    getMessage: async (id) => messages.find((m) => m.id === id)!,
  };
  const extractor: Extractor = {
    extract: async ({ email }) => {
      const n = (calls.get(email.id) ?? 0) + 1;
      calls.set(email.id, n);
      const err = fail(email.id, n);
      if (err) throw err;
      return { ...base, order_number: `${email.id.toUpperCase()}-1000`, items: [product("A thing", 5)] };
    },
  };
  return { source, extractor, calls };
}

async function emailRows() {
  return (await db.prepare("SELECT gmail_id, kind, attempts FROM emails ORDER BY gmail_id").all<{ gmail_id: string; kind: string; attempts: number }>()).results;
}

describe("scanner never stalls on one email", () => {
  it("skips an email that keeps failing after three tries and reads the rest", async () => {
    const { source, extractor } = inbox(["a", "b", "c"], (id) => (id === "a" ? new Error("boom") : null));
    const rounds = [];
    for (let i = 0; i < 6; i++) {
      const r = await scanBatch(db, user, { mail: source, extractor }, 5);
      rounds.push(r);
      if (r.done && r.errors.length === 0) break;
    }
    expect(rounds.slice(0, 3).every((r) => r.errors.length === 1 && r.processed === 0)).toBe(true);
    const rows = await emailRows();
    expect(rows.find((r) => r.gmail_id === "a")).toMatchObject({ kind: "error", attempts: 3 });
    expect(rows.filter((r) => r.kind === "order_confirmation").map((r) => r.gmail_id)).toEqual(["b", "c"]);
  });

  it("doesn't count rate limits or outages against an email", async () => {
    const rateLimited = Anthropic.APIError.generate(429, { error: { type: "rate_limit_error" } }, "slow down", new Headers());
    const { source, extractor } = inbox(["a"], (_id, call) => (call <= 5 ? rateLimited : null));
    for (let i = 0; i < 5; i++) {
      const r = await scanBatch(db, user, { mail: source, extractor }, 5);
      expect(r.errors[0]).toContain("Couldn't read emails right now");
    }
    expect((await emailRows())[0]).toMatchObject({ kind: "pending", attempts: 0 });
    const r = await scanBatch(db, user, { mail: source, extractor }, 5);
    expect(r.errors).toEqual([]);
    expect((await emailRows())[0]!.kind).toBe("order_confirmation");
  });

  it("refunds Gmail outages but skips messages that can't be opened", async () => {
    let gmailDown = true;
    const source: MailSource = {
      listMessageIds: async () => ["gone", "ok"],
      getMessage: async (id) => {
        if (gmailDown) throw new GmailApiError("Gmail API 503", 503);
        if (id === "gone") throw new GmailApiError("Gmail API 404", 404);
        return mail(id, "Order OK-12345", 1);
      },
    };
    const extractor: Extractor = { extract: async () => ({ ...base, order_number: "OK-12345" }) };
    await scanBatch(db, user, { mail: source, extractor }, 5);
    expect((await emailRows()).map((r) => r.attempts)).toEqual([0]);
    gmailDown = false;
    await scanBatch(db, user, { mail: source, extractor }, 5);
    expect((await emailRows()).map((r) => [r.gmail_id, r.kind])).toEqual([
      ["gone", "error"],
      ["ok", "order_confirmation"],
    ]);
  });

  it("refuses to run two scans at once and only releases its own lock", async () => {
    await db.prepare("UPDATE users SET scan_started_at = ? WHERE id = ?").bind(Date.now(), user.id).run();
    const { source, extractor } = inbox(["a"]);
    const r = await scanBatch(db, user, { mail: source, extractor }, 5);
    expect(r.errors).toEqual(["A scan is already running"]);
    const row = await db.prepare("SELECT scan_started_at FROM users").first<{ scan_started_at: number | null }>();
    expect(row!.scan_started_at).not.toBeNull();
  });
});

describe("orders merge and split correctly", () => {
  it("folds a carrier-only order into the store's order instead of double counting", async () => {
    const tracking = { tracking_number: "1Z999AA10123456784", carrier: "UPS", status: "in_transit" as const, estimated_delivery: null };
    await apply(
      { ...base, kind: "shipping_update", vendor: null, shipments: [tracking] },
      mail("carrier", "UPS: package 1Z999AA10123456784 is on its way", 3, '"UPS" <ups@ups.example>'),
    );
    await apply(
      { ...base, order_number: "W-55501", order_total: 100, items: [product("Wool blanket", 100)] },
      mail("conf", "Order W-55501: Wool blanket $100", 4),
    );
    await apply(
      { ...base, kind: "shipping_update", order_number: "W-55501", items: [product("Wool blanket")], shipments: [tracking] },
      mail("ship", "Order W-55501 shipped with UPS 1Z999AA10123456784: Wool blanket", 2),
    );
    const orders = (await db.prepare("SELECT vendor, order_key FROM orders").all()).results;
    expect(orders).toEqual([{ vendor: "Shop", order_key: "W55501" }]);
    const d = await loadDashboard(db, user, false, isoDate(NOW));
    expect(d.stats.spentCents).toBe(10000);
    expect(d.orders[0]!.shipments).toHaveLength(1);
  });

  it("keeps the same order number at two different stores apart", async () => {
    await apply(
      { ...base, vendor: "Cozy Knits", order_number: "#1042", order_total: 45, items: [product("Hand-knit scarf", 45)] },
      mail("k", "Cozy Knits order #1042: Hand-knit scarf $45", 3),
    );
    await apply(
      { ...base, vendor: "Bean Roasters", order_number: "#1042", order_total: 18, items: [product("Coffee beans", 18)] },
      mail("b", "Bean Roasters order #1042: Coffee beans $18", 2),
    );
    const orders = (await db.prepare("SELECT vendor, total_cents FROM orders ORDER BY vendor").all()).results;
    expect(orders).toEqual([
      { vendor: "Bean Roasters", total_cents: 1800 },
      { vendor: "Cozy Knits", total_cents: 4500 },
    ]);
  });

  it("doesn't move a known package backwards on a vague 'shipped' email", async () => {
    const t = { tracking_number: "1Z999AA10123456784", carrier: "UPS", estimated_delivery: null };
    await apply(
      { ...base, kind: "out_for_delivery", order_number: "R-77777", shipments: [{ ...t, status: "out_for_delivery" }] },
      mail("o", "Order R-77777 out for delivery 1Z999AA10123456784", 2),
    );
    await apply({ ...base, kind: "shipping_update", order_number: "R-77777" }, mail("s", "Part of order R-77777 shipped", 1));
    const s = await db.prepare("SELECT status FROM shipments").first<{ status: string }>();
    expect(s!.status).toBe("out_for_delivery");
  });

  it("leaves a note when a cancellation can't be matched to a product", async () => {
    await apply(
      { ...base, order_number: "C-88888", items: [product("Red mittens", 10), product("Blue hat", 15)] },
      mail("c1", "Order C-88888", 3),
    );
    await apply(
      { ...base, kind: "cancellation", order_number: "C-88888", items: [product("Gift box upgrade")] },
      mail("c2", "Order C-88888 cancelled: Gift box upgrade", 1),
    );
    const order = await db.prepare("SELECT status, note FROM orders").first<{ status: string; note: string }>();
    expect(order!.status).toBe("ordered");
    expect(order!.note).toContain("Gift box upgrade");
  });
});

describe("matching safety", () => {
  it("only auto-links when the model and the names agree", async () => {
    const garden = await addItem("Something for Dad's garden");
    const kite = await addItem("Stunt kite");
    await apply(
      {
        ...base,
        order_number: "M-24680",
        items: [product("Fiskars pruning shears", 30, garden), product("Prism stunt kite, dual line", 60, kite)],
      },
      mail("m", "Order M-24680", 1),
    );
    const lines = (await db.prepare("SELECT description, item_id, match_state FROM order_lines ORDER BY description").all()).results;
    expect(lines).toEqual([
      { description: "Fiskars pruning shears", item_id: garden, match_state: "suggested" },
      { description: "Prism stunt kite, dual line", item_id: kite, match_state: "matched" },
    ]);
  });

  it("survives a gift being deleted while a scan is running", async () => {
    const kite = await addItem("Stunt kite");
    const { ctx } = await loadContext(db, user.id);
    await db.prepare("DELETE FROM items WHERE id = ?").bind(kite).run();
    await applyExtraction(db, ctx, mail("k", "Order K-13579", 1), {
      ...base,
      order_number: "K-13579",
      items: [product("Stunt kite", 60, kite)],
    });
    const line = await db.prepare("SELECT item_id, match_state FROM order_lines").first();
    expect(line).toEqual({ item_id: null, match_state: "unmatched" });
  });
});

describe("email text performance", () => {
  it("handles huge and malformed HTML quickly", () => {
    // Order details first, then 130 KB of unclosed links and 90 KB of filler.
    const html = "<p>Order 12345</p>" + '<a href="https://shop.example/x">'.repeat(4000) + "<p>More deals</p>".repeat(5000);
    const started = performance.now();
    const text = htmlToText(html);
    expect(performance.now() - started).toBeLessThan(200);
    expect(text.startsWith("Order 12345")).toBe(true);
    expect(text).not.toContain("<a");
  });
});
