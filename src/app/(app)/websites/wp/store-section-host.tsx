"use client";

/**
 * Host for the existing WooCommerce store sections
 * (CatalogueSection / StoreOrdersSection / TaxonomiesSection) inside the WP
 * Manager app: pick a connection, then render the section against it. Those
 * components accept a `connectionId` prop so every WP Manager surface can use
 * the same selected store; the connection is chosen once here.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PlugIcon } from "lucide-react";
import { api, ErrorBox, errorMessageOrRaw } from "@/app/dashboard/ui";
import { cardClass, SectionCardSkeleton } from "@/app/dashboard/page-chrome";
import { Button } from "@/components/ui/button";
import { CatalogueSection } from "./catalogue-section";
import { StoreOrdersSection } from "./woo-store-sections";
import { TaxonomiesSection } from "./taxonomies-section";
import { PluginWaitNote } from "./plugin-wait-note";
import { ConnectionPicker, connectionOptionLabel } from "./connection-lite";
import { describeWooError } from "./woo-errors";
import { useWpStore, type WpManagerConnection as Connection, type WpStoreLoadFailure } from "./wp-store-context";
import { WpStoreRefreshError } from "./wp-store-states";

/** The confirmation a successful write earns, from what the response said happened (#944 / OVR-08). */
export function describeCallSuccess(data: Record<string, unknown> | null | undefined): string {
  const result = typeof data?.result === "string" ? data.result : "";
  if (result === "partial" || (typeof data?.contentError === "string" && data.contentError)) {
    return "عملیات ناقص انجام شد؛ بخشی از آن با خطا مواجه شد. جزئیات را در صف همگام‌سازی ببینید.";
  }
  if (result === "queued" || data?.queued === true) {
    return "درخواست در صف قرار گرفت و با اجرای بعدی به فروشگاه می‌رود.";
  }
  return "عملیات انجام شد.";
}

function useConnectionHost() {
  const { connections, loadState, loadError, selectedId, setSelectedId, reloadConnections } = useWpStore();
  const [busy, setBusy] = useState(false);
  const [callResult, setCallResult] = useState("");
  const [notice, setNotice] = useState("");
  const inFlight = useRef(false);

  // A notice or error belongs to the store it was earned on: switching
  // stores clears both so store B never wears store A's message.
  useEffect(() => {
    setCallResult("");
    setNotice("");
  }, [selectedId]);

  const call = useCallback(
    async <T extends Record<string, unknown>>(
      path: string,
      method = "POST",
      body?: unknown,
      options?: { successNotice?: string | null },
    ): Promise<T | null> => {
      // Duplicate-submit protection: a second click while the first request
      // is still out would enqueue the same job twice.
      if (inFlight.current) return null;
      inFlight.current = true;
      setBusy(true);
      setCallResult("");
      setNotice("");
      const res = await api<T>(path, { method, body: body ? JSON.stringify(body) : undefined });
      inFlight.current = false;
      setBusy(false);
      if (!res.ok) {
        // The store APIs answer with stable codes (#943); the shared
        // vocabulary turns each one into a sentence before the raw fallback.
        const code = String(res.data?.error ?? "");
        setCallResult(describeWooError(code) || errorMessageOrRaw(code) || "خطا در اجرای عملیات");
        return null;
      }
      // The response says whether the work was queued for the plugin,
      // finished over REST, or only partly succeeded — the confirmation
      // follows it rather than claiming «در صف» for all three. Callers that
      // render their own precise outcome (the products sync, #943) pass
      // `successNotice: null` and speak for themselves.
      if (options && "successNotice" in options) {
        setNotice(options.successNotice ?? "");
      } else {
        setNotice(describeCallSuccess(res.data));
      }
      return res.data;
    },
    [],
  );

  const refreshFailure = loadState === "error" && loadError ? loadError : null;

  return { connections, refreshFailure, reloadConnections, busy, callResult, notice, selectedId, setSelectedId, call };
}

/**
 * No store yet. The old copy named «اتصال فروشگاه» — a section that no longer
 * exists in this app, since every technical connection moved to the
 * «اتصال‌های فنی» hub — so it told the owner to open something they could not
 * find. Name the real place, and link to it.
 */
