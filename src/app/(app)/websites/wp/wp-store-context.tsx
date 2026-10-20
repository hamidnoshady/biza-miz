"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { api } from "@/app/dashboard/ui";
import { SectionCardSkeleton } from "@/app/dashboard/page-chrome";
import { useFeatureLocked } from "@/components/feature-lock";
import type { ConnectionLite } from "./connection-lite";

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

interface WpStoreContextValue {
  connections: WpManagerConnection[] | null;
  selectedId: string;
  selectedConnection: WpManagerConnection | null;
  connectionsError: string | null;
  setSelectedId: (id: string) => void;
  reloadConnections: () => Promise<void>;
}

const WpStoreContext = createContext<WpStoreContextValue | null>(null);

export function WpStoreProvider({ children }: { children: React.ReactNode }) {
  const locked = useFeatureLocked();
  const [connections, setConnections] = useState<WpManagerConnection[] | null>(() => (locked ? [] : null));
  const [selectedId, setSelectedIdState] = useState("");
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
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
      setConnectionsError(null);
      setConnections([]);
      setSelectedIdState("");
      return;
    }
    setConnectionsError(null);
    const res = await api<{ connections?: WpManagerConnection[] }>("/api/integrations/connections?provider=woocommerce");
    if (res.aborted) return;
    if (!res.ok) {
      const message = res.status === 401
        ? "نشست شما معتبر نیست یا منقضی شده است؛ دوباره وارد شوید."
        : res.status === 403
          ? "برای دیدن اتصال‌های فنی فروشگاه، مجوز مشاهدهٔ اتصال‌ها لازم است."
          : res.status === 0
            ? "ارتباط با سرور برقرار نشد؛ اتصال اینترنت را بررسی و دوباره تلاش کنید."
            : "فهرست فروشگاه‌های متصل بارگیری نشد؛ دوباره تلاش کنید.";
      setConnectionsError(message);
      // Release the first-load skeleton so the screen can show a retry rather
      // than misreporting a failed GET as a genuinely empty store list. Keep a
      // previously loaded list/selection visible if a refresh later fails.
      setConnections((current) => current ?? []);
      return;
    }
    if (!Array.isArray(res.data.connections)) {
      setConnectionsError("پاسخ فهرست اتصال‌ها معتبر نبود؛ دوباره تلاش کنید.");
      setConnections((current) => current ?? []);
      return;
    }
    const list = res.data.connections;
    setConnectionsError(null);
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
    () => ({ connections, selectedId, selectedConnection, connectionsError, setSelectedId: choose, reloadConnections }),
    [connections, selectedId, selectedConnection, connectionsError, choose, reloadConnections],
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
