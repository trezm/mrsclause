// Runs the real scan pipeline (scanner -> applyExtraction -> dashboard) over
// the demo inbox, against the real schema in an in-memory database.
import { beforeEach, describe, expect, it } from "vitest";
import type { UserRow } from "../worker/db";
import { loadDashboard } from "../worker/dashboard";
import { FixtureExtractor, FixtureMail, buildFixtures } from "../worker/dev/fixtures";
import { seedDemoList } from "../worker/dev/seed";
import { applyExtraction } from "../worker/scan/apply";
import type { Extraction } from "../worker/scan/extract";
import { loadContext, scanBatch } from "../worker/scan/scanner";
import { addDays, isoDate, vendorKey } from "../worker/lib/util";
import { createD1, insertUser } from "./d1";

const NOW = Date.now();
const TODAY = isoDate(NOW);
const DEADLINE = addDays(TODAY, 40);

async function scanAll(db: D1Database, user: UserRow) {
  const fixtures = buildFixtures(NOW, DEADLINE);
  const deps = { mail: new FixtureMail(fixtures), extractor: new FixtureExtractor(fixtures) };
  const rounds = [];
  for (let i = 0; i < 10; i++) {
    const result = await scanBatch(db, user, deps, 3);
    rounds.push(result);
    if (result.done) break;
  }
  return rounds;
}

describe("demo inbox end to end", () => {
  let db: D1Database;
  let user: UserRow;

  beforeEach(async () => {
    db = createD1();
    user = await insertUser(db, { deadline: DEADLINE });
    await seedDemoList(db, user.id);
  });

  it("scans in batches and is idempotent", async () => {
    const rounds = await scanAll(db, user);
    expect(rounds.map((r) => r.processed)).toEqual([3, 3, 3, 1]);
    expect(rounds.at(-1)!.remaining).toBe(0);
    expect(rounds.flatMap((r) => r.errors)).toEqual([]);
    const again = await scanAll(db, user);
    expect(again[0]!.processed).toBe(0);
    const emails = await db.prepare("SELECT COUNT(*) AS n FROM emails").first<{ n: number }>();
    expect(emails!.n).toBe(10);
  });

  it("builds the bird's-eye view", async () => {
    await scanAll(db, user);
    const d = await loadDashboard(db, user, true, TODAY);
    const item = (name: string) => d.items.find((i) => i.name === name)!;
    const person = (name: string) => d.recipients.find((r) => r.name === name)!;

    // Ordered -> shipped -> delivered (the delivery email had no order number).
    expect(item("Cast iron skillet").status).toBe("delivered");
    expect(item("Cast iron skillet").spentCents).toBe(4495);
    // Two products, one package, out for delivery today.
    expect(item("Galaxy Shuttle building set").status).toBe("out_for_delivery");
    expect(item("Star projector night light").status).toBe("out_for_delivery");
    expect(item("Galaxy Shuttle building set").purchases[0]!.shipment?.carrier).toBe("UPS");
    // Backordered close to the deadline.
    expect(item("Large-print crossword book").status).toBe("ordered");
    expect(item("Large-print crossword book").risk).toBe("close");
    // Medium-confidence match waits for the user.
    expect(item("Pour-over coffee set").status).toBe("idea");
    expect(item("Cashmere scarf").status).toBe("idea");

    expect(person("Sam").spentCents).toBe(5999 + 2499);
    expect(person("Dad").spentCents).toBe(4495);
    expect(person("Mom").spentCents).toBe(0);

    // Groceries were skipped entirely.
    expect(d.orders.map((o) => o.vendor).sort()).toEqual([
      "Cedar & Pine Outfitters",
      "Gadget Barn",
      "Hearth & Home",
      "Lumen Books",
      "Northwind Toys",
    ]);

    // Needs a look: the unmatched novel (shipping to Grandma Rose), the
    // suggested coffee maker, and the earbuds nobody is down for.
    const review = d.orders.flatMap((o) => o.lines.filter((l) => l.matchState === "unmatched" || l.matchState === "suggested"));
    expect(review.map((l) => l.description).sort()).toEqual([
      "Glass Pour Over Coffee Maker with Reusable Filter, 34 oz",
      "Pulse Wireless Earbuds (Midnight)",
      "The Lighthouse Keeper's Daughter (Paperback)",
    ]);
    const novel = review.find((l) => l.description.startsWith("The Lighthouse"))!;
    expect(novel.suggestedRecipientId).toBe(person("Grandma Rose").id);
    const coffee = review.find((l) => l.description.startsWith("Glass Pour"))!;
    expect(coffee.matchState).toBe("suggested");
    expect(coffee.itemId).toBe(item("Pour-over coffee set").id);

    expect(d.stats.needsReviewCount).toBe(3);
    expect(d.stats.inTransitCount).toBe(2); // UPS + OnTrac; USPS was delivered
    expect(d.stats.arrivingThisWeekCount).toBe(2);
    expect(d.stats.boughtCount).toBe(4);
    expect(d.stats.itemCount).toBe(7);
  });
});

