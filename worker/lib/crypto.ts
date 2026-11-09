// Small Web Crypto helpers: random tokens, hashing, and AES-GCM for
// encrypting Google refresh tokens at rest in D1.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(input: string): Uint8Array {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function randomToken(byteLength = 32): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256(input: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(input)));
}

export async function sha256Base64Url(input: string): Promise<string> {
  return bytesToBase64Url(await sha256(input));
}

const keyCache = new Map<string, Promise<CryptoKey>>();

/** Derives an AES-256-GCM key from the TOKEN_ENCRYPTION_KEY secret. */
function getKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 16) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be set to a long random string");
  }
  let key = keyCache.get(secret);
  if (!key) {
    key = sha256(secret).then((raw) =>
      crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]),
    );
    keyCache.set(secret, key);
  }
  return key;
}

/** Returns base64url(iv || ciphertext). */
export async function encryptString(secret: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await getKey(secret), encoder.encode(plaintext)),
  );
  const out = new Uint8Array(iv.length + ciphertext.length);
  out.set(iv, 0);
  out.set(ciphertext, iv.length);
  return bytesToBase64Url(out);
}

export async function decryptString(secret: string, payload: string): Promise<string> {
  const bytes = base64UrlToBytes(payload);
  const iv = bytes.slice(0, 12);
  const ciphertext = bytes.slice(12);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await getKey(secret), ciphertext);
  return decoder.decode(plaintext);
}
