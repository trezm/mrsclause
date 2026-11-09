import { useState } from "react";
import type { Dashboard, Order, OrderLine } from "../../shared/types";
import { api } from "../api";
import { formatMoney, friendlyDay } from "../format";
import { useApp, useLookups } from "../state";
import { Empty, Icon } from "./ui";

export type ReviewEntry = { key: string; order: Order; line: OrderLine | null };

/** Purchases that aren't tied to a gift yet, newest first. */
export function reviewEntries(data: Dashboard): ReviewEntry[] {
  const out: ReviewEntry[] = [];
  for (const order of data.orders) {
    if (order.ignored || order.status === "cancelled" || order.status === "returned") continue;
    if (order.lines.length === 0) {
      out.push({ key: order.id, order, line: null });
      continue;
    }
    for (const line of order.lines) {
      if (line.status === "active" && (line.matchState === "unmatched" || line.matchState === "suggested")) {
        out.push({ key: line.id, order, line });
      }
    }
  }
  return out;
}

/** "Glass Pour Over Coffee Maker, 34 oz (Black)" -> "Glass Pour Over Coffee Maker" */
function shortName(description: string): string {
  const cut = description.split(/\s[-–|]\s|,|\(/)[0]!.trim();
  return (cut.length >= 4 ? cut : description).slice(0, 80);
}

export function ReviewQueue({ limit }: { limit?: number }) {
  const { data } = useApp();
  const entries = reviewEntries(data);
  if (entries.length === 0) {
    return (
      <Empty icon="check" title="All sorted">
        Every purchase from your inbox is matched to a gift or marked as not a gift.
      </Empty>
    );
  }
  return (
    <ul className="review-list">
      {entries.slice(0, limit).map((e) => (
        <ReviewCard key={e.key} entry={e} />
      ))}
    </ul>
  );
}

function ReviewCard({ entry }: { entry: ReviewEntry }) {
  const { data, act } = useApp();
  const { items, people } = useLookups();
  const { order, line } = entry;
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState(line ? shortName(line.description) : "");
  const [recipientId, setRecipientId] = useState(line?.suggestedRecipientId ?? "");

  const suggested = line?.matchState === "suggested" && line.itemId ? items.get(line.itemId) : undefined;
  const suggestedPerson = suggested?.recipientId ? people.get(suggested.recipientId) : undefined;
  const amount = line ? line.amountCents : order.totalCents;
  const meta = [order.vendor, amount !== null ? formatMoney(amount) : null, order.orderDate ? friendlyDay(order.orderDate, data.today) : null]
    .filter(Boolean)
    .join(" · ");

  const link = (itemId: string) =>
    act(
      () => (line ? api.post(`/lines/${line.id}/link`, { itemId }) : api.post(`/orders/${order.id}/link`, { itemId })),
      "Linked to gift",
    );
  const notAGift = () =>
    act(() => (line ? api.post(`/lines/${line.id}/ignore`) : api.patch(`/orders/${order.id}`, { ignored: true })));

  // Gifts without a purchase first: they're the likely match.
  const options = [...data.items].sort((a, b) => Number(a.status !== "idea") - Number(b.status !== "idea"));

  return (
    <li className="review">
      <div className="review-title">{line ? line.description : `Order ${order.orderNumber ?? ""} (no product details)`}</div>
      <div className="review-meta">{meta}</div>
      {line?.shipToName && (
        <div className="review-hint">
          <Icon name="user" size={13} /> Shipping to {line.shipToName}
        </div>
      )}

      {suggested ? (
        <div className="suggestion">
          <span>
            <Icon name="sparkle" size={14} /> Looks like <strong>{suggested.name}</strong>
            {suggestedPerson ? <> for {suggestedPerson.name}</> : null}
          </span>
          <div className="row-actions">
            <button className="btn btn-small btn-primary" onClick={() => void link(suggested.id)}>Yes, link it</button>
            <button className="btn btn-small" onClick={() => void act(() => api.post(`/lines/${line!.id}/unlink`))}>No</button>
          </div>
        </div>
      ) : creating && line ? (
        <form
          className="new-gift-form"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              () => api.post(`/lines/${line.id}/new-item`, { name: name.trim() || undefined, recipientId: recipientId || null }),
              "Added to the list",
            );
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Gift name" />
          <select value={recipientId} onChange={(e) => setRecipientId(e.target.value)} aria-label="Who is it for?">
            <option value="">Who's it for?</option>
            {data.recipients.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
          <div className="row-actions">
            <button className="btn btn-small btn-primary" type="submit">Add gift</button>
            <button className="btn btn-small" type="button" onClick={() => setCreating(false)}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="row-actions">
          <select
            className="select-small"
            value=""
            onChange={(e) => e.target.value && void link(e.target.value)}
            aria-label="Link to a gift"
            disabled={options.length === 0}
          >
            <option value="">{options.length ? "Link to a gift…" : "No gifts on the list"}</option>
            {options.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
                {i.recipientId && people.get(i.recipientId) ? ` (${people.get(i.recipientId)!.name})` : ""}
                {i.status !== "idea" ? " · already bought" : ""}
              </option>
            ))}
          </select>
          {line && (
            <button className="btn btn-small" onClick={() => setCreating(true)}>
              <Icon name="plus" size={14} /> New gift
            </button>
          )}
          <button className="btn btn-small btn-quiet" onClick={() => void notAGift()} title="Hide this purchase">
            Not a gift
          </button>
        </div>
      )}
    </li>
  );
}
