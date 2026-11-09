import { dayDiff, formatMoney } from "../format";
import { useApp } from "../state";
import { Arrivals } from "./Arrivals";
import { People } from "./People";
import { ReviewQueue, reviewEntries } from "./Review";
import { Icon, type IconName } from "./ui";

export function Overview({ onShowOrders }: { onShowOrders: () => void }) {
  const { data } = useApp();
  const { stats, me, today } = data;
  const isChristmas = me.deadline.slice(5) === "12-25";
  const daysLeft = dayDiff(today, me.deadline);
  const overBudget = stats.budgetCents > 0 && stats.spentCents > stats.budgetCents;
  const review = reviewEntries(data);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            {daysLeft > 0
              ? `${daysLeft} day${daysLeft === 1 ? "" : "s"} until ${isChristmas ? "Christmas" : "the big day"}`
              : daysLeft === 0
                ? isChristmas ? "Merry Christmas!" : "It's the big day!"
                : "The big day has passed"}
          </h1>
          <p className="muted">
            {stats.itemCount === 0
              ? "Start by adding the people you're shopping for."
              : `${stats.boughtCount} of ${stats.itemCount} gifts bought${stats.atRiskCount ? ` · ${stats.atRiskCount} cutting it close` : ""}`}
          </p>
        </div>
      </div>

      <section className="tiles" aria-label="Summary">
        <Tile
          icon="wallet"
          label="Spent"
          value={formatMoney(stats.spentCents, true)}
          sub={stats.budgetCents ? `of ${formatMoney(stats.budgetCents, true)} budget` : "No budgets set"}
          tone={overBudget ? "warn" : undefined}
          meter={stats.budgetCents ? stats.spentCents / stats.budgetCents : undefined}
        />
        <Tile
          icon="gift"
          label="Gifts bought"
          value={`${stats.boughtCount} / ${stats.itemCount}`}
          sub={stats.itemCount - stats.boughtCount > 0 ? `${stats.itemCount - stats.boughtCount} still to buy` : stats.itemCount ? "All bought" : "List is empty"}
          meter={stats.itemCount ? stats.boughtCount / stats.itemCount : undefined}
        />
        <Tile
          icon="truck"
          label="On the way"
          value={String(stats.inTransitCount)}
          sub={stats.arrivingThisWeekCount ? `${stats.arrivingThisWeekCount} arriving this week` : "packages in transit"}
        />
        <Tile
          icon="inbox"
          label="Needs a look"
          value={String(stats.needsReviewCount)}
          sub={stats.unsortedCents ? `${formatMoney(stats.unsortedCents, true)} not matched to a gift` : "purchases to sort"}
          tone={stats.needsReviewCount ? "attention" : undefined}
          onClick={stats.needsReviewCount ? onShowOrders : undefined}
        />
      </section>

      <div className="columns">
        <div className="col-main">
          <People />
        </div>
        <aside className="col-side">
          {review.length > 0 && (
            <section className="panel">
              <div className="panel-head">
                <h2>Needs a look</h2>
                {review.length > 3 && (
                  <button className="link-btn" onClick={onShowOrders}>See all {review.length}</button>
                )}
              </div>
              <p className="panel-sub">Purchases from your inbox that aren't tied to a gift yet.</p>
              <ReviewQueue limit={3} />
            </section>
          )}
          <Arrivals />
          {stats.itemCount === 0 && <QuickStart />}
        </aside>
      </div>
    </>
  );
}

function Tile({
  icon,
  label,
  value,
  sub,
  tone,
  meter,
  onClick,
}: {
  icon: IconName;
  label: string;
  value: string;
  sub: string;
  tone?: "warn" | "attention";
  meter?: number;
  onClick?: () => void;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag className={`tile${tone ? ` tile-${tone}` : ""}${onClick ? " tile-clickable" : ""}`} onClick={onClick}>
      <div className="tile-label">
        <Icon name={icon} size={16} />
        {label}
      </div>
      <div className="tile-value">{value}</div>
      <div className="tile-sub">{sub}</div>
      {meter !== undefined && (
        <div className="meter" aria-hidden="true">
          <span style={{ width: `${Math.min(100, Math.round(meter * 100))}%` }} />
        </div>
      )}
    </Tag>
  );
}

function QuickStart() {
  const { data, openPerson } = useApp();
  if (data.recipients.length > 0) return null;
  return (
    <section className="panel">
      <h2>Getting started</h2>
      <ol className="steps">
        <li>Add each person you're buying for, with a budget if you like.</li>
        <li>Add gift ideas under each person.</li>
        <li>Shop as usual. Giftlist matches order emails to your list and tracks the packages.</li>
      </ol>
      <button className="btn btn-primary" onClick={() => openPerson("new")}>
        <Icon name="plus" size={16} /> Add your first person
      </button>
    </section>
  );
}
