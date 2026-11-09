// Minimal Gmail API client: search for purchase emails and fetch them.

import { getHeader, messageText, type GmailPart } from "./email-text";

export interface MailMessage {
  id: string;
  from: string;
  subject: string;
  /** Sent time, epoch ms. */
  date: number;
  text: string;
}

/** Where the scanner gets email from. Gmail in production; fixtures in tests. */
export interface MailSource {
  listMessageIds(query: string, limit: number): Promise<string[]>;
  getMessage(id: string): Promise<MailMessage>;
}

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

const SUBJECT_WORDS = [
  "order",
  "ordered",
  "shipped",
  "shipping",
  "shipment",
  "delivered",
  "delivery",
  "tracking",
  "arriving",
  "package",
  '"on its way"',
  '"on the way"',
  "receipt",
  "purchase",
  "dispatched",
];

/**
 * Gmail search for transactional shopping email since a date. Promotions and
 * social are skipped so newsletters with "order now" in the subject don't
 * cost a model call.
 */
export function buildSearchQuery(since: string): string {
  const subjects = SUBJECT_WORDS.map((w) => `subject:${w}`).join(" ");
  return `after:${since.replace(/-/g, "/")} {${subjects} category:purchases} -category:promotions -category:social -in:chats -in:drafts -in:sent`;
}

/** A failed Gmail request. status 0 means the network request itself failed. */
export class GmailApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }

  /** Gmail is down, rate-limiting, or refusing our token: not this email's fault. */
  get isServiceProblem(): boolean {
    return this.status === 0 || this.status === 401 || this.status === 403 || this.status === 429 || this.status >= 500;
  }
}

export class GmailClient implements MailSource {
  constructor(
    private accessToken: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private async get<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`${API}${path}`, { headers: { authorization: `Bearer ${this.accessToken}` } });
    } catch (err) {
      throw new GmailApiError(`Couldn't reach Gmail: ${err instanceof Error ? err.message : String(err)}`, 0);
    }
    if (!res.ok) throw new GmailApiError(`Gmail API ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status);
    return (await res.json()) as T;
  }

  /** Newest first, as Gmail returns them. */
  async listMessageIds(query: string, limit: number): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ q: query, maxResults: String(Math.min(500, limit - ids.length)) });
      if (pageToken) params.set("pageToken", pageToken);
      const page = await this.get<{ messages?: { id: string }[]; nextPageToken?: string }>(`/messages?${params}`);
      for (const m of page.messages ?? []) ids.push(m.id);
      pageToken = page.nextPageToken;
    } while (pageToken && ids.length < limit);
    return ids;
  }

  async getMessage(id: string): Promise<MailMessage> {
    const msg = await this.get<{ id: string; internalDate?: string; payload: GmailPart }>(
      `/messages/${encodeURIComponent(id)}?format=full`,
    );
    const dateHeader = getHeader(msg.payload, "date");
    const date = Number(msg.internalDate) || (dateHeader ? Date.parse(dateHeader) : NaN) || Date.now();
    return {
      id: msg.id,
      from: getHeader(msg.payload, "from") ?? "",
      subject: getHeader(msg.payload, "subject") ?? "",
      date,
      text: messageText(msg.payload),
    };
  }
}