function EmptyConnections({ children }: { children?: React.ReactNode }) {
  return (
    <div className={`${cardClass} flex flex-col items-center gap-3 px-4 py-10 text-center sm:px-5`}>
      <span className="flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <PlugIcon aria-hidden="true" className="size-5" />
      </span>
      <p className="max-w-md text-sm leading-6 text-muted-foreground">
        {children ??
          "هنوز فروشگاه ووکامرسی متصل نیست. اتصال فروشگاه در «اتصال‌های فنی» انجام می‌شود؛ پس از اتصال و نخستین همگام‌سازی، دسته‌بندی‌ها و ویژگی‌ها اینجا دیده می‌شوند."}
      </p>
      <Button asChild size="sm" variant="outline">
        <Link href="/settings/connections?tab=woocommerce">اتصال فروشگاه ووکامرس</Link>
      </Button>
    </div>
  );
}

function HostFrame({
  connections,
  refreshFailure,
  reloadConnections,
  selectedId,
  setSelectedId,
  callResult,
  notice,
  children,
}: {
  connections: Connection[] | null;
  refreshFailure: WpStoreLoadFailure | null;
  reloadConnections: () => Promise<void>;
  selectedId: string;
  setSelectedId: (id: string) => void;
  callResult: string;
  notice: string;
  children: React.ReactNode;
}) {
  if (connections === null) return <SectionCardSkeleton rows={6} />;
  // «هنوز فروشگاهی متصل نیست» only after a list that really came back empty;
  // a failed refresh with no earlier list is the provider's error screen.
  if (connections.length === 0) {
    return (
      <div className="space-y-4">
        {refreshFailure ? <WpStoreRefreshError failure={refreshFailure} onRetry={() => void reloadConnections()} /> : null}
        <EmptyConnections />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {refreshFailure ? <WpStoreRefreshError failure={refreshFailure} onRetry={() => void reloadConnections()} /> : null}
      {/* One store needs no picker — a select with a single option is a
          control that cannot do anything. Name the store instead. */}
      <div className={`${cardClass} flex flex-wrap items-center gap-3 p-4`}>
        {connections.length > 1 ? (
          <ConnectionPicker embedded connections={connections} value={selectedId} onChange={setSelectedId} />
        ) : (
          <p className="min-w-0 text-sm text-muted-foreground">
            فروشگاه: <span className="font-medium text-foreground">{connectionOptionLabel(connections[0])}</span>
          </p>
        )}
      </div>
      {selectedId ? (
        <>
          <PluginWaitNote connections={connections} selectedId={selectedId} />
          {children}
          {notice ? (
            <p role="status" aria-live="polite" className="text-xs text-teal-700 dark:text-teal-300">
              {notice}
            </p>
          ) : null}
          <ErrorBox>{callResult}</ErrorBox>
        </>
      ) : null}
    </div>
  );
}

export function ProductsSectionHost() {
  const { connections, refreshFailure, reloadConnections, busy, callResult, notice, selectedId, setSelectedId, call } = useConnectionHost();
  return (
    <HostFrame
      connections={connections}
      refreshFailure={refreshFailure}
      reloadConnections={reloadConnections}
      selectedId={selectedId}
      setSelectedId={setSelectedId}
      callResult={callResult}
      notice={notice}
    >
      <CatalogueSection connectionId={selectedId} busy={busy} call={call} />
    </HostFrame>
  );
}

export function OrdersSectionHost() {
  const { connections, refreshFailure, reloadConnections, busy, callResult, notice, selectedId, setSelectedId, call } = useConnectionHost();
  return (
    <HostFrame
      connections={connections}
      refreshFailure={refreshFailure}
      reloadConnections={reloadConnections}
      selectedId={selectedId}
      setSelectedId={setSelectedId}
      callResult={callResult}
      notice={notice}
    >
      <StoreOrdersSection connectionId={selectedId} busy={busy} call={call} />
    </HostFrame>
  );
}

export function TaxonomiesSectionHost() {
  const { connections, refreshFailure, reloadConnections, callResult, notice, selectedId, setSelectedId } = useConnectionHost();
  return (
    <HostFrame
      connections={connections}
      refreshFailure={refreshFailure}
      reloadConnections={reloadConnections}
      selectedId={selectedId}
      setSelectedId={setSelectedId}
      callResult={callResult}
      notice={notice}
    >
      <TaxonomiesSection connectionId={selectedId} />
    </HostFrame>
  );
}
