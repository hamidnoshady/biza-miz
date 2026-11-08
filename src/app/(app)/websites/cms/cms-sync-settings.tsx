"use client";

/**
 * «تنظیمات همگام‌سازی» — what the POS pushes to the CMS site, and the queue
 * it pushes through (Phase 38, issues #379 / #381).
 *
 * Two things, in the order an owner meets them:
 *
 *   1. **What goes to the site.** Two independent switches — prices, stock —
 *      and the product list where each row is marked to go (default: none).
 *   2. **The queue.** Pending / failed / stopped rows, each with «تلاش مجدد»,
 *      and «همگام‌سازی اکنون» for the impatient.
 *
 * The connection itself — address, domain, key, test and disconnect — is
 * deliberately not here: every technical connection in the product lives in
 * the «اتصال‌های فنی» hub, and this section links there when no site is
 * connected yet. Content — posts, product copy — is written in this manager's
 * «محتوا» and «فروشگاه» sections and by the assistant.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PlugZapIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatJalali } from "@/lib/jalali";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { WEBSITE_ERROR_LABELS } from "@/lib/website/adapter";
import { WEBSITE_OUTBOX_KIND_LABELS, WEBSITE_OUTBOX_STATUS_LABELS } from "@/lib/website/sync";
import {
  DataTable,
  DataTableBody,
  DataTableHead,
  DataTableRow,
  Td,
  Th,
} from "@/app/dashboard/data-table";
import { EmptyState, LoadingSkeleton, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, errorMessageOrRaw, InfoBox, inputClass } from "@/app/dashboard/ui";

interface ConnectionSummary {
  id: string;
  adapterKey: "payload" | "mock";
  siteDomain: string;
  baseUrl: string;
  siteCurrency: string;
  status: "active" | "disabled";
  lastCheckedAt: string | null;
  lastError: string | null;
  pushPrices: boolean;
  pushStock: boolean;
  productScope: "selected" | "all";
  syncLocationId: string | null;
}

interface QueueSummary {
  pending: number;
  failed: number;
  dead: number;
  sent24h: number;
}

interface CatalogRow {
  localKind: "item" | "menu_item";
  localId: string;
  name: string;
  sku: string | null;
  priceRial: number | null;
  syncEnabled: boolean;
  remoteId: string | null;
  lastPushedAt: string | null;
  lastPushedPriceRial: number | null;
  lastPushedStock: number | null;
}

interface QueueRow {
  id: string;
  kind: keyof typeof WEBSITE_OUTBOX_KIND_LABELS;
  productName: string | null;
  status: "pending" | "processing" | "sent" | "failed" | "dead";
  attempts: number;
  nextAttemptAt: string;
  error: string | null;
  sentAt: string | null;
}

const LOCAL_KIND_LABELS = { menu_item: "منو", item: "کالا" } as const;

/**
 * An outbox row's `error` is the adapter's `"<code>: <detail>"` (or a bare
 * code). The code half has a Persian label; the detail half is context for
 * the owner (which remote id, which field) — show the label, keep the detail,
 * and never paste an English code raw onto a Persian screen.
 */
function describeError(raw: string | null | undefined): string {
  if (!raw) return "";
  const separator = raw.indexOf(":");
  const code = separator === -1 ? raw : raw.slice(0, separator).trim();
  const detail = separator === -1 ? "" : raw.slice(separator + 1).trim();
  const label = (WEBSITE_ERROR_LABELS as Record<string, string>)[code] ?? errorMessageOrRaw(code);
  return detail ? `${label} (${detail})` : label;
}

function statusTone(status: QueueRow["status"]): "active" | "positive" | "neutral" | "danger" {
  if (status === "sent") return "positive";
  if (status === "dead") return "danger";
  if (status === "failed") return "active";
  return "neutral";
}

