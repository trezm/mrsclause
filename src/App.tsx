import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dashboard, ScanResult } from "../shared/types";
import { ApiError, api } from "./api";
import { localToday, timeAgo } from "./format";
import { AppContext, type AppState } from "./state";
import { Icon } from "./components/ui";
import { SignIn } from "./components/SignIn";
import { Overview } from "./components/Overview";
import { OrdersView } from "./components/Orders";
import { SettingsView } from "./components/Settings";
import { ItemDialog } from "./components/ItemDialog";
import { PersonDialog } from "./components/PersonDialog";

type Tab = "overview" | "orders" | "settings";

interface Toast {
  id: number;
  message: string;
  tone: "info" | "error";
}

const AUTH_ERRORS: Record<string, string> = {
  access_denied: "Sign-in was cancelled.",
  not_allowed: "That Google account isn't on this Giftlist's allowlist.",
  state_mismatch: "Sign-in expired. Please try again.",
};

export function App() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [phase, setPhase] = useState<"loading" | "signed-out" | "ready" | "error">("loading");
  const [tab, setTab] = useState<Tab>("overview");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [openPersonId, setOpenPersonId] = useState<string | null>(null);
  const [scan, setScan] = useState<{ running: boolean; remaining: number | null }>({ running: false, remaining: null });
  const [menuOpen, setMenuOpen] = useState(false);
  const scanning = useRef(false);

  const toast = useCallback((message: string, tone: "info" | "error" = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 7000 : 3500);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const d = await api.get<Dashboard>(`/dashboard?today=${localToday()}`);
      setData(d);
      setPhase("ready");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setPhase("signed-out");
      else setPhase((p) => (p === "ready" ? p : "error"));
    }
  }, []);

  const act = useCallback(
    async (fn: () => Promise<unknown>, success?: string) => {
      try {
        await fn();
        if (success) toast(success);
        await refresh();
        return true;
      } catch (err) {
        toast(err instanceof Error ? err.message : "Something went wrong", "error");
        await refresh();
        return false;
      }
    },
    [refresh, toast],
  );

  const runScan = useCallback(async () => {
    if (scanning.current) return;
    scanning.current = true;
    setScan({ running: true, remaining: null });
    let found = 0;
    try {
      // Each call reads a small batch; keep going until the inbox is caught up.
      for (let round = 0; round < 100; round++) {
        const result = await api.post<ScanResult>("/scan");
        found += result.found;
        setScan({ running: true, remaining: result.remaining > 0 ? result.remaining : null });
        await refresh();
        if (result.errors.length) {
          toast(result.errors[0]!, "error");
          break;
        }
        if (result.done) break;
      }
      toast(found > 0 ? `Inbox scanned. Found ${found} order update${found === 1 ? "" : "s"}.` : "Inbox scanned. Nothing new.");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Scan failed", "error");
    } finally {
      scanning.current = false;
      setScan({ running: false, remaining: null });
    }
  }, [refresh, toast]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const authError = params.get("auth_error");
    const shouldScan = params.get("scan") === "1";
    if (authError || shouldScan) history.replaceState(null, "", "/");
    if (authError) toast(AUTH_ERRORS[authError] ?? "Sign-in didn't work. Please try again.", "error");
    void refresh().then(() => {
      if (shouldScan) void runScan();
    });
  }, [refresh, runScan, toast]);

  const state = useMemo<AppState | null>(
    () =>
      data && {
        data,
        refresh,
        act,
        toast,
        openItem: setOpenItemId,
        openPerson: setOpenPersonId,
      },
    [data, refresh, act, toast],
  );

  if (phase === "loading") return <div className="splash"><Icon name="gift" size={28} /></div>;
  if (phase === "signed-out") return <SignIn toasts={<Toasts toasts={toasts} />} />;
  if (phase === "error" || !state || !data) {
    return (
      <div className="splash">
        <p>Couldn't load Giftlist.</p>
        <button className="btn" onClick={() => void refresh()}>Try again</button>
      </div>
    );
  }

  const { me, stats } = data;
  const signOut = async () => {
    await api.post("/auth/logout");
    setData(null);
    setPhase("signed-out");
  };

  return (
    <AppContext.Provider value={state}>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <span className="brand-mark"><Icon name="gift" size={18} /></span>
            <span>Giftlist</span>
          </div>
          <nav className="tabs" aria-label="Sections">
            {(["overview", "orders", "settings"] as Tab[]).map((t) => (
              <button key={t} className={`tab${tab === t ? " tab-active" : ""}`} onClick={() => setTab(t)}>
                {t === "overview" ? "Overview" : t === "orders" ? "Orders" : "Settings"}
                {t === "orders" && stats.needsReviewCount > 0 && <span className="badge">{stats.needsReviewCount}</span>}
              </button>
            ))}
          </nav>
          <div className="topbar-right">
            {(me.gmailConnected || me.devMode) && (
              <button
                className="btn btn-quiet scan-btn"
                onClick={() => void runScan()}
                disabled={scan.running}
                title={`Check your inbox for new orders. Last scan: ${timeAgo(me.lastScanAt)}.`}
              >
                <Icon name="refresh" size={16} className={scan.running ? "spin" : undefined} />
                {scan.running ? (
                  <span>{scan.remaining ? `Reading… ${scan.remaining} left` : "Reading inbox…"}</span>
                ) : (
                  <span>
                    Scan inbox<span className="scan-when"> · {timeAgo(me.lastScanAt)}</span>
                  </span>
                )}
              </button>
            )}
            <button className="avatar" onClick={() => setMenuOpen(!menuOpen)} aria-label="Account menu" aria-expanded={menuOpen}>
              {me.picture ? <img src={me.picture} alt="" referrerPolicy="no-referrer" /> : (me.name ?? me.email)[0]!.toUpperCase()}
            </button>
            {menuOpen && (
              <div className="menu" role="menu" onMouseLeave={() => setMenuOpen(false)}>
                <div className="menu-email">{me.email}</div>
                <button role="menuitem" onClick={() => { setMenuOpen(false); setTab("settings"); }}>Settings</button>
                <button role="menuitem" onClick={() => void signOut()}>Sign out</button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="page">
        {!me.gmailConnected && !me.devMode && (
          <div className="banner">
            <Icon name="mail" />
            <div>
              <strong>Connect Gmail to track orders automatically.</strong>
              <span> {me.lastScanError ?? "Giftlist reads order and shipping emails (read-only) and fills in prices, tracking and delivery dates."}</span>
            </div>
            <a className="btn btn-primary" href={`/auth/login?consent=1&login_hint=${encodeURIComponent(me.email)}`}>Connect Gmail</a>
          </div>
        )}
        {me.devMode && (
          <div className="banner banner-demo">
            <Icon name="sparkle" />
            <div>
              <strong>Demo mode.</strong> <span>“Scan inbox” reads a sample inbox from made-up stores. You can reset it in Settings.</span>
            </div>
          </div>
        )}
        {tab === "overview" && <Overview onShowOrders={() => setTab("orders")} />}
        {tab === "orders" && <OrdersView />}
        {tab === "settings" && <SettingsView onSignOut={signOut} />}
      </main>

      {openItemId && data.items.some((i) => i.id === openItemId) && (
        <ItemDialog itemId={openItemId} onClose={() => setOpenItemId(null)} />
      )}
      {openPersonId && <PersonDialog personId={openPersonId} onClose={() => setOpenPersonId(null)} />}
      <Toasts toasts={toasts} />
    </AppContext.Provider>
  );
}

function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`}>{t.message}</div>
      ))}
    </div>
  );
}
