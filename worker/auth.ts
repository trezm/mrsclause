// Google sign-in (OAuth 2.0 authorization code flow with PKCE) and sessions.
//
// Signing in also asks for read-only Gmail access, which is what lets the
// scanner find order and shipping emails. The Google refresh token is stored
// encrypted; access tokens are minted on demand and never stored.

import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { decryptString, encryptString, randomToken, sha256Base64Url } from "./lib/crypto";
import { DAY_MS, addDays, defaultDeadline, isoDate, newId } from "./lib/util";
import type { UserRow } from "./db";
import { seedDemoList } from "./dev/seed";

export const DEV_USER_SUB = "dev-user";

export type AppEnv = { Bindings: Env; Variables: { user: UserRow } };

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const BASE_SCOPES = ["openid", "email", "profile"];
const SESSION_COOKIE = "gl_session";
const STATE_COOKIE = "gl_oauth";
const SESSION_TTL_MS = 30 * DAY_MS;
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

interface IdTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

function isHttps(c: Context): boolean {
  return new URL(c.req.url).protocol === "https:";
}

function redirectUri(c: Context): string {
  return new URL("/auth/callback", c.req.url).toString();
}

function decodeIdToken(idToken: string): IdTokenClaims {
  const payload = idToken.split(".")[1];
  if (!payload) throw new Error("Malformed id_token");
  const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(json, (ch) => ch.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as IdTokenClaims;
}

function isAllowed(env: Env, email: string): boolean {
  const list = (env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return list.length === 0 || list.includes(email.toLowerCase());
}

function setupErrorPage(message: string): Response {
  const html = `<!doctype html><meta charset="utf-8"><title>Giftlist setup</title>
<body style="font:16px system-ui;max-width:560px;margin:15vh auto;padding:0 16px;line-height:1.5">
<h1 style="font-size:22px">Sign-in isn't available yet</h1><p>${message}</p><p><a href="/">Back</a></p></body>`;
  return new Response(html, { status: 500, headers: { "content-type": "text/html; charset=utf-8" } });
}

async function createSession(c: Context<AppEnv>, userId: string): Promise<void> {
  const token = randomToken(32);
  const now = Date.now();
  await c.env.DB.prepare("INSERT INTO sessions (id_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Base64Url(token), userId, now + SESSION_TTL_MS, now)
    .run();
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isHttps(c),
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

async function upsertUser(
  db: D1Database,
  profile: { sub: string; email: string; name: string | null; picture: string | null },
): Promise<UserRow> {
  const existing = await db.prepare("SELECT * FROM users WHERE google_sub = ?").bind(profile.sub).first<UserRow>();
  if (existing) {
    await db
      .prepare("UPDATE users SET email = ?, name = ?, picture = ? WHERE id = ?")
      .bind(profile.email, profile.name, profile.picture, existing.id)
      .run();
    return { ...existing, email: profile.email, name: profile.name, picture: profile.picture };
  }
  const today = isoDate(Date.now());
  const user: UserRow = {
    id: newId("usr"),
    google_sub: profile.sub,
    email: profile.email,
    name: profile.name,
    picture: profile.picture,
    gmail_refresh_token: null,
    gmail_connected_at: null,
    scan_since: addDays(today, -60),
    deadline: defaultDeadline(today),
    last_scan_at: null,
    last_scan_error: null,
    scan_started_at: null,
    created_at: Date.now(),
  };
  await db
    .prepare(
      `INSERT INTO users (id, google_sub, email, name, picture, scan_since, deadline, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(user.id, user.google_sub, user.email, user.name, user.picture, user.scan_since, user.deadline, user.created_at)
    .run();
  return user;
}

export const auth = new Hono<AppEnv>();

/** Lets the sign-in page show the right buttons. */
auth.get("/config", (c) =>
  c.json({
    googleConfigured: !!(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET),
    devLogin: c.env.DEV_LOGIN === "true",
  }),
);

/**
 * Starts Google sign-in. `?consent=1` forces Google's consent screen, which is
 * the only way to get a fresh refresh token for an account that already
 * granted access once.
 */
auth.get("/login", async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    return setupErrorPage("Set GOOGLE_CLIENT_ID (in wrangler.jsonc) and the GOOGLE_CLIENT_SECRET secret, then reload.");
  }
  const consent = c.req.query("consent") === "1";
  const state = randomToken(16);
  const verifier = randomToken(48);
  setCookie(c, STATE_COOKIE, `${state}.${verifier}.${consent ? "c" : "-"}`, {
    httpOnly: true,
    secure: isHttps(c),
    sameSite: "Lax",
    path: "/auth",
    maxAge: 600,
  });
  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(c),
    response_type: "code",
    scope: [...BASE_SCOPES, GMAIL_SCOPE].join(" "),
    state,
    code_challenge: await sha256Base64Url(verifier),
    code_challenge_method: "S256",
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: consent ? "consent" : "select_account",
  });
  const hint = c.req.query("login_hint");
  if (hint) params.set("login_hint", hint);
  return c.redirect(`${GOOGLE_AUTH_URL}?${params}`);
});

auth.get("/callback", async (c) => {
  const cookie = getCookie(c, STATE_COOKIE) ?? "";
  deleteCookie(c, STATE_COOKIE, { path: "/auth" });
  const [expectedState, verifier, consentFlag] = cookie.split(".");

  const error = c.req.query("error");
  if (error) return c.redirect(`/?auth_error=${encodeURIComponent(error)}`);

  const code = c.req.query("code");
  if (!code || !expectedState || !verifier || c.req.query("state") !== expectedState) {
    return c.redirect("/?auth_error=state_mismatch");
  }

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(c),
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  const tokens = (await tokenRes.json()) as GoogleTokenResponse;
  if (!tokenRes.ok || !tokens.id_token) {
    console.error("Google token exchange failed", tokens.error, tokens.error_description);
    return c.redirect("/?auth_error=token_exchange");
  }

  // The id_token came straight from Google's token endpoint over TLS, so its
  // signature does not need re-verifying (OIDC Core 3.1.3.7); check the claims.
  const claims = decodeIdToken(tokens.id_token);
  const validIssuer = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
  if (!validIssuer || claims.aud !== c.env.GOOGLE_CLIENT_ID || claims.exp * 1000 < Date.now()) {
    return c.redirect("/?auth_error=bad_token");
  }
  if (!claims.email || claims.email_verified === false) return c.redirect("/?auth_error=no_email");
  if (!isAllowed(c.env, claims.email)) return c.redirect("/?auth_error=not_allowed");

  const user = await upsertUser(c.env.DB, {
    sub: claims.sub,
    email: claims.email,
    name: claims.name ?? null,
    picture: claims.picture ?? null,
  });

  const grantedGmail = tokens.scope.split(" ").includes(GMAIL_SCOPE);
  let justConnected = false;
  if (grantedGmail && tokens.refresh_token) {
    const encrypted = await encryptString(c.env.TOKEN_ENCRYPTION_KEY, tokens.refresh_token);
    await c.env.DB.prepare(
      "UPDATE users SET gmail_refresh_token = ?, gmail_connected_at = ?, last_scan_error = NULL WHERE id = ?",
    )
      .bind(encrypted, Date.now(), user.id)
      .run();
    justConnected = !user.gmail_refresh_token;
  } else if (grantedGmail && !user.gmail_refresh_token && consentFlag !== "c") {
    // Google only issues a refresh token on the consent screen. This account
    // approved us before (e.g. on another deployment), so ask once more.
    return c.redirect(`/auth/login?consent=1&login_hint=${encodeURIComponent(claims.email)}`);
  }

  await createSession(c, user.id);
  return c.redirect(justConnected ? "/?scan=1" : "/");
});

auth.post("/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    await c.env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256Base64Url(token)).run();
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

/** Local development only: sign in as a demo user without Google. */
auth.get("/dev-login", async (c) => {
  if (c.env.DEV_LOGIN !== "true") return c.notFound();
  const user = await upsertUser(c.env.DB, {
    sub: DEV_USER_SUB,
    email: "demo@example.com",
    name: "Demo Shopper",
    picture: null,
  });
  await seedDemoList(c.env.DB, user.id);
  await createSession(c, user.id);
  return c.redirect("/");
});

/** Loads the signed-in user, or answers 401. */
export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return c.json({ error: "unauthorized" }, 401);
  const user = await c.env.DB.prepare(
    `SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.id_hash = ? AND sessions.expires_at > ?`,
  )
    .bind(await sha256Base64Url(token), Date.now())
    .first<UserRow>();
  if (!user) return c.json({ error: "unauthorized" }, 401);
  c.set("user", user);
  await next();
});

/** Rejects cross-site state-changing requests (defense in depth on top of SameSite cookies). */
export const sameOrigin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: "bad origin" }, 403);
  }
  await next();
});

export class GmailAuthError extends Error {}

/** Exchanges the stored refresh token for a short-lived Gmail access token. */
export async function getGmailAccessToken(env: Env, user: UserRow): Promise<string> {
  if (!user.gmail_refresh_token) throw new GmailAuthError("Gmail is not connected");
  const refreshToken = await decryptString(env.TOKEN_ENCRYPTION_KEY, user.gmail_refresh_token);
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = (await res.json()) as GoogleTokenResponse;
  if (res.ok && body.access_token) return body.access_token;
  if (body.error === "invalid_grant") {
    // Revoked by the user, or expired (Google expires tokens after 7 days for
    // apps left in "Testing" mode). Forget it so the UI offers to reconnect.
    // Only clear the token we tried: the user may have just reconnected.
    await env.DB.prepare(
      "UPDATE users SET gmail_refresh_token = NULL, last_scan_error = ? WHERE id = ? AND gmail_refresh_token = ?",
    )
      .bind("Gmail access expired or was revoked. Reconnect Gmail to keep tracking orders.", user.id, user.gmail_refresh_token)
      .run();
    throw new GmailAuthError("Gmail access expired or was revoked");
  }
  throw new Error(`Google token refresh failed: ${body.error ?? res.status}`);
}

export async function disconnectGmail(env: Env, user: UserRow): Promise<void> {
  if (user.gmail_refresh_token) {
    try {
      const token = await decryptString(env.TOKEN_ENCRYPTION_KEY, user.gmail_refresh_token);
      // Token in the body, not the URL, so it can't end up in request logs.
      await fetch(GOOGLE_REVOKE_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
      });
    } catch (err) {
      console.warn("Token revoke failed", err);
    }
  }
  await env.DB.prepare("UPDATE users SET gmail_refresh_token = NULL, gmail_connected_at = NULL WHERE id = ?")
    .bind(user.id)
    .run();
}
