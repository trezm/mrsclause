import { createContext, useContext } from "react";
import type { Dashboard, Item, Recipient } from "../shared/types";

export interface AppState {
  data: Dashboard;
  refresh: () => Promise<void>;
  /** Runs an API call, shows any error as a toast, then reloads the dashboard. */
  act: (fn: () => Promise<unknown>, success?: string) => Promise<boolean>;
  toast: (message: string, tone?: "info" | "error") => void;
  openItem: (id: string) => void;
  openPerson: (id: string | "new") => void;
}

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside AppContext");
  return ctx;
}

export function useLookups() {
  const { data } = useApp();
  const items = new Map<string, Item>(data.items.map((i) => [i.id, i]));
  const people = new Map<string, Recipient>(data.recipients.map((r) => [r.id, r]));
  return { items, people };
}
