import type { ScanResult } from "../../shared/types";
import { DEV_USER_SUB, GmailAuthError, getGmailAccessToken } from "../auth";
import type { UserRow } from "../db";
import { FixtureExtractor, FixtureMail, buildFixtures } from "../dev/fixtures";
import { ClaudeExtractor } from "./extract";
import { GmailClient } from "./gmail";
import { scanBatch, type ScanDeps } from "./scanner";

const DEFAULT_MODEL = "claude-haiku-5-5";

export function isDevUser(env: Env, user: UserRow): boolean {
  return env.DEV_LOGIN === "true" && user.google_sub === DEV_USER_SUB;
}

function hasRealAnthropicKey(env: Env): boolean {
  return /^sk-ant-[A-Za-z0-9_-]{20,}/.test(env.ANTHROPIC_API_KEY ?? "");
}

/** Emails read per scan call; see SCAN_BATCH_SIZE in wrangler.jsonc. */
function batchSize(env: Env): number {
  const n = Number(env.SCAN_BATCH_SIZE);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 50) : 2;
}

function failed(message: string): ScanResult {
  return { processed: 0, remaining: 0, found: 0, errors: [message], done: true };
}

export async function runScan(env: Env, user: UserRow): Promise<ScanResult> {
  const model = env.EXTRACTION_MODEL || DEFAULT_MODEL;
  let deps: ScanDeps;

  if (isDevUser(env, user)) {
    // Demo inbox. Uses Claude when a real key is configured, else canned answers.
    const fixtures = buildFixtures(Date.now(), user.deadline);
    deps = {
      mail: new FixtureMail(fixtures),
      extractor: hasRealAnthropicKey(env)
        ? new ClaudeExtractor(env.ANTHROPIC_API_KEY, model)
        : new FixtureExtractor(fixtures),
    };
  } else {
    if (!user.gmail_refresh_token) return failed("Gmail isn't connected yet.");
    if (!env.ANTHROPIC_API_KEY) return failed("The ANTHROPIC_API_KEY secret isn't set, so emails can't be read yet.");
    let accessToken: string;
    try {
      accessToken = await getGmailAccessToken(env, user);
    } catch (err) {
      if (err instanceof GmailAuthError) return failed(err.message);
      throw err;
    }
    deps = { mail: new GmailClient(accessToken), extractor: new ClaudeExtractor(env.ANTHROPIC_API_KEY, model) };
  }

  return scanBatch(env.DB, user, deps, batchSize(env));
}
