"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { api } from "@/app/dashboard/ui";
import { cardClass, SectionCardSkeleton } from "@/app/dashboard/page-chrome";
import { Button } from "@/components/ui/button";
import { useFeatureLocked } from "@/components/feature-lock";
import type { ConnectionLite } from "./connection-lite";
import type { WpSectionCaps } from "./wp-routes";

const STORAGE_KEY = "wp-manager:selected-connection";

export type WpManagerConnection = ConnectionLite & {
  baseUrl?: string;
  pluginVersion?: string | null;
  /** The capability set the plugin's last handshake reported; null before it, and for REST stores. */
  pluginCapabilities?: Record<string, unknown> | null;
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

/**
 * The connection list's load state, separately from its contents (#944
 * OVR-02): `loading` (nothing read yet), `ready` (a list was read — empty is
 * a *successful* answer, told apart by `connections.length`), and `error`
 * (the read failed and there is no list to fall back on). A failed *refresh*
 * of an already-read list stays `ready` and reports through
 * `connectionsError` instead, so the store the owner is looking at never
 * vanishes into a «connect a store» prompt because the network hiccuped.
 */
export type WpConnectionsState = "loading" | "ready" | "error";

/** What to tell the owner for each way the connection-list read can fail. */
export function wpConnectionsErrorMessage(status: number): string {
  if (status === 401) return "نشست شما پایان یافته است؛ صفحه را تازه کنید و دوباره وارد شوید.";
  if (status === 403) return "به فهرست فروشگاه‌ها دسترسی ندارید، یا قابلیت اتصال فروشگاه برای کسب‌وکار شما فعال نیست.";
  if (status === 0) return "ارتباط با سرور برقرار نشد؛ اتصال شبکه را بررسی کنید و دوباره تلاش کنید.";
  if (status >= 500) return "خواندن فهرست فروشگاه‌ها در سرور با خطا مواجه شد؛ کمی بعد دوباره تلاش کنید.";
  return "خواندن فهرست فروشگاه‌ها ناموفق بود.";
}

interface WpStoreContextValue {
  connections: WpManagerConnection[] | null;
  connectionsState: WpConnectionsState;
  /** Localized reason the last read failed; null after any successful read. */
  connectionsError: string | null;
  /** True while a (re)read of the connection list is in flight. */
  connectionsLoading: boolean;
  /** `woocommerce.sync` — the member may run syncs and queue actions. */
  canSync: boolean;
  /** `woocommerce.manage` — the member may change store content. */
  canEdit: boolean;
  selectedId: string;
  selectedConnection: WpManagerConnection | null;
  setSelectedId: (id: string) => void;
  reloadConnections: () => Promise<void>;
}

const WpStoreContext = createContext<WpStoreContextValue | null>(null);

export function WpStoreProvider({ children, caps }: { children: React.ReactNode; caps: WpSectionCaps }) {
  const locked = useFeatureLocked();
  const [connections, setConnections] = useState<WpManagerConnection[] | null>(() => (locked ? [] : null));
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
  const [connectionsLoading, setConnectionsLoading] = useState(false);
  const [selectedId, setSelectedIdState] = useState("");
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  // Sequencing for overlapping reloads (#944 OVR-05) and a live read of the
  // current selection: a reload's closure can be older than a store the
  // owner picked while it was in flight, and the fresh list must not rewind
  // that pick when it lands.
  const reloadSeqRef = useRef(0);
  const selectedIdRef = useRef("");

  const choose = useCallback(
    (id: string, connectionsForFallback = connections) => {
      const safeId = connectionsForFallback?.some((connection) => connection.id === id) ? id : connectionsForFallback?.[0]?.id ?? "";
      selectedIdRef.current = safeId;
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
      selectedIdRef.current = "";
      setSelectedIdState("");
      return;
    }
    const seq = ++reloadSeqRef.current;
    setConnectionsLoading(true);
    const res = await api<{ connections: WpManagerConnection[] }>("/api/integrations/connections?provider=woocommerce");
    // A newer reload supersedes this response; an aborted read is not a
    // failure. Whichever is current when the latest answer lands wins.
    if (seq !== reloadSeqRef.current || res.aborted) return;
    setConnectionsLoading(false);
    if (!res.ok) {
      // A failed read is not an empty account. Whatever list we already
      // have stays on screen (stale beats vanished) and the failure is
      // reported with a retry — previously `setConnections([])` rendered
      // the «no store connected» setup prompt on any 403/500/network error.
      setConnectionsError(wpConnectionsErrorMessage(res.status));
      return;
    }
    setConnectionsError(null);
    const list = res.data.connections;
    setConnections(list);
    const querySelected = searchParams.get("store") ?? "";
    const stored = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) ?? "" : "";
    const preferred = selectedIdRef.current || querySelected || stored;
    const next = list.some((connection) => connection.id === preferred) ? preferred : list[0]?.id ?? "";
    selectedIdRef.current = next;
    setSelectedIdState(next);
    if (next) localStorage.setItem(STORAGE_KEY, next);
  }, [locked, searchParams]);

  useEffect(() => {
    void reloadConnections();
  }, [reloadConnections]);

  const connectionsState: WpConnectionsState =
    connections !== null ? "ready" : connectionsError ? "error" : "loading";

  const selectedConnection = useMemo(
    () => connections?.find((connection) => connection.id === selectedId) ?? null,
    [connections, selectedId],
  );

  const value = useMemo(
    () => ({
      connections,
      connectionsState,
      connectionsError,
      connectionsLoading,
      canSync: caps.canSync,
      canEdit: caps.canEdit,
      selectedId,
      selectedConnection,
      setSelectedId: choose,
      reloadConnections,
    }),
    [connections, connectionsState, connectionsError, connectionsLoading, caps, selectedId, selectedConnection, choose, reloadConnections],
  );

  return (
    <WpStoreContext.Provider value={value}>
      {connections === null ? (
        connectionsError ? (
          <div className={`${cardClass} px-4 py-8 text-center sm:px-5`} role="alert">
            <p className="text-sm font-medium text-foreground">فهرست فروشگاه‌های متصل خوانده نشد.</p>
            <p className="mt-1 text-xs leading-6 text-muted-foreground">{connectionsError}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              disabled={connectionsLoading}
              onClick={() => void reloadConnections()}
            >
              {connectionsLoading ? "در حال تلاش…" : "تلاش دوباره"}
            </Button>
          </div>
        ) : (
          <SectionCardSkeleton rows={6} label="در حال خواندن فروشگاه‌های متصل" />
        )
      ) : (
        <>
          {connectionsError ? (
            <div className={`${cardClass} mb-4 flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5`} role="alert">
              <p className="text-xs leading-6 text-red-700 dark:text-red-300">
                تازه‌سازی فهرست فروشگاه‌ها ناموفق بود؛ آخرین فهرست خوانده‌شده نمایش داده می‌شود. {connectionsError}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="ms-auto"
                disabled={connectionsLoading}
                onClick={() => void reloadConnections()}
              >
                {connectionsLoading ? "در حال تلاش…" : "تلاش دوباره"}
              </Button>
            </div>
          ) : null}
          {children}
        </>
      )}
    </WpStoreContext.Provider>
  );
}

export function useWpStore() {
  const context = useContext(WpStoreContext);
  if (!context) throw new Error("useWpStore must be used inside WpStoreProvider");
  return context;
}
