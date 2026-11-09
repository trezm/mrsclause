import { describe, expect, it } from "vitest";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { collectBodies, htmlToText, messageText } from "../worker/scan/email-text";
import { buildSearchQuery } from "../worker/scan/gmail";
import { ExtractionSchema, buildUserPrompt } from "../worker/scan/extract";
import { bestMatch, matchRecipientName, matchScore, sameProductScore } from "../worker/scan/matching";
import { appearsIn, detectCarrier, normalizeTrackingNumber, trackingUrl } from "../worker/scan/tracking";
import { defaultDeadline, orderKey, squash, vendorKey } from "../worker/lib/util";
import { senderName } from "../worker/scan/apply";
import { decryptString, encryptString } from "../worker/lib/crypto";

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

describe("email text", () => {
  it("turns HTML into readable lines and keeps tracking links", () => {
    const html = `<html><head><style>.x{color:red}</style></head><body>
      <p>Hi&nbsp;there &amp; thanks!</p><table><tr><td>Item</td><td>$12.99</td></tr></table>
      <a href="https://www.ups.com/track?tracknum=1Z999AA10123456784">Track package</a>
      <a href="https://shop.example/unsubscribe">Unsubscribe</a><script>alert(1)</script></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain("Hi there & thanks!");
    expect(text).toContain("Item | $12.99");
    expect(text).toContain("Track package [https://www.ups.com/track?tracknum=1Z999AA10123456784]");
    expect(text).toContain("Unsubscribe");
    expect(text).not.toContain("https://shop.example/unsubscribe");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color:red");
  });

  it("strips invisible preheader padding", () => {
    expect(htmlToText("<p>Order‌‌͏ shipped</p>")).toBe("Order shipped");
  });

  it("walks multipart payloads and prefers HTML", () => {
    const payload = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: b64url("Plain version of the order email") } },
        { mimeType: "text/html", body: { data: b64url("<p>HTML version with <b>Order #123</b></p>") } },
        { mimeType: "application/pdf", filename: "invoice.pdf", body: { attachmentId: "x" } },
      ],
    };
    expect(collectBodies(payload).plain).toBe("Plain version of the order email");
    expect(messageText(payload)).toBe("HTML version with Order #123");
  });

  it("builds a Gmail query bounded by date", () => {
    const q = buildSearchQuery("2026-10-01");
    expect(q.startsWith("after:2026/10/01 {")).toBe(true);
    expect(q).toContain("subject:shipped");
    expect(q).toContain("category:purchases");
    expect(q).toContain("-category:promotions");
  });
});

describe("tracking numbers", () => {
  it("detects carriers from number formats and hints", () => {
    expect(detectCarrier("1Z999AA10123456784")).toBe("UPS");
    expect(detectCarrier("9400111899223197428490")).toBe("USPS");
    expect(detectCarrier("TBA123456789012")).toBe("Amazon");
    expect(detectCarrier("774988123456")).toBe("FedEx");
    expect(detectCarrier("D10011234567890")).toBe("OnTrac");
    expect(detectCarrier("123456789012", "FedEx Ground")).toBe("FedEx");
    expect(detectCarrier("ABC")).toBeNull();
  });

  it("normalizes and links", () => {
    expect(normalizeTrackingNumber("9400 1118-9922 3197 4284 90")).toBe("9400111899223197428490");
    expect(trackingUrl("UPS", "1Z999AA10123456784")).toBe("https://www.ups.com/track?tracknum=1Z999AA10123456784");
    expect(trackingUrl(null, "XYZ123")).toContain("parcelsapp.com");
  });

  it("only trusts numbers that appear in the email", () => {
    const text = squash("Your tracking number is 9400 1118 9922 3197 4284 90.");
    expect(appearsIn("9400111899223197428490", text)).toBe(true);
    expect(appearsIn("1Z999AA10123456784", text)).toBe(false);
  });
});

describe("matching", () => {
  it("scores list names against long product titles", () => {
    expect(matchScore("Galaxy Shuttle building set", "Galaxy Shuttle Building Set (742 pieces)")).toBe(1);
    expect(matchScore("Cast iron skillet", 'Cedar & Pine 12" Pre-Seasoned Cast Iron Skillet')).toBe(1);
    expect(matchScore("Cashmere scarf", "Pulse Wireless Earbuds")).toBe(0);
  });

  it("picks the best candidate above the threshold", () => {
    const items = [{ name: "Cashmere scarf" }, { name: "Star projector night light" }];
    expect(bestMatch("Starlight Projector Night Light - Blue", items)?.candidate.name).toBe("Star projector night light");
    expect(bestMatch("Wireless earbuds", items)).toBeNull();
  });

  it("treats shortened titles as the same product but not sibling products", () => {
    const full = "LEGO Star Wars Ultimate Collector Series Millennium Falcon 75192 Building Set";
    expect(sameProductScore("LEGO Star Wars Millennium Falcon 75192 Building...", full)).toBeGreaterThanOrEqual(0.85);
    expect(sameProductScore("LEGO Star Wars X-Wing Starfighter 75355", full)).toBe(0);
    expect(sameProductScore("LEGO Star Wars X-Wing", "LEGO Star Wars Millennium Falcon")).toBeLessThan(0.85);
  });

  it("matches ship-to names to people", () => {
    const people = [{ name: "Mom" }, { name: "Grandma Rose" }];
    expect(matchRecipientName("Rose Miller", people)?.name).toBe("Grandma Rose");
    expect(matchRecipientName("Alex Parker", people)).toBeNull();
    expect(matchRecipientName(null, people)).toBeNull();
  });
});

describe("utilities", () => {
  it("normalizes vendors and order numbers", () => {
    expect(vendorKey("Amazon.com, Inc.")).toBe("amazon");
    expect(vendorKey("Cedar & Pine Outfitters")).toBe("cedarpineoutfitters");
    expect(vendorKey("Shop")).toBe("shop");
    expect(vendorKey("The Container Store")).toBe("thecontainer");
    expect(orderKey("#112-4455 77")).toBe("112445577");
    expect(orderKey("12")).toBeNull();
  });

  it("finds the next Christmas", () => {
    expect(defaultDeadline("2026-11-08")).toBe("2026-12-25");
    expect(defaultDeadline("2026-12-26")).toBe("2027-12-25");
  });

  it("reads store names from senders, but not carriers", () => {
    expect(senderName('"Northwind Toys" <hello@northwind.example>')).toBe("Northwind Toys");
    expect(senderName('"UPS" <mcinfo@ups.example>')).toBeNull();
    expect(senderName("orders@shop.example")).toBeNull();
  });

  it("round-trips encrypted tokens", async () => {
    const secret = "a-very-long-test-secret-value-123";
    const sealed = await encryptString(secret, "1//refresh-token");
    expect(sealed).not.toContain("refresh");
    expect(await decryptString(secret, sealed)).toBe("1//refresh-token");
    await expect(decryptString("another-long-secret-value-456", sealed)).rejects.toThrow();
  });
});

describe("extraction prompt", () => {
  it("produces a JSON schema the structured-output helper accepts", () => {
    const format = zodOutputFormat(ExtractionSchema);
    expect(format.type).toBe("json_schema");
    const schema = JSON.stringify(format.schema);
    expect(schema).toContain("order_confirmation");
    expect(schema).toContain("matched_list_item_id");
  });

  it("includes the gift list and email, and truncates huge bodies", () => {
    const prompt = buildUserPrompt({
      email: { id: "m1", from: "Shop <a@b.c>", subject: "Order 123", date: Date.parse("2026-11-08T12:00:00Z"), text: "x".repeat(50_000) },
      listItems: [{ id: "itm_1", name: 'Scarf "red"', recipient: "Mom" }],
    });
    expect(prompt).toContain('id=itm_1 | "Scarf \\"red\\"" | for Mom');
    expect(prompt).toContain("Sent: 2026-11-08 (Sunday)");
    expect(prompt).toContain("[email truncated]");
    expect(prompt.length).toBeLessThan(41_000);
  });
});
