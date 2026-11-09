import { useState } from "react";
import { api } from "../api";
import { timeAgo } from "../format";
import { useApp } from "../state";
import { Field, Icon } from "./ui";

function RetryFailed({ count }: { count: number }) {
  const { act } = useApp();
  return (
    <p className="muted small">
      {count} email{count === 1 ? "" : "s"} couldn't be read.{" "}
      <button className="link-btn small" onClick={() => void act(() => api.post("/scan/retry-failed"), "They'll be read again on the next scan.")}>
        Try again
      </button>
    </p>
  );
}

export function SettingsView({ onSignOut }: { onSignOut: () => void }) {
  const { data, act } = useApp();
  const { me } = data;
  const [scanSince, setScanSince] = useState(me.scanSince);
  const [deadline, setDeadline] = useState(me.deadline);
  const changed = scanSince !== me.scanSince || deadline !== me.deadline;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">Signed in as {me.email}</p>
        </div>
      </div>

      <div className="settings">
        <section className="panel">
          <h2>Gmail</h2>
          {me.devMode ? (
            <p>Demo mode reads a sample inbox instead of Gmail.</p>
          ) : me.gmailConnected ? (
            <>
              <p>
                <Icon name="check" size={14} /> Connected. Last scanned {timeAgo(me.lastScanAt)}. New mail is checked every 30
                minutes.
              </p>
              {me.lastScanError && <p className="error-text">{me.lastScanError}</p>}
              {me.failedEmailCount > 0 && <RetryFailed count={me.failedEmailCount} />}
              <button
                className="btn"
                onClick={() => {
                  if (confirm("Disconnect Gmail? Orders already found stay; new emails won't be read."))
                    void act(() => api.post("/gmail/disconnect"), "Gmail disconnected");
                }}
              >
                Disconnect Gmail
              </button>
            </>
          ) : (
            <>
              <p>{me.lastScanError ?? "Not connected. Connect to have orders and tracking filled in for you."}</p>
              <a className="btn btn-primary" href={`/auth/login?consent=1&login_hint=${encodeURIComponent(me.email)}`}>
                Connect Gmail
              </a>
            </>
          )}
        </section>

        <section className="panel">
          <h2>Season</h2>
          <form
            className="form-grid"
            onSubmit={(e) => {
              e.preventDefault();
              void act(() => api.patch("/settings", { scanSince, deadline }), "Settings saved");
            }}
          >
            <Field label="Read emails from" hint="Orders before this date are ignored. Moving it earlier picks up older orders on the next scan.">
              <input type="date" value={scanSince} onChange={(e) => setScanSince(e.target.value)} required />
            </Field>
            <Field label="Gift day" hint="Used to flag packages that may arrive too late.">
              <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} required />
            </Field>
            <div className="row-actions form-actions">
              <button className="btn btn-primary" type="submit" disabled={!changed}>Save</button>
            </div>
          </form>
        </section>

        <section className="panel">
          <h2>Hidden stores</h2>
          {data.mutedVendors.length === 0 ? (
            <p className="muted">
              None. Use “Always hide” on an order to stop seeing a store you never buy gifts from (groceries, for example).
            </p>
          ) : (
            <ul className="muted-list">
              {data.mutedVendors.map((m) => (
                <li key={m.vendorKey}>
                  <span>{m.vendor}</span>
                  <button className="link-btn small" onClick={() => void act(() => api.del(`/muted-vendors/${encodeURIComponent(m.vendorKey)}`))}>
                    Show again
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <h2>Account</h2>
          <div className="row-actions">
            {me.devMode && (
              <button
                className="btn"
                onClick={() => void act(() => api.post("/dev/reset"), "Demo inbox reset. Run a scan to read it again.")}
              >
                Reset demo inbox
              </button>
            )}
            <button className="btn" onClick={onSignOut}>Sign out</button>
          </div>
        </section>
      </div>
    </>
  );
}
