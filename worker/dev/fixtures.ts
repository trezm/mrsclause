// Local-development demo data: a sample gift list and a fake inbox whose
// emails run through the real scan pipeline (applyExtraction, matching,
// dashboard). Stores and tracking numbers are made up.
//
// With a real ANTHROPIC_API_KEY in .dev.vars, the fake inbox is read by
// Claude instead of the canned answers below, which is handy for testing
// the extraction prompt.

import { isoDate, DAY_MS } from "../lib/util";
import { htmlToText } from "../scan/email-text";
import type { Extraction, ExtractInput, Extractor } from "../scan/extract";
import type { MailMessage, MailSource } from "../scan/gmail";

export const DEMO_RECIPIENTS = [
  { name: "Mom", budgetCents: 15000 },
  { name: "Dad", budgetCents: 12000 },
  { name: "Sam", budgetCents: 10000, notes: "Turning 9. Into space and building things." },
  { name: "Grandma Rose", budgetCents: 6000 },
];

export const DEMO_ITEMS: { name: string; recipient: string; targetPriceCents?: number }[] = [
  { name: "Cashmere scarf", recipient: "Mom", targetPriceCents: 6000 },
  { name: "Pour-over coffee set", recipient: "Mom", targetPriceCents: 4000 },
  { name: "Cast iron skillet", recipient: "Dad", targetPriceCents: 5000 },
  { name: "Bird feeder camera", recipient: "Dad", targetPriceCents: 9000 },
  { name: "Galaxy Shuttle building set", recipient: "Sam", targetPriceCents: 6000 },
  { name: "Star projector night light", recipient: "Sam", targetPriceCents: 2500 },
  { name: "Large-print crossword book", recipient: "Grandma Rose", targetPriceCents: 1500 },
];

type FixtureItem = Omit<Extraction["items"][number], "matched_list_item_id"> & { list_name: string | null };

interface Fixture {
  message: MailMessage;
  extraction: Omit<Extraction, "items"> & { items: FixtureItem[] };
}

function item(description: string, unit_price: number | null, list_name: string | null = null, confidence: "high" | "medium" | "low" | null = list_name ? "high" : null, quantity = 1): FixtureItem {
  return { description, quantity, unit_price, list_name, match_confidence: confidence };
}

const none = { currency: null, order_total: null, estimated_delivery: null, ship_to_name: null, order_date: null };