export function CmsSyncSettings() {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [connection, setConnection] = useState<ConnectionSummary | null>(null);
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Bumped when something outside the queue's own controls may have changed it. */
  const [queueRefresh, setQueueRefresh] = useState(0);

  const load = useCallback(async () => {
    const res = await api<{ enabled: boolean; connection: ConnectionSummary | null; connections?: ConnectionSummary[]; queue: QueueSummary | null }>(
      selectedId ? `/api/connections/website?connectionId=${selectedId}` : "/api/connections/website",
    );
    if (!res.ok) {
      setError(errorMessageOrRaw((res.data as { error?: string }).error));
      setLoading(false);
      return;
    }
    const sites = res.data.connections ?? (res.data.connection ? [res.data.connection] : []);
    setConnections(sites);
    const current = selectedId
      ? res.data.connection
      : sites.find((site) => site.status === "active") ?? res.data.connection;
    setEnabled(res.data.enabled);
    setConnection(current);
    if (!selectedId && current) setSelectedId(current.id);
    setQueue(res.data.queue);
    setLoading(false);
  }, [selectedId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * A product's mark changes the queue (the mark enqueues an upsert), so the
   * products list, the queue's counts and its rows must all move together —
   * the queue must never still say «صف خالی است» under a «در صف» badge.
   */
  const refreshAfterMark = useCallback(async () => {
    await load();
    setQueueRefresh((n) => n + 1);
  }, [load]);

  if (loading) return <LoadingSkeleton label="در حال بارگذاری همگام‌سازی وب‌سایت…" />;

  return (
    <div className="space-y-4">
      <ErrorBox>{error}</ErrorBox>
      {!enabled || !connection ? (
        <SectionCard
          title="همگام‌سازی با سایت"
          description="سایتی وصل نیست. ابتدا سایت را در «اتصال‌های فنی» وصل کنید — همین‌که وصل شد، اینجا مشخص می‌کنید قیمت و موجودی کدام کالا به سایت برود."
        >
          <Button asChild variant="outline" className="px-4">
            <Link href="/settings/connections?tab=website">
              <PlugZapIcon className="size-4" />
              اتصال سایت
            </Link>
          </Button>
        </SectionCard>
      ) : (
        <>
          {connections.length > 1 ? (
            <SectionCard title="سایت مقصد" description="هر سایت علامت‌ها و صف مستقل خودش را دارد.">
              <select
                className={`${inputClass} max-w-sm`}
                aria-label="انتخاب سایت"
                value={selectedId ?? connection.id}
                onChange={(e) => setSelectedId(e.target.value)}
              >
                {connections.map((site) => (
                  <option key={site.id} value={site.id}>{site.siteDomain || site.baseUrl}{site.status === "active" ? "" : " (غیرفعال)"}</option>
                ))}
              </select>
            </SectionCard>
          ) : null}
          <SyncSettingsCard connection={connection} onChange={load} />
          <ProductsCard connectionId={connection.id} onChange={refreshAfterMark} />
          <QueueCard connectionId={connection.id} summary={queue} onChange={load} refreshKey={queueRefresh} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sync switches
// ---------------------------------------------------------------------------

function SyncSettingsCard({ connection, onChange }: { connection: ConnectionSummary; onChange: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const res = await api("/api/connections/website/settings", { method: "PATCH", body: JSON.stringify({ ...body, connectionId: connection.id }) });
    setBusy(false);
    if (!res.ok) {
      // The switch is controlled by the reloaded connection, so it snaps back
      // on failure — the owner needs to be told why it refused.
      setError(errorMessageOrRaw((res.data as { error?: string }).error));
    }
    await onChange();
  }

  return (
    <SectionCard
      title="چه چیزی به سایت می‌رود"
      description="یک‌طرفه: از این برنامه به سایت. سایت ویترین است؛ منبع حقیقت قیمت و موجودی همین‌جاست."
    >
      <ErrorBox>{error}</ErrorBox>
      <div className="space-y-3 text-sm">
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            className="size-4"
            checked={connection.pushPrices}
            disabled={busy}
            onChange={(e) => patch({ pushPrices: e.target.checked })}
          />
          <span>ارسال قیمت‌ها به سایت</span>
        </label>
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            className="size-4"
            checked={connection.pushStock}
            disabled={busy}
            onChange={(e) => patch({ pushStock: e.target.checked })}
          />
          <span>ارسال موجودی به سایت</span>
        </label>
        <label className="flex items-center gap-3">
          <span className="text-muted-foreground">کدام محصول‌ها:</span>
          <select
            className={`${inputClass} max-w-xs`}
            value={connection.productScope}
            disabled={busy}
            onChange={(e) => patch({ productScope: e.target.value })}
          >
            <option value="selected">فقط محصول‌های علامت‌خورده</option>
            <option value="all">همهٔ محصول‌های علامت‌خورده یا قبلاً ارسال‌شده</option>
          </select>
        </label>
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

function ProductsCard({ connectionId, onChange }: { connectionId: string; onChange: () => Promise<void> }) {
  const money = useMoney();
  const [rows, setRows] = useState<CatalogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    const res = await api<{ products: CatalogRow[] }>(`/api/connections/website/products?connectionId=${connectionId}`);
    if (!res.ok) {
      setError(errorMessageOrRaw((res.data as { error?: string }).error));
      setRows([]);
      return;
    }
    setRows(res.data.products);
  }, [connectionId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(row: CatalogRow, enabled: boolean) {
    setBusyId(row.localId);
    const res = await api("/api/connections/website/products", {
      method: "POST",
      body: JSON.stringify({ localKind: row.localKind, localId: row.localId, enabled, connectionId }),
    });
    setBusyId(null);
    if (!res.ok) setError(errorMessageOrRaw((res.data as { error?: string }).error));
    // The mark also enqueues (or stops) an outbox row, so both lists refresh.
    await Promise.all([load(), onChange()]);
  }

  const visible = (rows ?? []).filter((r) => !filter || r.name.includes(filter) || (r.sku ?? "").includes(filter));
  const marked = (rows ?? []).filter((r) => r.syncEnabled).length;

  return (
    <SectionCard
      title="محصول‌ها"
      description={`${toPersianDigits(String(marked))} محصول علامت‌خورده. محصولی که علامت نخورده هرگز به سایت نمی‌رود.`}
      actions={
        <input
          className={`${inputClass} h-9 w-48`}
          placeholder="جستجو…"
          aria-label="جستجوی محصول"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      }
      flush
    >
      {rows === null ? (
        <LoadingSkeleton label="در حال بارگذاری محصول‌ها…" />
      ) : (
        <>
          {error ? <div className="px-4 pt-4"><ErrorBox>{error}</ErrorBox></div> : null}
          {visible.length === 0 ? (
            <div className="p-4">
              <EmptyState>{filter ? "محصولی با این نام پیدا نشد." : "محصولی برای نمایش نیست."}</EmptyState>
            </div>
          ) : (
            <DataTable caption="محصولات قابل ارسال به سایت">
              <DataTableHead>
                <Th>ارسال</Th>
                <Th>نام</Th>
                <Th>نوع</Th>
                <Th numeric>قیمت (ریال)</Th>
                <Th>آخرین ارسال</Th>
              </DataTableHead>
              <DataTableBody>
                {visible.map((row) => (
                  <DataTableRow key={`${row.localKind}:${row.localId}`}>
                    <Td>
                      <input
                        type="checkbox"
                        className="size-4"
                        checked={row.syncEnabled}
                        disabled={busyId === row.localId}
                        onChange={(e) => toggle(row, e.target.checked)}
                        aria-label={`ارسال ${row.name} به سایت`}
                      />
                    </Td>
                    <Td>
                      <div className="font-medium">{row.name}</div>
                      {row.sku ? <div dir="ltr" className="text-start text-xs text-muted-foreground">{row.sku}</div> : null}
                    </Td>
                    <Td muted>{LOCAL_KIND_LABELS[row.localKind]}</Td>
                    <Td numeric>{row.priceRial === null ? "—" : money.format(row.priceRial)}</Td>
                    <Td muted className="text-xs">
                      {row.lastPushedAt ? (
                        <>
                          <div>{formatJalali(row.lastPushedAt, { withTime: true })}</div>
                          <div>
                            {row.lastPushedPriceRial !== null ? `قیمت ${money.format(row.lastPushedPriceRial)}` : ""}
                            {row.lastPushedStock !== null ? ` · موجودی ${formatPersianNumber(row.lastPushedStock)}` : ""}
                          </div>
                        </>
                      ) : row.syncEnabled ? (
                        <StatusBadge tone="active">در صف</StatusBadge>
                      ) : (
                        "—"
                      )}
                    </Td>
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>
          )}
        </>
      )}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

function QueueCard({
  connectionId,
  summary,
  onChange,
  refreshKey,
}: {
  connectionId: string;
  summary: QueueSummary | null;
  onChange: () => Promise<void>;
  /** Changes when something outside this card (a product mark) touched the queue. */
  refreshKey: number;
}) {
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [view, setView] = useState<"open" | "sent">("open");
  const [busy, setBusy] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api<{ rows: QueueRow[] }>(`/api/connections/website/queue?status=${view}&connectionId=${connectionId}`);
    setRows(res.ok ? res.data.rows : []);
  }, [view, connectionId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function retry(id: string) {
    setBusy(id);
    setError(null);
    const res = await api(`/api/connections/website/queue/${id}/retry`, { method: "POST" });
    setBusy(null);
    if (!res.ok) setError(errorMessageOrRaw((res.data as { error?: string }).error));
    await Promise.all([load(), onChange()]);
  }

  async function syncNow() {
    setBusy("sync");
    setSyncResult(null);
    setError(null);
    const res = await api<{ queued: number; sent: number; failed: number }>(`/api/connections/website/sync?connectionId=${connectionId}`, { method: "POST" });
    setBusy(null);
    if (res.ok) {
      setSyncResult(
        `${toPersianDigits(String(res.data.queued))} در صف، ${toPersianDigits(String(res.data.sent))} ارسال شد، ${toPersianDigits(String(res.data.failed))} ناموفق.`,
      );
    } else {
      setError(errorMessageOrRaw((res.data as { error?: string }).error));
    }
    await Promise.all([load(), onChange()]);
  }

  return (
    <SectionCard
      title="صف ارسال"
      description={
        summary
          ? `${toPersianDigits(String(summary.pending))} در انتظار · ${toPersianDigits(String(summary.failed))} ناموفق · ${toPersianDigits(String(summary.dead))} متوقف · ${toPersianDigits(String(summary.sent24h))} ارسال در ۲۴ ساعت گذشته`
          : undefined
      }
      actions={
        <>
          <select
            className={`${inputClass} h-9 w-auto`}
            aria-label="نمایش کدام ردیف‌های صف"
            value={view}
            onChange={(e) => setView(e.target.value as "open" | "sent")}
          >
            <option value="open">باز</option>
            <option value="sent">ارسال‌شده</option>
          </select>
          <Button type="button" variant="outline" size="sm" onClick={syncNow} disabled={busy !== null}>
            {busy === "sync" ? "در حال همگام‌سازی…" : "همگام‌سازی اکنون"}
          </Button>
        </>
      }
      flush
    >
      {syncResult ? <div className="px-4 pt-4"><InfoBox>{syncResult}</InfoBox></div> : null}
      {error ? <div className="px-4 pt-4"><ErrorBox>{error}</ErrorBox></div> : null}
      {rows === null ? (
        <LoadingSkeleton label="در حال بارگذاری صف…" />
      ) : rows.length === 0 ? (
        <div className="p-4">
          <EmptyState>{view === "open" ? "صف خالی است؛ همه‌چیز با سایت همگام است." : "چیزی هنوز ارسال نشده است."}</EmptyState>
        </div>
      ) : (
        <ul className="divide-y divide-border/60">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{row.productName ?? "محصول حذف‌شده"}</span>
                  <span className="text-muted-foreground">{WEBSITE_OUTBOX_KIND_LABELS[row.kind]}</span>
                  <StatusBadge tone={statusTone(row.status)}>{WEBSITE_OUTBOX_STATUS_LABELS[row.status]}</StatusBadge>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {row.status === "sent" && row.sentAt ? (
                    formatJalali(row.sentAt, { withTime: true })
                  ) : (
                    <>
                      {/* A dead row is not going to try again on its own — its
                          only future is the «تلاش مجدد» button — so "next
                          attempt" would be a promise this row cannot keep. */}
                      {row.attempts > 0 ? `تلاش ${toPersianDigits(String(row.attempts))}` : "در صف"}
                      {row.status !== "dead" ? ` · نوبت بعد ${formatJalali(row.nextAttemptAt, { withTime: true })}` : ""}
                    </>
                  )}
                  {row.error ? <span className="ms-2 text-destructive">{describeError(row.error)}</span> : null}
                </div>
              </div>
              {row.status === "failed" || row.status === "dead" ? (
                <Button type="button" variant="outline" size="sm" onClick={() => retry(row.id)} disabled={busy !== null}>
                  تلاش مجدد
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
