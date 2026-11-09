import { useState } from "react";
import type { Order } from "../../shared/types";
import { api } from "../api";
import { formatMoney, friendlyDay, friendlyDayInline, ORDER_STATUS_LABEL, SHIPMENT_STATUS_LABEL } from "../format";
import { useApp, useLookups } from "../state";
import { ReviewQueue, reviewEntries } from "./Review";
import { Empty, Icon } from "./ui";

export function OrdersView() {
  const { data } = useApp();
  const [showHidden, setShowHidden] = useState(false);
  const visible = data.orders.filter((o) => !o.ignored);
  const hidden = data.orders.filter((o) => o.ignored);
  const review = reviewEntries(data);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Orders</h1>
          <p className="muted">Everything found in your inbox, plus purchases you added by hand.</p>
        </div>
      </div>

      <div className="columns columns-reverse">
        <div className="col-main">
          {visible.length === 0 ? (
            <section className="panel">
              <Empty icon="inbox" title="No orders yet">
                Run a scan, or add a purchase by hand from any gift.
              </Empty>
            </section>
          ) : (
            <ul className="orders">
              {visible.map((o) => (
                <OrderCard key={o.id} order={o} />
              ))}
            </ul>
          )}
          {hidden.length > 0 && (
            <div className="hidden-orders">
              <button className="link-btn" onClick={() => setShowHidden(!showHidden)}>
                <Icon name="eyeOff" size={14} /> {showHidden ? "Hide" : "Show"} {hidden.length} order{hidden.length === 1 ? "" : "s"} marked “not gifts”
              </button>
              {showHidden && (
                <ul className="orders">
                  {hidden.map((o) => (
                    <OrderCard key={o.id} order={o} />
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        <aside className="col-side">
          <section className="panel">
            <div className="panel-head">
              <h2>Needs a look{review.length ? ` (${review.length})` : ""}</h2>
            </div>
            <p className="panel-sub">Link each purchase to a gift, add it as a new gift, or mark it as not a gift.</p>
            <ReviewQueue />
          </section>
        </aside>
      </div>
    </>
  );
}

function OrderCard({ order }: { order: Order }) {
  const { data, act, openItem } = useApp();
  const { items, people } = useLookups();
  const meta = [
    order.orderNumber ? `#${order.orderNumber}` : null,
    order.orderDate ? friendlyDay(order.orderDate, data.today) : null,
    order.source === "manual" ? "added by hand" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <li className={`card order${order.ignored ? " order-hidden" : ""}`}>
      <div className="order-head">
        <div>
          <div className="order-vendor">{order.vendor}</div>
          <div className="muted small">{meta}</div>
        </div>
        <div className="order-right">
          <span className="order-total">{formatMoney(order.totalCents)}</span>
          <span className={`order-status status-${order.status}`}>{ORDER_STATUS_LABEL[order.status]}</span>
        </div>
      </div>

      {order.note && (
        <div className="order-note">
          <Icon name="alert" size={15} />
          <span>{order.note}</span>
          <div className="row-actions">
            {order.status !== "cancelled" && (
              <button className="btn btn-small" onClick={() => void act(() => api.patch(`/orders/${order.id}`, { status: "cancelled", note: null }))}>
                Cancel whole order
              </button>
            )}
            <button className="btn btn-small btn-quiet" onClick={() => void act(() => api.patch(`/orders/${order.id}`, { note: null }))}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {order.lines.length > 0 && (
        <ul className="order-lines">
          {order.lines.map((l) => {
            const item = l.itemId ? items.get(l.itemId) : undefined;
            const person = item?.recipientId ? people.get(item.recipientId) : undefined;
            return (
              <li key={l.id} className={l.status !== "active" || l.matchState === "ignored" ? "line-muted" : undefined}>
                <span className="line-desc">
                  {l.quantity > 1 && <span className="muted">{l.quantity} × </span>}
                  {l.description}
                  {l.status !== "active" && <span className="muted"> ({l.status})</span>}
                </span>
                <span className="line-side">
                  {l.matchState === "matched" && item ? (
                    <button className="chip chip-link" onClick={() => openItem(item.id)}>
                      <Icon name="link" size={12} /> {item.name}
                      {person ? ` · ${person.name}` : ""}
                    </button>
                  ) : l.matchState === "ignored" ? (
                    <button className="chip chip-quiet" onClick={() => void act(() => api.post(`/lines/${l.id}/unlink`))} title="Put back in “Needs a look”">
                      Not a gift · undo
                    </button>
                  ) : (
                    <span className="chip chip-warn">Needs a look</span>
                  )}
                  <span className="line-amount">{formatMoney(l.amountCents)}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {order.shipments.length > 0 && (
        <ul className="order-shipments">
          {order.shipments.map((s) => (
            <li key={s.id}>
              <Icon name="truck" size={14} />
              <a href={s.trackingUrl ?? "#"} target="_blank" rel="noreferrer" className="track-link">
                {s.carrier ?? "Tracking"} {s.trackingNumber}
                <Icon name="external" size={12} />
              </a>
              <span className={`ship-status ship-${s.status}`}>{SHIPMENT_STATUS_LABEL[s.status]}</span>
              <span className="muted small">
                {s.status === "delivered"
                  ? s.deliveredAt && friendlyDay(s.deliveredAt, data.today)
                  : (s.estimatedDelivery ?? order.estimatedDelivery) && `expected ${friendlyDayInline(s.estimatedDelivery ?? order.estimatedDelivery, data.today)}`}
              </span>
              {s.status !== "delivered" && (
                <button className="link-btn small" onClick={() => void act(() => api.patch(`/shipments/${s.id}`, { status: "delivered" }))}>
                  Mark delivered
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="order-actions">
        {order.emailSubject && <span className="muted small order-subject" title="Email subject">“{order.emailSubject}”</span>}
        <span className="spacer" />
        {order.ignored ? (
          <button className="link-btn small" onClick={() => void act(() => api.patch(`/orders/${order.id}`, { ignored: false }))}>
            Show again
          </button>
        ) : (
          <>
            <button className="link-btn small" onClick={() => void act(() => api.patch(`/orders/${order.id}`, { ignored: true }), "Order hidden")}>
              Not gifts
            </button>
            <button
              className="link-btn small"
              onClick={() => void act(() => api.post("/muted-vendors", { vendor: order.vendor }), `Hiding all orders from ${order.vendor}`)}
            >
              Always hide {order.vendor}
            </button>
          </>
        )}
        <button
          className="link-btn small danger"
          onClick={() => {
            if (confirm("Delete this order? It won't come back unless you reset the scan.")) void act(() => api.del(`/orders/${order.id}`));
          }}
        >
          Delete
        </button>
      </div>
    </li>
  );
}