describe("applyExtraction edge cases", () => {
  let db: D1Database;
  let user: UserRow;
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
  const email = (id: string, text: string, daysAgo: number) => ({
    id,
    from: '"Shop" <a@shop.example>',
    subject: "Your order",
    date: NOW - daysAgo * 86_400_000,
    text,
  });
  const lineItem = (description: string, unit_price: number | null = null) => ({
    description,
    quantity: 1,
    unit_price,
    matched_list_item_id: null,
    match_confidence: null,
  });

  beforeEach(async () => {
    db = createD1();
    user = await insertUser(db);
  });

  async function apply(x: Extraction, e: ReturnType<typeof email>) {
    const { ctx } = await loadContext(db, user.id);
    return applyExtraction(db, ctx, e, x);
  }

  it("drops tracking and order numbers that aren't in the email", async () => {
    const result = await apply(
      {
        ...base,
        kind: "shipping_update",
        order_number: "ORD-999999",
        items: [lineItem("Wool socks")],
        shipments: [{ tracking_number: "1Z999AA10123456784", carrier: "UPS", status: "in_transit", estimated_delivery: null }],
      },
      email("e1", "Your wool socks shipped! Order ORD-123456.", 1),
    );
    const order = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(result.orderId).first<{ order_key: string | null }>();
    expect(order!.order_key).toBeNull();
    const shipments = await db.prepare("SELECT COUNT(*) AS n FROM shipments").first<{ n: number }>();
    expect(shipments!.n).toBe(0);
  });

  it("joins a shipping email that arrives before its confirmation", async () => {
    await apply(
      {
        ...base,
        kind: "shipping_update",
        order_number: "A-55555",
        items: [lineItem("Board game: Cascadia")],
        shipments: [{ tracking_number: "774988123456", carrier: "FedEx", status: "in_transit", estimated_delivery: null }],
      },
      email("ship", "Order A-55555 shipped. FedEx 774988123456. Board game: Cascadia", 2),
    );
    await apply(
      {
        ...base,
        order_number: "A-55555",
        order_total: 42.5,
        items: [lineItem("Cascadia Board Game", 39.99), lineItem("Card sleeves", 2.51)],
      },
      email("conf", "Order A-55555 confirmed. Cascadia Board Game $39.99. Card sleeves $2.51", 3),
    );
    const orders = await db.prepare("SELECT * FROM orders").all<{ total_cents: number; has_confirmation: number }>();
    expect(orders.results).toHaveLength(1);
    expect(orders.results[0]!.total_cents).toBe(4250);
    expect(orders.results[0]!.has_confirmation).toBe(1);
    const lines = await db.prepare("SELECT description FROM order_lines ORDER BY description").all<{ description: string }>();
    expect(lines.results.map((l) => l.description)).toEqual(["Board game: Cascadia", "Card sleeves"]);
  });

  it("cancels only the listed product", async () => {
    await apply(
      { ...base, order_number: "C-77777", items: [lineItem("Red mittens", 10), lineItem("Blue hat", 15)] },
      email("c1", "Order C-77777: Red mittens $10, Blue hat $15", 3),
    );
    await apply(
      { ...base, kind: "cancellation", order_number: "C-77777", items: [lineItem("Blue hat")] },
      email("c2", "We cancelled Blue hat from order C-77777", 1),
    );
    const lines = await db.prepare("SELECT description, status FROM order_lines ORDER BY description").all<{ description: string; status: string }>();
    expect(lines.results).toEqual([
      { description: "Blue hat", status: "cancelled" },
      { description: "Red mittens", status: "active" },
    ]);
    const order = await db.prepare("SELECT status FROM orders").first<{ status: string }>();
    expect(order!.status).toBe("ordered");
  });

  it("does not move a delivered package backwards", async () => {
    const ship = { tracking_number: "1Z999AA10123456784", carrier: "UPS", estimated_delivery: null };
    const text = "Order R-12345 tracking 1Z999AA10123456784";
    await apply({ ...base, kind: "delivery_confirmation", order_number: "R-12345", shipments: [{ ...ship, status: "delivered" }] }, email("d", text, 1));
    await apply({ ...base, kind: "shipping_update", order_number: "R-12345", shipments: [{ ...ship, status: "in_transit" }] }, email("s", text, 3));
    const s = await db.prepare("SELECT status FROM shipments").first<{ status: string }>();
    expect(s!.status).toBe("delivered");
  });

  it("hides orders from muted stores", async () => {
    await db.prepare("INSERT INTO muted_vendors (user_id, vendor_key, vendor, created_at) VALUES (?, ?, 'Shop', 0)").bind(user.id, vendorKey("Shop")).run();
    const { orderId } = await apply({ ...base, order_number: "M-10001", items: [lineItem("Paper towels", 9)] }, email("m", "Order M-10001", 1));
    const order = await db.prepare("SELECT ignored FROM orders WHERE id = ?").bind(orderId).first<{ ignored: number }>();
    expect(order!.ignored).toBe(1);
  });
});
