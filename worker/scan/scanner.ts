// Runs one bounded batch of the inbox scan for a user.
//
// Each call reads at most `batchSize` new emails (oldest first, so a
// confirmation is seen before its "shipped" email) and reports how many are
// left. The dashboard calls it in a loop for the first backfill; the cron
// trigger calls it every 30 minutes to pick up new mail.

import type { ScanResult } from "../../shared/types";
import { allRows, type UserRow } from "../db";
import { applyExtraction, type ApplyContext } from "./apply";
import { PermanentExtractionError, isServiceError, type Extractor, type ListItemForPrompt } from "./extract";
import { GmailApiError, buildSearchQuery, type MailMessage, type MailSource } from "./gmail";

export interface ScanDeps {
  mail: MailSource;
  extractor: Extractor;
}

const MAX_IDS = 2000;
/** Renewed after every email; one email can take up to ~3 minutes with retries. */
const LOCK_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;

export async function loadContext(
  db: D1Database,
  userId: string,
): Promise<{ ctx: ApplyContext; listForPrompt: ListItemForPrompt[] }> {
  const [items, recipients, muted] = await db.batch([
    db
      .prepare(
        `SELECT i.id, i.name, i.recipient_id,
           EXISTS (SELECT 1 FROM order_lines l WHERE l.item_id = i.id AND l.match_state = 'matched') AS matched
         FROM items i WHERE i.user_id = ? ORDER BY matched, i.created_at`,
      )
      .bind(userId),
    db.prepare("SELECT id, name FROM recipients WHERE user_id = ?").bind(userId),
    db.prepare("SELECT vendor_key FROM muted_vendors WHERE user_id = ?").bind(userId),
  ]);
  const itemRows = (items!.results as { id: string; name: string; recipient_id: string | null; matched: number }[]);
  const recipientRows = recipients!.results as { id: string; name: string }[];
  const names = new Map(recipientRows.map((r) => [r.id, r.name]));
  return {
    ctx: {
      userId,
      items: itemRows.map((i) => ({ id: i.id, name: i.name, recipientId: i.recipient_id, matched: i.matched === 1 })),
      recipients: recipientRows,
      mutedVendorKeys: new Set((muted!.results as { vendor_key: string }[]).map((m) => m.vendor_key)),
    },
    listForPrompt: itemRows.map((i) => ({
      id: i.id,
      name: i.name,
      recipient: i.recipient_id ? (names.get(i.recipient_id) ?? null) : null,
    })),
  };
}

/** Marks an email as being read and counts the attempt, before any work happens. */
function startAttempt(db: D1Database, userId: string, gmailId: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO emails (id, user_id, gmail_id, kind, attempts, processed_at) VALUES (?, ?, ?, 'pending', 1, ?)
       ON CONFLICT (user_id, gmail_id) DO UPDATE SET attempts = attempts + 1`,
    )
    .bind(crypto.randomUUID(), userId, gmailId, Date.now());
}

/** Takes back an attempt that failed for reasons unrelated to the email. */
function refundAttempt(db: D1Database, userId: string, gmailId: string): D1PreparedStatement {
  return db
    .prepare("UPDATE emails SET attempts = MAX(attempts - 1, 0) WHERE user_id = ? AND gmail_id = ? AND kind = 'pending'")
    .bind(userId, gmailId);
}

/** Records the final outcome for an email. */
function finishEmail(
  db: D1Database,
  userId: string,
  gmailId: string,
  message: Pick<MailMessage, "from" | "subject" | "date"> | null,
  kind: string,
  orderId: string | null,
  error: string | null,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE emails SET from_addr = ?, subject = ?, received_at = ?, kind = ?, order_id = ?, error = ?, processed_at = ?
       WHERE user_id = ? AND gmail_id = ?`,
    )
    .bind(
      message?.from.slice(0, 200) ?? null, message?.subject.slice(0, 300) ?? null, message?.date ?? null, kind, orderId,
      error?.slice(0, 500) ?? null, Date.now(), userId, gmailId,
    );
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}


