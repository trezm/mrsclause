import { newId } from "../lib/util";
import { DEMO_ITEMS, DEMO_RECIPIENTS } from "./fixtures";

/** Fills an empty account with the demo gift list. */
export async function seedDemoList(db: D1Database, userId: string): Promise<void> {
  const existing = await db.prepare("SELECT COUNT(*) AS n FROM recipients WHERE user_id = ?").bind(userId).first<{ n: number }>();
  if (existing && existing.n > 0) return;
  const now = Date.now();
  const ids = new Map<string, string>();
  const statements: D1PreparedStatement[] = [];
  DEMO_RECIPIENTS.forEach((r, i) => {
    const id = newId("rcp");
    ids.set(r.name, id);
    statements.push(
      db
        .prepare("INSERT INTO recipients (id, user_id, name, budget_cents, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(id, userId, r.name, r.budgetCents, r.notes ?? null, now + i),
    );
  });
  DEMO_ITEMS.forEach((item, i) => {
    statements.push(
      db
        .prepare(
          `INSERT INTO items (id, user_id, recipient_id, name, target_price_cents, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(newId("itm"), userId, ids.get(item.recipient) ?? null, item.name, item.targetPriceCents ?? null, now + i, now + i),
    );
  });
  await db.batch(statements);
}

/** Removes everything the demo scan created so it can run again. */
export async function resetDemoInbox(db: D1Database, userId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM emails WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM order_lines WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM shipments WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM orders WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM muted_vendors WHERE user_id = ?").bind(userId),
    db.prepare("UPDATE items SET manual_status = NULL, manual_price_cents = NULL WHERE user_id = ?").bind(userId),
  ]);
}
