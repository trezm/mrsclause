// Turns a Gmail API message payload into plain text a small model can read.

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}

export function getHeader(part: GmailPart, name: string): string | null {
  const lower = name.toLowerCase();
  return part.headers?.find((h) => h.name.toLowerCase() === lower)?.value ?? null;
}

function charsetOf(part: GmailPart): string {
  const contentType = getHeader(part, "content-type") ?? "";
  return /charset="?([^";\s]+)"?/i.exec(contentType)?.[1]?.toLowerCase() ?? "utf-8";
}

/** Enough for any order email; the rest of a huge newsletter is skipped. */
const MAX_ENCODED_CHARS = 800_000;

type WithFromBase64 = { fromBase64?: (s: string, o: { alphabet: string; lastChunkHandling: string }) => Uint8Array };

function base64UrlToBytes(data: string): Uint8Array {
  const clipped = data.length > MAX_ENCODED_CHARS ? data.slice(0, MAX_ENCODED_CHARS) : data;
  const native = (Uint8Array as unknown as WithFromBase64).fromBase64;
  if (native) return native(clipped, { alphabet: "base64url", lastChunkHandling: "loose" });
  const b64 = clipped.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function decodeBase64UrlText(data: string, charset = "utf-8"): string {
  const bytes = base64UrlToBytes(data);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** Collects the first text/plain and text/html bodies, skipping attachments. */
export function collectBodies(payload: GmailPart): { plain: string | null; html: string | null } {
  let plain: string | null = null;
  let html: string | null = null;
  const walk = (part: GmailPart) => {
    if (part.filename) return;
    const type = (part.mimeType ?? "").toLowerCase();
    if (part.body?.data) {
      if (type === "text/plain" && plain === null) plain = decodeBase64UrlText(part.body.data, charsetOf(part));
      if (type === "text/html" && html === null) html = decodeBase64UrlText(part.body.data, charsetOf(part));
    }
    part.parts?.forEach(walk);
  };
  walk(payload);
  return { plain, html };
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  rsquo: "\u2019",
  lsquo: "\u2018",
  rdquo: "\u201d",
  ldquo: "\u201c",
  ndash: "\u2013",
  mdash: "\u2014",
  hellip: "\u2026",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  bull: "\u2022",
  middot: "\u00b7",
  times: "\u00d7",
  pound: "\u00a3",
  euro: "\u20ac",
  cent: "\u00a2",
  zwnj: "",
  zwj: "",
  shy: "",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

const TRACKING_LINK = /track|shipment|package|deliver|carrier|ups\.com|fedex|usps|dhl|ontrac/i;

/**
 * Converts email HTML to readable text. Links that look tracking-related keep
 * their URL, since tracking numbers often only appear inside the link.
 */
/** Order details sit near the top; marketing emails can run to 300 KB+ of HTML. */
const MAX_HTML_CHARS = 120_000;

export function htmlToText(html: string): string {
  let text = html
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .slice(0, MAX_HTML_CHARS)
    .replace(/<[^>]*$/, "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(noscript|title)[\s\S]*?<\/\1>/gi, " ");

  let keptLinks = 0;
  // Link text is bounded so an unclosed <a> can't make this scan quadratic.
  text = text.replace(/<a\b[^>]{0,2000}?href\s*=\s*["']([^"']{1,2000})["'][^>]{0,500}>([\s\S]{0,1000}?)<\/a>/gi, (_m, href: string, inner: string) => {
    const label = inner.replace(/<[^>]+>/g, " ").trim();
    const url = decodeEntities(href);
    if (keptLinks < 12 && /^https?:/i.test(url) && (TRACKING_LINK.test(url) || TRACKING_LINK.test(label))) {
      keptLinks++;
      return ` ${label} [${url.slice(0, 400)}] `;
    }
    return ` ${inner} `;
  });

  text = text
    .replace(/<img\b[^>]*?alt\s*=\s*["']([^"']*)["'][^>]*>/gi, " $1 ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section|article|header|footer|blockquote)>/gi, "\n")
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<[^>]+>/g, " ");

  return normalizeWhitespace(decodeEntities(text));
}

export function normalizeWhitespace(text: string): string {
  return text
    .replace(/[\u200b-\u200f\u2028\u2029\u202f\u00ad\u034f\u061c\u180e\ufeff]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").replace(/^(\s*\|\s*)+|(\s*\|\s*)+$/g, "").trim())
    .filter((line, i, lines) => line !== "" || (i > 0 && lines[i - 1] !== ""))
    .join("\n")
    .trim();
}

/** Best readable text for a message: converted HTML when present, else the plain part. */
export function messageText(payload: GmailPart): string {
  const { plain, html } = collectBodies(payload);
  if (html) {
    const fromHtml = htmlToText(html);
    // Image-only HTML converts to almost nothing; fall back to the plain part then.
    if (!plain || fromHtml.length >= normalizeWhitespace(plain).length * 0.5) return fromHtml;
  }
  return normalizeWhitespace(plain ?? "");
}
