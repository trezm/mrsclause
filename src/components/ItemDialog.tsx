import { useState, type FormEvent } from "react";
import { api } from "../api";
import { centsToInput, formatMoney, friendlyDay, friendlyDayInline, parseMoney, SHIPMENT_STATUS_LABEL } from "../format";
import { useApp } from "../state";
import { Field, Icon, Modal, StatusPill } from "./ui";

export function ItemDialog({ itemId, onClose }: { itemId: string; onClose: () => void }) {
  const { data, act } = useApp();
  const item = data.items.find((i) => i.id === itemId)!;
  const [name, setName] = useState(item.name);
  const [recipientId, setRecipientId] = useState(item.recipientId ?? "");
  const [target, setTarget] = useState(centsToInput(item.targetPriceCents));
  const [url, setUrl] = useState(item.url ?? "");
  const [notes, setNotes] = useState(item.notes ?? "");
  const [manualPrice, setManualPrice] = useState(centsToInput(item.manualPriceCents));
  const [showPurchaseForm, setShowPurchaseForm] = useState(false);

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    const okay = await act(() =>
      api.patch(`/items/${item.id}`, {
        name: name.trim() || item.name,
        recipientId: recipientId || null,
        targetPriceCents: parseMoney(target),
        url: url.trim() || null,
        notes: notes.trim() || null,
        manualPriceCents: parseMoney(manualPrice),
      }),
    );
    if (okay) onClose();
  };

  const setManual = (manualStatus: "in_hand" | "wrapped" | null) =>
    act(() => api.patch(`/items/${item.id}`, { manualStatus, manualPriceCents: parseMoney(manualPrice) }));

  return (
    <Modal
      title={item.name}
      onClose={onClose}
      wide
      footer={
        <>
          <button
            className="btn btn-danger-quiet"
            onClick={async () => {
              if (!confirm(`Delete "${item.name}"? Any linked purchases go back to "Needs a look".`)) return;
              if (await act(() => api.del(`/items/${item.id}`), "Gift deleted")) onClose();
            }}
          >
            Delete
          </button>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => void save()}>Save</button>
        </>
      }
    >
      <div className="item-status-row">
        <StatusPill status={item.status} />
        {item.eta && <span className="muted">Expected {friendlyDayInline(item.eta, data.today)}</span>}
        {item.risk && <span className={`risk risk-${item.risk}`}><Icon name="alert" size={14} />{item.risk === "late" ? "Arrives after the big day" : "Cutting it close"}</span>}
        <span className="spacer" />
        <span className="muted">Spent {formatMoney(item.spentCents)}</span>
      </div>

      <form className="form-grid" onSubmit={save}>
        <Field label="Gift">
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="For">
          <select value={recipientId} onChange={(e) => setRecipientId(e.target.value)}>
            <option value="">Not assigned</option>
            {data.recipients.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Planned price">
          <input value={target} onChange={(e) => setTarget(e.target.value)} inputMode="decimal" placeholder="$0.00" />
        </Field>
        <Field label="Link">
          <input value={url} onChange={(e) => setUrl(e.target.value)} type="url" placeholder="https://" />
          {item.url && /^https?:\/\//i.test(item.url) && (
            <a className="field-hint track-link" href={item.url} target="_blank" rel="noreferrer">
              Open link <Icon name="external" size={12} />
            </a>
          )}
        </Field>
        <Field label="Notes">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Size, color, where to hide it…" />
        </Field>
        <button type="submit" hidden />
      </form>

      <h3 className="subhead">Tracked purchases</h3>
      {item.purchases.length === 0 ? (
        <p className="muted small">
          Nothing linked yet. Purchases from your inbox are matched automatically, or link one from “Needs a look”.
        </p>
      ) : (
        <ul className="purchases">
          {item.purchases.map((p) => (
            <li key={p.lineId} className="purchase">
              <div className="purchase-main">
                <strong>{p.vendor}</strong>
                <span className="muted small">
                  {[p.orderNumber && `#${p.orderNumber}`, p.orderDate && friendlyDay(p.orderDate, data.today), p.amountCents !== null && formatMoney(p.amountCents)]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <span className="small">{p.description}</span>
                {p.shipment && (
                  <span className="small">
                    {SHIPMENT_STATUS_LABEL[p.shipment.status]}
                    {p.eta && ` · expected ${friendlyDayInline(p.eta, data.today)}`}
                    {" · "}
                    <a href={p.shipment.trackingUrl ?? "#"} target="_blank" rel="noreferrer" className="track-link">
                      {p.shipment.carrier ?? "Track"} {p.shipment.trackingNumber}
                      <Icon name="external" size={12} />
                    </a>
                  </span>
                )}
              </div>
              <div className="purchase-side">
                <StatusPill status={p.status} small />
                {p.shipment && p.shipment.status !== "delivered" && (
                  <button
                    className="btn btn-small btn-quiet"
                    onClick={() => void act(() => api.patch(`/shipments/${p.shipment!.id}`, { status: "delivered" }))}
                  >
                    Mark delivered
                  </button>
                )}
                <button className="btn btn-small btn-quiet" onClick={() => void act(() => api.post(`/lines/${p.lineId}/unlink`))}>
                  Unlink
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {showPurchaseForm ? (
        <ManualPurchase itemId={item.id} onDone={() => setShowPurchaseForm(false)} />
      ) : (
        <button className="btn btn-small" onClick={() => setShowPurchaseForm(true)}>
          <Icon name="plus" size={14} /> Add order or tracking number by hand
        </button>
      )}

      <h3 className="subhead">Bought it another way?</h3>
      <div className="manual-row">
        <Field label="Amount spent outside tracked orders" hint="For in-store purchases, cash, or anything without an email.">
          <input value={manualPrice} onChange={(e) => setManualPrice(e.target.value)} inputMode="decimal" placeholder="$0.00" />
        </Field>
        <div className="row-actions">
          {item.manualStatus !== "in_hand" && item.manualStatus !== "wrapped" && (
            <button className="btn btn-small" onClick={() => void setManual("in_hand")}>
              <Icon name="check" size={14} /> I have it
            </button>
          )}
          {item.manualStatus !== "wrapped" ? (
            <button className="btn btn-small" onClick={() => void setManual("wrapped")}>
              <Icon name="gift" size={14} /> Wrapped
            </button>
          ) : null}
          {item.manualStatus && (
            <button className="btn btn-small btn-quiet" onClick={() => void setManual(null)}>
              Undo “{item.manualStatus === "wrapped" ? "wrapped" : "I have it"}”
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function ManualPurchase({ itemId, onDone }: { itemId: string; onDone: () => void }) {
  const { act } = useApp();
  const [vendor, setVendor] = useState("");
  const [price, setPrice] = useState("");
  const [orderNumber, setOrderNumber] = useState("");
  const [tracking, setTracking] = useState("");
  const [eta, setEta] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const okay = await act(
      () =>
        api.post(`/items/${itemId}/purchase`, {
          vendor: vendor.trim(),
          priceCents: parseMoney(price),
          orderNumber: orderNumber.trim() || null,
          trackingNumber: tracking.trim() || null,
          estimatedDelivery: eta || null,
        }),
      "Purchase added",
    );
    if (okay) onDone();
  };
  return (
    <form className="form-grid manual-purchase" onSubmit={submit}>
      <Field label="Store">
        <input value={vendor} onChange={(e) => setVendor(e.target.value)} required placeholder="Where you bought it" />
      </Field>
      <Field label="Price">
        <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="$0.00" />
      </Field>
      <Field label="Order number">
        <input value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} />
      </Field>
      <Field label="Tracking number">
        <input value={tracking} onChange={(e) => setTracking(e.target.value)} />
      </Field>
      <Field label="Expected delivery">
        <input value={eta} onChange={(e) => setEta(e.target.value)} type="date" />
      </Field>
      <div className="row-actions form-actions">
        <button className="btn btn-small btn-primary" type="submit">Add purchase</button>
        <button className="btn btn-small" type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}
