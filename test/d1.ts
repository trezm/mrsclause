// A tiny in-memory stand-in for Cloudflare D1, built on node:sqlite, with
// the real migrations applied. Implements only what the app uses.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { UserRow } from "../worker/db";

type Value = string | number | null;

class Statement {
  constructor(
    private db: DatabaseSync,
    readonly sql: string,
    readonly params: Value[] = [],
  ) {}

  bind(...params: unknown[]): Statement {
    for (const p of params) {
      if (p === undefined) throw new Error(`D1_TYPE_ERROR: undefined bound in: ${this.sql}`);
    }
    return new Statement(this.db, this.sql, params as Value[]);
  }

  async first<T>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params);
    return (row ? { ...row } : null) as T | null;
  }

  async all<T>() {
    return { results: this.allSync() as T[], success: true, meta: {} };
  }

  allSync(): unknown[] {
    const stmt = this.db.prepare(this.sql);
    if (/^\s*(select|with)/i.test(this.sql)) return stmt.all(...this.params).map((r) => ({ ...r }));
    stmt.run(...this.params);
    return [];
  }

  async run() {
    const info = this.db.prepare(this.sql).run(...this.params);
    return { success: true, results: [], meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }
}

export function createD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const dir = join(import.meta.dirname, "..", "migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(dir, file), "utf8"));
  }
  const shim = {
    prepare: (sql: string) => new Statement(db, sql),
    async batch(statements: Statement[]) {
      db.exec("BEGIN");
      try {
        const out = statements.map((s) => ({ results: s.allSync(), success: true, meta: {} }));
        db.exec("COMMIT");
        return out;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    raw: db,
  };
  return shim as unknown as D1Database;
}

export async function insertUser(db: D1Database, overrides: Partial<Record<string, Value>> = {}): Promise<UserRow> {
  const user = {
    id: "usr_test",
    google_sub: "sub-test",
    email: "test@example.com",
    name: "Test",
    picture: null,
    gmail_refresh_token: null,
    gmail_connected_at: null,
    scan_since: "2026-09-01",
    deadline: "2026-12-25",
    last_scan_at: null,
    last_scan_error: null,
    scan_started_at: null,
    created_at: 1,
    ...overrides,
  };
  const cols = Object.keys(user);
  await db
    .prepare(`INSERT INTO users (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...Object.values(user))
    .run();
  return (await db.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first<UserRow>())!;
}
