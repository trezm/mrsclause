import { Hono } from "hono";
import { api } from "./api";
import { auth, type AppEnv } from "./auth";
import type { UserRow } from "./db";
import { runScan } from "./scan/run";

const app = new Hono<AppEnv>();
app.route("/auth", auth);
app.route("/api", api);
app.notFound((c) => c.json({ error: "Not found" }, 404));

/**
 * Users scanned per cron run. Each scan uses up to ~30 database queries and
 * ~20 outbound requests, so keep this at 1 on the Workers Free plan (limit 50
 * of each per run); on Workers Paid it can go much higher.
 */
function usersPerRun(env: Env): number {
  const n = Number(env.CRON_USERS_PER_RUN);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

async function scheduledScan(env: Env): Promise<void> {
  const { results: users } = await env.DB.prepare(
    `SELECT * FROM users WHERE gmail_refresh_token IS NOT NULL
     ORDER BY COALESCE(last_scan_at, 0) LIMIT ?`,
  )
    .bind(usersPerRun(env))
    .all<UserRow>();
  for (const user of users) {
    try {
      const result = await runScan(env, user);
      console.log(`scan ${user.id}: processed=${result.processed} remaining=${result.remaining}`, result.errors);
    } catch (err) {
      console.error(`scan ${user.id} failed`, err);
    }
  }
}

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(scheduledScan(env));
  },
} satisfies ExportedHandler<Env>;
