import type { Dashboard, Order, OrderLine, Shipment } from "../../shared/types";
import { dayDiff, friendlyDay, SHIPMENT_STATUS_LABEL } from "../format";
import { useApp, useLookups } from "../state";
import { Empty, Icon } from "./ui";

interface Arrival {
  key: string;
  order: Order;
  shipment: Shipment | null;
  lines: OrderLine[];
  day: string | null;
  delivered: boolean;
}

function linesFor(order: Order, shipment: Shipment | null): OrderLine[] {
  const active = order.lines.filter((l) => l.status === "active" && l.matchState !== "ignored");
  if (!shipment) return active.filter((l) => !l.shipmentId);
  if (order.shipments.length === 1) return active;
  return active.filter((l) => l.shipmentId === shipment.id);
}

export function arrivals(data: Dashboard): Arrival[] {
  const out: Arrival[] = [];
  for (const order of data.orders) {
    if (order.ignored || order.status === "cancelled" || order.status === "returned") continue;
    for (const s of order.shipments) {
      const delivered = s.status === "delivered";
      const day = delivered ? s.deliveredAt : (s.estimatedDelivery ?? order.estimatedDelivery);
      if (delivered && (!day || dayDiff(day, data.today) > 3)) continue;
      out.push({ key: s.id, order, shipment: s, lines: linesFor(order, s), day, delivered });
    }
    // Ordered but no tracking yet.
    if (order.shipments.length === 0 && order.status !== "delivered") {
      out.push({ key: order.id, order, shipment: null, lines: linesFor(order, null), day: order.estimatedDelivery, delivered: false });
    }
  }
  return out;
}

function bucket(a: Arrival, today: string): string {
  if (a.delivered) return "Delivered recently";
  if (!a.day) return "No date yet";
  const diff = dayDiff(today, a.day);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff <= 7) return "This week";
  return "Later";
}

const ORDER = ["Today", "Tomorrow", "This week", "Later", "No date yet", "Delivered recently"];

export function Arrivals() {
  const { data } = useApp();
  const list = arrivals(data);
  const groups = new Map<string, Arrival[]>();
  for (const a of list.sort((x, y) => (x.day ?? "9999").localeCompare(y.day ?? "9999"))) {
    const name = bucket(a, data.today);
    groups.set(name, [...(groups.get(name) ?? []), a]);
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Arriving</h2>
      </div>
      {list.length === 0 ? (
        <Empty icon="truck" title="Nothing on the way">
          Packages show up here once an order email is found.
        </Empty>
      ) : (
        ORDER.filter((g) => groups.has(g)).map((g) => (
          <div key={g} className="arrival-group">
            <h3 className="arrival-day">{g}</h3>
            <ul className="arrivals">
              {groups.get(g)!.map((a) => (
                <ArrivalRow key={a.key} arrival={a} />
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

function ArrivalRow({ arrival }: { arrival: Arrival }) {
  const { data, openItem } = useApp();
  const { items, people } = useLookups();
  const { order, shipment, lines, day, delivered } = arrival;
  const late = !delivered && !!day && day > data.me.deadline;
  const close = !delivered && !late && !!day && dayDiff(day, data.me.deadline) < 3;
  const statusLabel = shipment ? SHIPMENT_STATUS_LABEL[shipment.status] : "Not shipped yet";
  const statusClass = shipment ? `ship-${shipment.status}` : "ship-pending";

  return (
    <li className={`arrival${delivered ? " arrival-done" : ""}`}>
      <div className="arrival-top">
        <span className="arrival-vendor">{order.vendor}</span>
        <span className={`ship-status ${statusClass}`}>
          {delivered ? <Icon name="check" size={13} /> : null}
          {statusLabel}
        </span>
      </div>
      <ul className="arrival-items">
        {lines.length === 0 && <li className="muted">{order.orderNumber ? `Order ${order.orderNumber}` : "Items not listed"}</li>}
        {lines.map((l) => {
          const item = l.matchState === "matched" && l.itemId ? items.get(l.itemId) : undefined;
          const person = item?.recipientId ? people.get(item.recipientId) : undefined;
          return (
            <li key={l.id}>
              {item ? (
                <button className="link-btn" onClick={() => openItem(item.id)}>{item.name}</button>
              ) : (
                <span className="muted">{l.description}</span>
              )}
              {person && <span className="chip">{person.name}</span>}
            </li>
          );
        })}
      </ul>
      <div className="arrival-meta">
        {day && !delivered && (
          <span className={late || close ? "late-text" : undefined}>
            {late ? "After the big day · " : close ? "Cutting it close · " : ""}
            {friendlyDay(day, data.today)}
          </span>
        )}
        {shipment && (
          <a href={shipment.trackingUrl ?? "#"} target="_blank" rel="noreferrer" className="track-link">
            {shipment.carrier ?? "Track"} {shipment.trackingNumber.slice(-6)}
            <Icon name="external" size={12} />
          </a>
        )}
      </div>
    </li>
  );
}