export async function scanBatch(
  db: D1Database,
  user: UserRow,
  deps: ScanDeps,
  batchSize: number,
): Promise<ScanResult> {
  // Take the lock. last_scan_at is set now too, so a run that gets killed
  // still rotates to the next user in the cron queue.
  let lockStamp = Date.now();
  const lock = await db
    .prepare(
      `UPDATE users SET scan_started_at = ?, last_scan_at = ?
       WHERE id = ? AND (scan_started_at IS NULL OR scan_started_at < ?)`,
    )
    .bind(lockStamp, lockStamp, user.id, lockStamp - LOCK_MS)
    .run();
  if (lock.meta.changes === 0) {
    return { processed: 0, remaining: -1, found: 0, errors: ["A scan is already running"], done: true };
  }
  /** Keeps the lock alive while a long batch is running. */
  const renewLock = () => {
    const previous = lockStamp;
    lockStamp = Date.now();
    return db
      .prepare("UPDATE users SET scan_started_at = ? WHERE id = ? AND scan_started_at = ?")
      .bind(lockStamp, user.id, previous);
  };

  const errors: string[] = [];
  let processed = 0;
  let found = 0;
  let remaining = 0;
  try {
    const ids = await deps.mail.listMessageIds(buildSearchQuery(user.scan_since), MAX_IDS);
    // One query for everything already read this season.
    const rows = await allRows<{ gmail_id: string; kind: string | null; attempts: number }>(
      db.prepare("SELECT gmail_id, kind, attempts FROM emails WHERE user_id = ?").bind(user.id),
    );
    const finished = new Set(rows.filter((r) => r.kind !== "pending").map((r) => r.gmail_id));
    const attempts = new Map(rows.filter((r) => r.kind === "pending").map((r) => [r.gmail_id, r.attempts]));
    const todo = ids.filter((id) => !finished.has(id)).reverse();
    remaining = todo.length;
    if (todo.length === 0) return { processed, remaining, found, errors, done: true };

    const { ctx, listForPrompt } = await loadContext(db, user.id);
    for (const id of todo.slice(0, batchSize)) {
      const tries = attempts.get(id) ?? 0;
      if (tries >= MAX_ATTEMPTS) {
        await finishEmail(db, user.id, id, null, "error", null, `Skipped after ${tries} failed tries`).run();
        processed++;
        continue;
      }
      // Count the attempt first: if this email crashes the run, it is
      // eventually skipped instead of blocking the inbox.
      await db.batch([startAttempt(db, user.id, id), renewLock()]);

      let message: MailMessage;
      try {
        message = await deps.mail.getMessage(id);
      } catch (err) {
        if (err instanceof GmailApiError && err.isServiceProblem) {
          await refundAttempt(db, user.id, id).run();
          errors.push(`Couldn't reach Gmail: ${describe(err)}`);
          break;
        }
        // Deleted since the search, or a message we can't parse: skip it.
        const reason = err instanceof GmailApiError && err.status === 404 ? "The email no longer exists" : describe(err);
        await finishEmail(db, user.id, id, null, "error", null, `Couldn't open this email: ${reason}`).run();
        processed++;
        continue;
      }
      if (!message.text && !message.subject) {
        await finishEmail(db, user.id, id, message, "not_order_related", null, null).run();
        processed++;
        continue;
      }

      let extraction;
      try {
        extraction = await deps.extractor.extract({ email: message, listItems: listForPrompt });
      } catch (err) {
        if (err instanceof PermanentExtractionError) {
          await finishEmail(db, user.id, id, message, "error", null, describe(err)).run();
          processed++;
          continue;
        }
        if (isServiceError(err)) await refundAttempt(db, user.id, id).run();
        errors.push(`Couldn't read emails right now: ${describe(err)}`);
        break;
      }

      try {
        // The outcome is written in the same transaction as the orders, so
        // an email is never half-applied and then read again.
        const { orderId } = await applyExtraction(db, ctx, message, extraction, (orderId) => [
          finishEmail(db, user.id, id, message, extraction.kind, orderId, null),
        ]);
        if (orderId) found++;
      } catch (err) {
        // Possibly a passing database problem: try again next scan (the
        // attempt still counts, so a real bug can't loop forever).
        console.error("applyExtraction failed", id, err);
        errors.push(`Couldn't save an order: ${describe(err)}`);
        break;
      }
      processed++;
    }
    remaining = todo.length - processed;
  } catch (err) {
    errors.push(describe(err));
  } finally {
    // Release the lock only if it's still ours.
    await db
      .prepare(
        `UPDATE users SET last_scan_at = ?, last_scan_error = ?,
           scan_started_at = CASE WHEN scan_started_at = ? THEN NULL ELSE scan_started_at END
         WHERE id = ?`,
      )
      .bind(Date.now(), errors[0] ?? null, lockStamp, user.id)
      .run();
  }
  return { processed, remaining, found, errors, done: remaining <= 0 || errors.length > 0 };
}
