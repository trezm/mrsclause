import { useState, type FormEvent } from "react";
import type { Item, Recipient } from "../../shared/types";
import { api } from "../api";
import { formatMoney, friendlyDayInline } from "../format";
import { useApp } from "../state";
import { Icon, StatusPill } from "./ui";

export function People() {
  const { data, openPerson } = useApp();
  const unassigned = data.items.filter((i) => !i.recipientId);
  return (
    <section>
      <div className="section-head">
        <h2>People</h2>
        <button className="btn btn-quiet" onClick={() => openPerson("new")}>
          <Icon name="plus" size={16} /> Add person
        </button>
      </div>
      <div className="people">
        {data.recipients.map((r) => (
          <PersonCard key={r.id} person={r} items={data.items.filter((i) => i.recipientId === r.id)} />
        ))}
        {(unassigned.length > 0 || data.recipients.length === 0) && <PersonCard person={null} items={unassigned} />}
      </div>
    </section>
  );
}

function PersonCard({ person, items }: { person: Recipient | null; items: Item[] }) {
  const { openPerson } = useApp();
  const budget = person?.budgetCents ?? null;
  const spent = person ? person.spentCents : items.reduce((s, i) => s + i.spentCents, 0);
  const ratio = budget ? spent / budget : 0;
  const over = budget !== null && spent > budget;
  const bought = items.filter((i) => i.status !== "idea" && i.status !== "cancelled").length;

  return (
    <article className="card person">
      <header className="person-head">
        {person ? (
          <button className="person-name" onClick={() => openPerson(person.id)} title="Edit person">
            <span className="avatar-sm" aria-hidden="true">{person.name[0]?.toUpperCase()}</span>
            {person.name}
          </button>
        ) : (
          <span className="person-name person-name-static">
            <span className="avatar-sm avatar-none" aria-hidden="true">?</span>
            Not assigned yet
          </span>
        )}
        <span className="person-count">{items.length ? `${bought}/${items.length} bought` : ""}</span>
      </header>
      <div className="person-spend">
        <span className={over ? "over" : undefined}>{formatMoney(spent)}</span>
        {budget !== null && <span className="muted"> of {formatMoney(budget, true)}</span>}
        {over && <span className="over-tag">{formatMoney(spent - budget!)} over</span>}
      </div>
      {budget !== null && (
        <div className={`meter${over ? " meter-over" : ""}`} aria-hidden="true">
          <span style={{ width: `${Math.min(100, Math.round(ratio * 100))}%` }} />
        </div>
      )}
      <ul className="gift-rows">
        {items.map((item) => (
          <GiftRow key={item.id} item={item} />
        ))}
      </ul>
      <AddGift recipientId={person?.id ?? null} />
    </article>
  );
}

function GiftRow({ item }: { item: Item }) {
  const { openItem, data } = useApp();
  const purchase = item.purchases[0];
  let detail: string;
  const possibleMatch =
    item.status === "idea" &&
    data.orders.some((o) => !o.ignored && o.lines.some((l) => l.matchState === "suggested" && l.itemId === item.id));
  if (item.status === "idea") {
    detail = item.targetPriceCents ? `about ${formatMoney(item.targetPriceCents, true)}` : "not bought yet";
  } else if (item.status === "delivered" || item.status === "wrapped") {
    detail = [purchase?.vendor ?? (item.manualStatus === "in_hand" ? "in hand" : null), item.spentCents ? formatMoney(item.spentCents) : null]
      .filter(Boolean)
      .join(" · ");
  } else {
    detail = [purchase?.vendor, item.spentCents ? formatMoney(item.spentCents) : null, item.eta ? `arrives ${friendlyDayInline(item.eta, data.today)}` : null]
      .filter(Boolean)
      .join(" · ");
  }
  return (
    <li>
      <button className="gift-row" onClick={() => openItem(item.id)}>
        <span className="gift-main">
          <span className={`gift-name${item.status === "cancelled" ? " struck" : ""}`}>{item.name}</span>
          <span className="gift-detail">
            {possibleMatch ? <span className="hint-match">Possible purchase found · </span> : null}
            {detail}
          </span>
        </span>
        <span className="gift-side">
          {item.risk && (
            <span className={`risk risk-${item.risk}`} title={item.risk === "late" ? "Expected after the big day" : "Cutting it close"}>
              <Icon name="alert" size={14} />
              {item.risk === "late" ? "Late" : "Close"}
            </span>
          )}
          <StatusPill status={item.status} small />
        </span>
      </button>
    </li>
  );
}

function AddGift({ recipientId }: { recipientId: string | null }) {
  const { act } = useApp();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    const okay = await act(() => api.post("/items", { name: trimmed, recipientId }));
    setBusy(false);
    if (okay) setName("");
  };
  return (
    <form className="add-gift" onSubmit={submit}>
      <Icon name="plus" size={16} />
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Add a gift idea"
        aria-label="Add a gift idea"
        disabled={busy}
      />
    </form>
  );
}
