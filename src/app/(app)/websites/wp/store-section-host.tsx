"use client";

/**
 * Host for the existing WooCommerce store sections
 * (CatalogueSection / StoreOrdersSection / TaxonomiesSection) inside the WP
 * Manager app: pick a connection, then render the section against it. Those
 * components accept a `connectionId` prop so every WP Manager surface can use
 * the same selected store; the connection is chosen once here.
 */
import { useCallback, useState } from "react";
import Link from "next/link";
import { PlugIcon } from "lucide-react";
import { api, ErrorBox, errorMessageOrRaw } from "@/app/dashboard/ui";
import { cardClass, SectionCardSkeleton } from "@/app/dashboard/page-chrome";
import { Button } from "@/components/ui/button";
import { CatalogueSection, StoreOrdersSection } from "./woo-store-sections";
import { TaxonomiesSection } from "./taxonomies-section";
import { PluginWaitNote } from "./plugin-wait-note";
import { ConnectionPicker } from "./connection-lite";
import { describeWooError } from "./woo-errors";
import { useWpStore, type WpManagerConnection as Connection } from "./wp-store-context";

function useConnectionHost() {
  const { connections, connectionsError, selectedId, selectedConnection, setSelectedId, reloadConnections } = useWpStore();
  const [busy, setBusy] = useState(false);
  const [callResult, setCallResult] = useState("");
  const [notice, setNotice] = useState("");

  const call = useCallback(
    async <T extends Record<string, unknown>>(
      path: string,
      method = "POST",
      body?: unknown,
      options?: { successNotice?: string | null },
    ): Promise<T | null> => {
      setBusy(true);
      setCallResult("");
      setNotice("");
      const res = await api<T>(path, { method, body: body ? JSON.stringify(body) : undefined });
      setBusy(false);
      if (!res.ok) {
        // The store APIs answer with stable codes (issue #943); the shared
        // vocabulary turns each one into a sentence before the raw text
        // fallback, so a refused push explains itself instead of showing a
        // slug like `push_prices_disabled`.
        const code = String(res.data?.error ?? "");
        setCallResult(describeWooError(code) || errorMessageOrRaw(code) || "خطا در اجرای عملیات");
        return null;
      }
      // The success wording follows what actually happened (issue #943
      // review): only a response that says `queued: true` — a plugin-mode
      // sync or an outbox write — gets the «queued, not done» confirmation.
      // A REST sync completes inline and its caller renders the real
      // outcome, so the panel must not claim it is waiting in a queue;
      // callers that speak for themselves pass `successNotice: null`, and
      // immediate writes (a settings PATCH) get a plain «recorded».
      if (options && "successNotice" in options) {
        setNotice(options.successNotice ?? "");
      } else if (res.data?.queued === true) {
        setNotice("درخواست در صف قرار گرفت و با اجرای بعدی به فروشگاه می‌رود؛ وضعیت ارسال روی خود ردیف و در «صف و رویدادها» دیده می‌شود.");
      } else {
        setNotice("تغییرات ثبت شد.");
      }
      return res.data;
    },
    [],
  );

  return {
    connections,
    connectionsError,
    busy,
    callResult,
    notice,
    selectedId,
    selectedConnection,
    setSelectedId,
    reloadConnections,
    call,
  };
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

/**
 * The connections fetch failed. Distinct from "no store is connected" on
 * purpose (issue #943): an API error used to arrive here as an empty list
 * and the owner was told they had no store — with no way to retry except a
 * full page reload.
 */
function ConnectionsError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className={`${cardClass} flex flex-col items-center gap-3 px-4 py-10 text-center sm:px-5`}>
      <span className="flex size-11 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
        <PlugIcon aria-hidden="true" className="size-5" />
      </span>
      <p className="max-w-md text-sm leading-6 text-muted-foreground" role="alert">
        {message}
      </p>
      <Button type="button" size="sm" variant="outline" onClick={onRetry}>
        تلاش دوباره
      </Button>
    </div>
  );
}

function HostFrame({
  connections,
  connectionsError,
  onRetryConnections,
  selectedId,
  setSelectedId,
  callResult,
  notice,
  children,
}: {
  connections: Connection[] | null;
  connectionsError: string | null;
  onRetryConnections: () => void;
  selectedId: string;
  setSelectedId: (id: string) => void;
  callResult: string;
  notice: string;
  children: React.ReactNode;
}) {
  if (connections === null) return <SectionCardSkeleton rows={6} />;
  if (connections.length === 0 && connectionsError) {
    return <ConnectionsError message={connectionsError} onRetry={onRetryConnections} />;
  }
  if (connections.length === 0) return <EmptyConnections />;
  return (
    <div className="space-y-4">
      {/* One store needs no picker — a select with a single option is a
          control that cannot do anything. Name the store instead. */}
      <div className={`${cardClass} flex flex-wrap items-center gap-3 p-4`}>
        {connections.length > 1 ? (
          <ConnectionPicker embedded connections={connections} value={selectedId} onChange={setSelectedId} />
        ) : (
          <p className="min-w-0 text-sm text-muted-foreground">
            فروشگاه: <span className="font-medium text-foreground">{connections[0].name}</span>
          </p>
        )}
      </div>
      {/* Stores are on screen but the last refresh failed — say so above the
          section rather than silently showing possibly stale pickers. */}
      {connectionsError ? <ErrorBox>{connectionsError}</ErrorBox> : null}
      {selectedId ? (
        <>
          <PluginWaitNote connections={connections} selectedId={selectedId} />
          {children}
          {notice ? (
            <p role="status" className="text-xs text-teal-700 dark:text-teal-300">
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
  const { connections, connectionsError, busy, callResult, notice, selectedId, selectedConnection, setSelectedId, reloadConnections, call } =
    useConnectionHost();
  return (
    <HostFrame
      connections={connections}
      connectionsError={connectionsError}
      onRetryConnections={() => void reloadConnections()}
      selectedId={selectedId}
      setSelectedId={setSelectedId}
      callResult={callResult}
      notice={notice}
    >
      <CatalogueSection connectionId={selectedId} busy={busy} call={call} connection={selectedConnection} />
    </HostFrame>
  );
}

export function OrdersSectionHost() {
  const { connections, connectionsError, busy, callResult, notice, selectedId, setSelectedId, reloadConnections, call } = useConnectionHost();
  return (
    <HostFrame
      connections={connections}
      connectionsError={connectionsError}
      onRetryConnections={() => void reloadConnections()}
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
  const { connections, connectionsError, callResult, notice, selectedId, setSelectedId, reloadConnections } = useConnectionHost();
  return (
    <HostFrame
      connections={connections}
      connectionsError={connectionsError}
      onRetryConnections={() => void reloadConnections()}
      selectedId={selectedId}
      setSelectedId={setSelectedId}
      callResult={callResult}
      notice={notice}
    >
      <TaxonomiesSection connectionId={selectedId} />
    </HostFrame>
  );
}