export function buildFixtures(now: number, deadline: string): Fixture[] {
  const at = (days: number) => now + days * DAY_MS;
  const day = (days: number) => isoDate(at(days));
  const closeToDeadline = isoDate(Date.parse(deadline) - 2 * DAY_MS);
  let n = 0;
  const msg = (from: string, subject: string, daysAgo: number, body: string, html = false): MailMessage => ({
    id: `demo-${++n}`,
    from,
    subject,
    date: at(-daysAgo),
    text: html ? htmlToText(body) : body,
  });

  return [
    {
      message: msg(
        '"Cedar & Pine Outfitters" <orders@cedarpine.example>',
        "Order confirmed: CP-220931",
        10,
        `Thanks for your order!\nOrder number: CP-220931\nOrder date: ${day(-10)}\n\nCedar & Pine 12" Pre-Seasoned Cast Iron Skillet  Qty 1  $44.95\nSubtotal $44.95\nShipping FREE\nTax $3.60\nTotal $48.55\n\nShip to: Alex Parker`,
      ),
      extraction: {
        ...none,
        kind: "order_confirmation",
        vendor: "Cedar & Pine Outfitters",
        order_number: "CP-220931",
        order_date: day(-10),
        currency: "USD",
        order_total: 48.55,
        ship_to_name: "Alex Parker",
        items: [item('Cedar & Pine 12" Pre-Seasoned Cast Iron Skillet', 44.95, "Cast iron skillet")],
        shipments: [],
      },
    },
    {
      message: msg(
        '"Cedar & Pine Outfitters" <orders@cedarpine.example>',
        "Your order CP-220931 has shipped",
        8,
        `<html><body><h1>It's on the way!</h1><p>Order CP-220931</p><table><tr><td>12" Pre-Seasoned Cast Iron Skillet</td><td>Qty 1</td></tr></table><p>USPS tracking: <a href="https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223197428490">9400 1118 9922 3197 4284 90</a></p><p>Estimated delivery: ${day(-5)}</p></body></html>`,
        true,
      ),
      extraction: {
        ...none,
        kind: "shipping_update",
        vendor: "Cedar & Pine Outfitters",
        order_number: "CP-220931",
        estimated_delivery: day(-5),
        items: [item('12" Pre-Seasoned Cast Iron Skillet', null)],
        shipments: [{ tracking_number: "9400111899223197428490", carrier: "USPS", status: "in_transit", estimated_delivery: day(-5) }],
      },
    },
    {
      message: msg(
        '"USPS" <auto-reply@usps.example>',
        "Delivered: USPS Item Number 9400111899223197428490",
        5,
        `Your item was delivered in or at the mailbox at 2:14 pm on ${day(-5)}.\nTracking Number: 9400111899223197428490\nShipper: Cedar & Pine Outfitters`,
      ),
      extraction: {
        ...none,
        kind: "delivery_confirmation",
        vendor: "Cedar & Pine Outfitters",
        order_number: null,
        items: [],
        shipments: [{ tracking_number: "9400111899223197428490", carrier: "USPS", status: "delivered", estimated_delivery: null }],
      },
    },
    {
      message: msg(
        '"Northwind Toys" <hello@northwindtoys.example>',
        "Thanks for your order #NW-48213",
        6,
        `Hi Alex, we got your order!\nOrder #NW-48213 placed ${day(-6)}\n\nGalaxy Shuttle Building Set (742 pieces)  1 x $59.99\nStarlight Projector Night Light - Blue  1 x $24.99\n\nSubtotal: $84.98\nTax: $6.29\nOrder total: $91.27`,
      ),
      extraction: {
        ...none,
        kind: "order_confirmation",
        vendor: "Northwind Toys",
        order_number: "NW-48213",
        order_date: day(-6),
        currency: "USD",
        order_total: 91.27,
        items: [
          item("Galaxy Shuttle Building Set (742 pieces)", 59.99, "Galaxy Shuttle building set"),
          item("Starlight Projector Night Light - Blue", 24.99, "Star projector night light"),
        ],
        shipments: [],
      },
    },
    {
      message: msg(
        '"Northwind Toys" <hello@northwindtoys.example>',
        "Your Northwind Toys order is on its way",
        3,
        `Good news! Order #NW-48213 shipped via UPS.\nTracking number: 1Z999AA10123456784\nArriving by ${day(1)}\n\nIn this package:\nGalaxy Shuttle Building Set (742 pieces)\nStarlight Projector Night Light - Blue`,
      ),
      extraction: {
        ...none,
        kind: "shipping_update",
        vendor: "Northwind Toys",
        order_number: "NW-48213",
        estimated_delivery: day(1),
        items: [item("Galaxy Shuttle Building Set (742 pieces)", null), item("Starlight Projector Night Light - Blue", null)],
        shipments: [{ tracking_number: "1Z999AA10123456784", carrier: "UPS", status: "in_transit", estimated_delivery: day(1) }],
      },
    },
    {
      message: msg(
        '"Lumen Books" <receipts@lumenbooks.example>',
        "Lumen Books receipt for order 5531-0087",
        4,
        `Order 5531-0087\nShipping to: Rose Miller, 18 Orchard Lane\n\nThe Big Book of Large-Print Crosswords, Vol. 3   $14.99\nThe Lighthouse Keeper's Daughter (Paperback)   $17.00\n\nTotal $34.08 (incl. tax)\nBackordered: expected to ship soon. Estimated delivery ${closeToDeadline}.`,
      ),
      extraction: {
        ...none,
        kind: "order_confirmation",
        vendor: "Lumen Books",
        order_number: "5531-0087",
        order_date: day(-4),
        currency: "USD",
        order_total: 34.08,
        estimated_delivery: closeToDeadline,
        ship_to_name: "Rose Miller",
        items: [
          item("The Big Book of Large-Print Crosswords, Vol. 3", 14.99, "Large-print crossword book"),
          item("The Lighthouse Keeper's Daughter (Paperback)", 17.0),
        ],
        shipments: [],
      },
    },
    {
      message: msg(
        '"Hearth & Home" <noreply@hearthandhome.example>',
        "Order HH-77120 confirmed",
        2,
        `Your order HH-77120 is confirmed.\nGlass Pour Over Coffee Maker with Reusable Filter, 34 oz   $38.00\nTotal: $41.04`,
      ),
      extraction: {
        ...none,
        kind: "order_confirmation",
        vendor: "Hearth & Home",
        order_number: "HH-77120",
        order_date: day(-2),
        currency: "USD",
        order_total: 41.04,
        items: [item("Glass Pour Over Coffee Maker with Reusable Filter, 34 oz", 38.0, "Pour-over coffee set", "medium")],
        shipments: [],
      },
    },
    {
      message: msg(
        '"Gadget Barn" <orders@gadgetbarn.example>',
        "Shipped: Gadget Barn order GB1009934",
        1,
        `Order GB1009934 has shipped with OnTrac.\nTracking: D10011234567890\nEstimated arrival: ${day(3)}\n\nPulse Wireless Earbuds (Midnight)  $79.99\nOrder total: $86.39`,
      ),
      extraction: {
        ...none,
        kind: "shipping_update",
        vendor: "Gadget Barn",
        order_number: "GB1009934",
        order_date: day(-2),
        currency: "USD",
        order_total: 86.39,
        estimated_delivery: day(3),
        items: [item("Pulse Wireless Earbuds (Midnight)", 79.99)],
        shipments: [{ tracking_number: "D10011234567890", carrier: "OnTrac", status: "in_transit", estimated_delivery: day(3) }],
      },
    },
    {
      message: msg(
        '"Fresh Pantry" <orders@freshpantry.example>',
        "Your grocery order is confirmed",
        1,
        "Your Fresh Pantry delivery of 14 items arrives tomorrow between 4-6pm. Order total $63.18.",
      ),
      extraction: { ...none, kind: "not_order_related", vendor: null, order_number: null, items: [], shipments: [] },
    },
    {
      message: msg(
        '"Northwind Toys" <hello@northwindtoys.example>',
        "Out for delivery: order #NW-48213",
        0,
        "Your package is out for delivery today with UPS. Tracking 1Z999AA10123456784.",
      ),
      extraction: {
        ...none,
        kind: "out_for_delivery",
        vendor: "Northwind Toys",
        order_number: "NW-48213",
        estimated_delivery: day(0),
        items: [],
        shipments: [{ tracking_number: "1Z999AA10123456784", carrier: "UPS", status: "out_for_delivery", estimated_delivery: day(0) }],
      },
    },
  ];
}

export class FixtureMail implements MailSource {
  constructor(private fixtures: Fixture[]) {}

  async listMessageIds(): Promise<string[]> {
    return [...this.fixtures].sort((a, b) => b.message.date - a.message.date).map((f) => f.message.id);
  }

  async getMessage(id: string): Promise<MailMessage> {
    const f = this.fixtures.find((x) => x.message.id === id);
    if (!f) throw new Error(`No fixture ${id}`);
    return f.message;
  }
}

/** Returns the canned answer for each demo email, resolving list names to ids. */
export class FixtureExtractor implements Extractor {
  constructor(private fixtures: Fixture[]) {}

  async extract({ email, listItems }: ExtractInput): Promise<Extraction> {
    const f = this.fixtures.find((x) => x.message.id === email.id);
    if (!f) throw new Error(`No fixture ${email.id}`);
    return {
      ...f.extraction,
      items: f.extraction.items.map(({ list_name, ...rest }) => {
        const match = list_name ? listItems.find((i) => i.name === list_name) : undefined;
        return { ...rest, matched_list_item_id: match?.id ?? null, match_confidence: match ? rest.match_confidence : null };
      }),
    };
  }
}
