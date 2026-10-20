"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { api, errorMessageOrRaw } from "@/app/dashboard/ui";
import { SectionCardSkeleton } from "@/app/dashboard/page-chrome";
import { useFeatureLocked } from "@/components/feature-lock";
import type { ConnectionLite } from "./connection-lite";

const STORAGE_KEY = "wp-manager:selected-connection";

export type WpManagerConnection = ConnectionLite & {
  baseUrl?: string;
  pluginVersion?: string | null;
  /** The capability set the plugin's last handshake reported; null before it, and for REST stores. */
  pluginCapabilities?: Record<string, unknown> | null;
  /** The store's own money unit — how its prices are denominated (issue #943). */
  currencyUnit?: "rial" | "toman";
  pushStock?: boolean;
  pushPrices?: boolean;
  syncProducts?: boolean;
  lastError?: string | null;
  lastSyncAt?: string | null;
  lastCatalogueSyncAt?: string | null;
  lastOrderSyncAt?: string | null;
  lastCustomerSyncAt?: string | null;
  lastContentSyncAt?: string | null;
  lastPluginSeenAt?: string | null;
  transportHealth?: { state: string; lastSeenAt: string | null; message?: string };
  pluginHealth?: Record<string, unknown>;
};

interface WpStoreContextValue {
  connections: WpManagerConnection[] | null;
  /**
   * Set when the connections fetch itself failed. An API error used to be
   * flattened into `connections = []`, and every section then told the owner
   * "no store is connected" — hiding the stores that exist behind a network
   * blip (issue #943). Hosts must render this with a retry, not an empty
   * state.
   */
  connectionsError: string | null;
  selectedId: string;
  selectedConnection: WpManagerConnection | null;
  setSelectedId: (id: string) => void;
  reloadConnections: () => Promise<void>;
}

const WpStoreContext = createContext<WpStoreContextValue | null>(null);

export function WpStoreProvider({ children }: { children: React.ReactNode }) {
  const locked = useFeatureLocked();
  const [connections, setConnections] = useState<WpManagerConnection[] | null>(() => (locked ? [] : null));
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
  const [selectedId, setSelectedIdState] = useState("");
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  const choose = useCallback(
    (id: string, connectionsForFallback = connections) => {
      const safeId = connectionsForFallback?.some((connection) => connection.id === id) ? id : connectionsForFallback?.[0]?.id ?? "";
      setSelectedIdState(safeId);
      if (safeId) localStorage.setItem(STORAGE_KEY, safeId);
      const params = new URLSearchParams(searchParams.toString());
      if (safeId) params.set("store", safeId);
      else params.delete("store");
      router.replace(`${pathname}${params.toString() ? `?${params.toString()}` : ""}`, { scroll: false });
    },
    [connections, pathname, router, searchParams],
  );

  const reloadConnections = useCallback(async () => {
    if (locked) {
      setConnections([]);
      setConnectionsError(null);
      setSelectedIdState("");
      return;
    }
    const res = await api<{ connections: WpManagerConnection[]; error?: string }>(
      "/api/integrations/connections?provider=woocommerce",
    );
    if (!res.ok) {
      // Keep whatever list is already on screen and name the failure: a
      // transient 500 must not turn "your two stores" into "no store
      // connected" and must not leave the sections rendering stale pickers
      // with no explanation.
      setConnectionsError(
        errorMessageOrRaw(String(res.data?.error ?? "")) || "دریافت فهرست فروشگاه‌های متصل ممکن نشد.",
      );
      setConnections((previous) => previous ?? []);
      return;
    }
    setConnectionsError(null);
    const list = res.data.connections;
    setConnections(list);
    const querySelected = searchParams.get("store") ?? "";
    const preferred = querySelected || (typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) ?? "" : "");
    const next = list.some((connection) => connection.id === preferred) ? preferred : list[0]?.id ?? "";
    setSelectedIdState(next);
    if (next) localStorage.setItem(STORAGE_KEY, next);
  }, [locked, searchParams]);

  useEffect(() => {
    void reloadConnections();
  }, [reloadConnections]);

  const selectedConnection = useMemo(
    () => connections?.find((connection) => connection.id === selectedId) ?? null,
    [connections, selectedId],
  );

  const value = useMemo(
    () => ({ connections, connectionsError, selectedId, selectedConnection, setSelectedId: choose, reloadConnections }),
    [connections, connectionsError, selectedId, selectedConnection, choose, reloadConnections],
  );

  return (
    <WpStoreContext.Provider value={value}>
      {connections === null ? <SectionCardSkeleton rows={6} label="در حال خواندن فروشگاه‌های متصل" /> : children}
    </WpStoreContext.Provider>
  );
}

export function useWpStore() {
  const context = useContext(WpStoreContext);
  if (!context) throw new Error("useWpStore must be used inside WpStoreProvider");
  return context;
}
