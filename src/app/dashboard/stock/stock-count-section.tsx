"use client";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useRef, useState, useId } from "react";
import Decimal from "decimal.js";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { CameraScanTrigger } from "@/components/scanner/camera-barcode-scanner";
import { formatPersianNumber, formatQuantity, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { EmptyState, LoadingSkeleton, SectionCard, StatusBadge, overlayPanelClass } from "../page-chrome";
import { api, Field, inputClass } from "../ui";
import styles from "../inventory/inventory-workspace.module.css";

/**
 * Physical stock count (انبارگردانی) for the retail item model.
 *
 * Hardened for #921 — scan-driven with explicit warehouse scope, permission-aware
 * controls, server-validated preview, and a fix for the P1 silent-zero wipe:
 * manual «افزودن» no longer synthesises a 0; the operator must enter a counted
 * value explicitly, and counted-0 requires confirmation.
 */
export interface CountableItem {
  id: string;
  name: string;
  quantity: string;
  tracking?: string;
}

interface CountSummary {
  id: string;
  note: string | null;
  countedAt: string;
  countedByName: string | null;
  lineCount: number;
  shortageValue: string;
  surplusValue: string;
  reversed: boolean;
  status?: string;
}

interface CountDetailLine {
  id: string;
  itemId: string;
  itemName: string;
  tracking?: string;
  systemQty: string;
  countedQty: string;
  variance: string;
  unitCost: string | null;
  varianceValue: string;
}

interface CountDetail {
  id: string;
  note: string | null;
  countedAt: string;
  countedByName: string | null;
  entryId: string | null;
  reversedAt: string | null;
  lines: CountDetailLine[];
  batchAllocations?: Array<{
    lineId: string;
    batchNumber: string;
    expiryDate: string | null;
    quantity: string;
    unitCost: string | null;
    value: string;
    kind: string;
  }>;
}

function countError(code: string | undefined, message?: string): string {
  const map: Record<string, string> = {
    no_items: "هیچ قلمی برای شمارش وارد نشده است.",
    invalid_quantity: "مقدار شمارش‌شده باید صفر یا یک عدد مثبت باشد.",
    quantity_precision_exceeded: "مقدار شمارش‌شده بیش از ۹ رقم اعشار دارد.",
    invalid_item: "یکی از اقلام انتخاب‌شده معتبر نیست.",
    duplicate_item: "یک قلم دو بار در فهرست آمده است.",
    item_not_found: "این کالا در این شعبه یافت نشد.",
    count_not_found: "این انبارگردانی پیدا نشد.",
    count_not_reversible: "این ردیف خودش یک برگشت است و قابل برگشت نیست.",
    already_reversed: "این انبارگردانی قبلاً برگشت خورده است.",
    count_stock_consumed:
      "کالای اضافهٔ این انبارگردانی بعداً فروخته شده و قابل برگشت نیست؛ یک انبارگردانی تازه ثبت کنید.",
    cost_basis_changed:
      "بهای تمام‌شده از زمان شمارش تغییر کرده است؛ برگشتِ دقیق ممکن نیست. یک شمارش اصلاحی تازه ثبت کنید.",
    ledger_account_missing: "حساب مورد نیاز در دفتر حساب‌ها موجود نیست.",
    snapshot_conflict: "موجودی از زمان شروع شمارش تغییر کرده است؛ پیش‌نمایش را تازه کنید.",
    unsupported_tracking_serial: "کالای سریالی با شمارش عددی قابل اصلاح نیست؛ از گردش سریال استفاده کنید.",
    unsupported_tracking_weight: "کالای وزنی با شمارش عددی قابل اصلاح نیست؛ از مسیر وزن/عیار استفاده کنید.",
    missing_counted_qty: "مقدار شمارش‌شده برای یکی از اقلام وارد نشده است.",
    missing_cost_basis: "این قلم بهای تمام‌شده ندارد؛ اختلاف بدون ارزش ثبت می‌شود و نیاز به بازبینی دارد.",
    warehouse_not_accessible: "انبار انتخاب‌شده در دسترس شما نیست.",
    intervening_movements: "پس از این شمارش تراکنش دیگری ثبت شده؛ برای اصلاح یک شمارش تازه ثبت کنید.",
    quantity_out_of_range: "مقدار واردشده بیش از حد مجاز است.",
    rial_out_of_range: "ارزش ریالی بیش از حد مجاز است.",
    note_too_long: "یادداشت بیش از ۲۰۰۰ نویسه است.",
  };
  return map[code ?? ""] ?? message ?? "عملیات ناموفق بود.";
}

export function StockCountSection({
  items,
  onDone,
  onError,
  reload,
  permissions,
  warehouses,
  selectedWarehouseId,
  onWarehouseChange,
}: {
  items: CountableItem[];
  onDone: (message: string) => void;
  onError: (message: string) => void;
  reload: () => void;
  permissions?: readonly string[];
  warehouses?: Array<{ id: string; name: string }>;
  selectedWarehouseId?: string | null;
  onWarehouseChange?: (id: string | null) => void;
}) {
  const money = useMoney();
  const previewId = useId();
  const canAdjust = !permissions || permissions.includes("inventory.adjust");
  const canView = !permissions || permissions.includes("inventory.view");

  const [counted, setCounted] = useState<Record<string, string>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [code, setCode] = useState("");
  const [qtyPerScan, setQtyPerScan] = useState("1");
  const [scanFeedback, setScanFeedback] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [manualId, setManualId] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<CountSummary[] | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [previewData, setPreviewData] = useState<null | {
    lines: Array<{ itemId: string; itemName: string; systemQty: string; countedQty: string; variance: string; varianceValue: string; warnings: string[] }>;
    shortage: string;
    surplus: string;
  }>(null);
  const [previewWarning, setPreviewWarning] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Idempotency key for this draft — prevents double-submit on retry/timeout
  const idemKeyRef = useRef<string>(`count-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  const loadHistory = useCallback(() => {
    setHistoryError("");
    const params = selectedWarehouseId ? `?locationId=${encodeURIComponent(selectedWarehouseId)}` : "";
    api<{ counts: CountSummary[]; total?: number; error?: string }>(`/api/stock/counts${params}`)
      .then(({ ok, data }) => {
        if (ok) setHistory(data.counts ?? []);
        else {
          setHistory([]);
          setHistoryError(countError((data as unknown as { error?: string }).error));
        }
      })
      .catch(() => {
        setHistory([]);
        setHistoryError("دریافت سوابق انبارگردانی ناموفق بود؛ دوباره تلاش کنید.");
      });
  }, [selectedWarehouseId]);
  useEffect(loadHistory, [loadHistory]);

  // Permission-aware: view-only members see history but not the counting form
  const isReadOnly = !canAdjust;

  const addToTally = useCallback(
    (itemId: string, step: number, itemName: string) => {
      if (isReadOnly) return;
      setOrder((prev) => (prev.includes(itemId) ? prev : [itemId, ...prev]));
      // P1 fix: manual «افزودن» used to synthesize 0 and wipe stock. Now we
      // model "not counted" (absent/empty) distinctly from "explicitly counted 0".
      // step===0 means manual add → empty string requiring operator entry.
      if (step === 0) {
        setCounted((prev) => {
          // Do not overwrite an already-entered value — manual add is idempotent
          if (prev[itemId]?.trim() !== undefined && prev[itemId]?.trim() !== "") return prev;
          return { ...prev, [itemId]: "" };
        });
        setScanFeedback({ kind: "ok", text: `${itemName} — برای ثبت، مقدار شمارش‌شده را وارد کنید.` });
        return;
      }
      setCounted((prev) => {
        const current = prev[itemId]?.trim();
        const base = current && Number.isFinite(Number(current)) ? new Decimal(current) : new Decimal(0);
        const next = base.plus(step);
        setScanFeedback({
          kind: "ok",
          text: `${itemName} — شمارش‌شده: ${formatQuantity(next.toFixed())}`,
        });
        return { ...prev, [itemId]: next.toFixed() };
      });
    },
    [isReadOnly],
  );

  async function resolveScan(raw: string) {
    const needle = raw.trim();
    if (!needle) return;
    setCode("");
    inputRef.current?.focus();

    const step = Number(qtyPerScan);
    if (!Number.isFinite(step) || step <= 0) {
      setScanFeedback({ kind: "error", text: "مقدار هر اسکن باید عددی مثبت باشد." });
      return;
    }

    const { ok, data } = await api<{
      matches?: { itemId: string; itemName: string }[];
      message?: string;
    }>(`/api/barcodes/lookup?code=${encodeURIComponent(needle)}`);
    if (!ok) {
      setScanFeedback({ kind: "error", text: data.message ?? "بارکد خوانده نشد." });
      return;
    }
    const matches = data.matches ?? [];
    if (matches.length === 0) {
      setScanFeedback({
        kind: "error",
        text: `بارکد ${toPersianDigits(needle)} به هیچ کالایی متصل نیست.`,
      });
      return;
    }
    if (matches.length > 1) {
      setScanFeedback({ kind: "error", text: "این بارکد به بیش از یک کالا اشاره دارد." });
      return;
    }
    const match = matches[0];
    if (!items.some((i) => i.id === match.itemId)) {
      setScanFeedback({
        kind: "error",
        text: `«${match.itemName}» در انبار این شعبه نیست.`,
      });
      return;
    }
    addToTally(match.itemId, step, match.itemName);
  }

  async function fetchPreview() {
    const lines = order
      .filter((id) => counted[id]?.trim() !== "" && counted[id] != null)
      .map((id) => ({ itemId: id, countedQty: counted[id].trim() }));
    if (lines.length === 0) {
      setPreviewWarning("هیچ قلمی با مقدار شمارش‌شده وارد نشده است.");
      return;
    }
    // Validate explicit zero with strong confirmation
    const zeroLines = lines.filter((l) => new Decimal(l.countedQty).isZero());
    if (zeroLines.length > 0) {
      const names = zeroLines.map((l) => items.find((i) => i.id === l.itemId)?.name ?? l.itemId).join("، ");
      if (!window.confirm(`مقدار شمارش‌شدهٔ «${names}» صفر است و موجودی آن صفر خواهد شد. آیا مطمئن هستید؟`)) {
        return;
      }
    }
    setBusy(true);
    setPreviewWarning("");
    const { ok, data } = await api<{
      preview?: { lines: Array<{ itemId: string; itemName: string; systemQty: string; countedQty: string; variance: string; varianceValue: string; warnings: string[] }>; shortage: string; surplus: string };
      error?: string;
      message?: string;
    }>(`/api/stock/counts/preview`, {
      method: "POST",
      body: JSON.stringify({ note, lines, locationId: selectedWarehouseId ?? undefined }),
    });
    setBusy(false);
    if (!ok) {
      setPreviewWarning(countError(data.error, data.message));
      return;
    }
    setPreviewData(data.preview ?? null);
    setShowPreview(true);
  }

  async function submit() {
    // Require preview confirmation for destructive adjustments
    if (!showPreview) {
      await fetchPreview();
      return;
    }
    const lines = order
      .filter((id) => counted[id]?.trim() !== "" && counted[id] != null)
      .map((id) => ({ itemId: id, countedQty: counted[id].trim() }));
    if (lines.length === 0) return;

    // Final explicit-zero guard — no implicit zero from manual add
    const zeroLines = lines.filter((l) => new Decimal(l.countedQty).isZero());
    if (zeroLines.length > 0 && !window.confirm("یک یا چند قلم با مقدار صفر ثبت خواهد شد و موجودی آن صفر می‌شود. ادامه می‌دهید؟")) {
      return;
    }

    setBusy(true);
    const { ok, data } = await api<{ error?: string; message?: string; shortage?: string; surplus?: string }>(
      "/api/stock/counts",
      {
        method: "POST",
        body: JSON.stringify({
          note,
          lines,
          locationId: selectedWarehouseId ?? undefined,
          idempotencyKey: idemKeyRef.current,
        }),
        headers: { "Idempotency-Key": idemKeyRef.current },
      },
    );
    setBusy(false);
    if (!ok) {
      onError(countError(data.error, data.message));
      return;
    }
    setCounted({});
    setOrder([]);
    setNote("");
    setScanFeedback(null);
    setShowPreview(false);
    setPreviewData(null);
    idemKeyRef.current = `count-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    onDone(
      `انبارگردانی ثبت شد — کسری ${money.formatText(String(data.shortage ?? "0"))}، اضافه ${money.formatText(
        String(data.surplus ?? "0"),
      )}.`,
    );
    loadHistory();
    reload();
  }

  async function reverse(id: string) {
    if (isReadOnly) return;
    if (!window.confirm("این انبارگردانی برگشت بخورد و اثر آن بر موجودی و حسابداری برگردانده شود؟")) {
      return;
    }
    setBusy(true);
    const { ok, data } = await api<{ error?: string; message?: string }>(`/api/stock/counts/${id}/reverse`, {
      method: "POST",
      body: JSON.stringify({ locationId: selectedWarehouseId ?? undefined }),
    });
    setBusy(false);
    if (!ok) {
      onError(countError(data.error, data.message));
      return;
    }
    onDone("انبارگردانی برگشت خورد.");
    loadHistory();
    reload();
  }

  const tally = order
    .map((id) => items.find((i) => i.id === id))
    .filter((i): i is CountableItem => Boolean(i));

  return (
    <div className={`${styles.workspace} mt-4 grid min-w-0 gap-4 lg:grid-cols-2`}>
      {historyError ? (
        <p role="alert" className="col-span-full rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {historyError}
        </p>
      ) : null}
      {/* Warehouse selector — P1 explicit, authorized, displayed throughout */}
      {warehouses && warehouses.length > 1 ? (
        <div className="col-span-full">
          <Field label="انبار">
            <select
              className={inputClass}
              value={selectedWarehouseId ?? ""}
              onChange={(e) => onWarehouseChange?.(e.target.value || null)}
              aria-label="انتخاب انبار"
            >
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </Field>
          {selectedWarehouseId ? (
            <p className="mt-1 text-xs text-muted-foreground">انبار فعال: {warehouses.find((w) => w.id === selectedWarehouseId)?.name ?? selectedWarehouseId}</p>
          ) : null}
        </div>
      ) : null}
      <SectionCard
        title="انبارگردانی"
        description="بارکد هر کالا را اسکن کنید؛ مقدار شمارش‌شده جمع می‌شود. پس از ثبت، موجودی سیستم برابر مقدار شمارش‌شده می‌شود و اختلاف به‌عنوان کسری یا اضافهٔ انبارگردانی در دفتر ثبت می‌گردد."
      >
        {isReadOnly ? (
          <p role="alert" className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            شما دسترسی «مشاهدهٔ انبار» دارید اما «اصلاح انبار» ندارید؛ ثبت یا برگشت انبارگردانی برای شما فعال نیست.
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-[1fr_7rem_auto]">
          <Field label="بارکد">
            <input
              ref={inputRef}
              className={inputClass}
              dir="ltr"
              value={code}
              autoFocus
              placeholder="اسکن بارکد…"
              disabled={isReadOnly}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void resolveScan(code);
                }
              }}
            />
          </Field>
          <Field label="مقدار هر اسکن">
            <PersianNumberInput
              className={inputClass}
              dir="ltr"
              inputMode="decimal"
              allowNegative={false}
              value={qtyPerScan}
              onChange={(e) => setQtyPerScan(e.target.value)}
            />
          </Field>
          <div className="mb-4 flex items-end">
            <CameraScanTrigger
              label="دوربین"
              title="اسکن بارکد انبارگردانی"
              description="بارکد کالا را با دوربین موبایل بخوانید تا به شمارش افزوده شود."
              onScan={(scanned) => void resolveScan(scanned)}
            />
          </div>
        </div>
        {scanFeedback ? (
          <p
            className={`mt-2 text-xs leading-5 ${
              scanFeedback.kind === "ok" ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"
            }`}
            role="status"
            aria-live="polite"
          >
            {scanFeedback.text}
          </p>
        ) : null}

        <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
          <SearchableSelect
            value={manualId}
            onChange={setManualId}
            options={[
              { value: "", label: "افزودن دستی کالا…" },
              ...items.map((i) => ({
                value: i.id,
                label: i.name,
                searchString: `${i.name} ${i.id}`,
              })),
            ]}
            placeholder="افزودن دستی کالا…"
            searchPlaceholder="جستجوی نام یا شناسه کالا…"
            emptyText="کالایی پیدا نشد."
            ariaLabel="افزودن دستی کالا به شمارش"
            className="w-full"
          />
          <Button
            type="button"
            disabled={busy || !manualId || isReadOnly}
            className="min-h-11 w-full sm:w-auto"
            onClick={() => {
              const item = items.find((i) => i.id === manualId);
              if (item) addToTally(item.id, 0, item.name);
              setManualId("");
            }}
          >
            افزودن
          </Button>
        </div>

        {tally.length > 0 ? (
          <ul className="mt-3 divide-y divide-border/80 text-sm">
            {tally.map((i) => {
              const value = counted[i.id]?.trim();
              const variance =
                value && Number.isFinite(Number(value)) ? new Decimal(value).minus(i.quantity) : null;
              const isEmpty = value == null || value === "";
              return (
                <li key={i.id} className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between">
                  <span className="min-w-0 break-words">
                    <span className="font-medium text-foreground">{i.name}</span>{" "}
                    <span className="text-xs text-muted-foreground">(سیستم: {formatQuantity(i.quantity)})</span>
                    {isEmpty ? (
                      <span className="ms-2 text-xs text-amber-700 dark:text-amber-300">— مقدار وارد نشده</span>
                    ) : variance && !variance.isZero() ? (
                      <span
                        className={`ms-2 text-xs ${
                          variance.isNegative() ? "text-rose-700 dark:text-rose-300" : "text-emerald-700 dark:text-emerald-300"
                        }`}
                      >
                        {variance.isNegative() ? "کسری" : "اضافه"} {formatQuantity(variance.abs().toFixed())}
                      </span>
                    ) : null}
                  </span>
                  <div className="flex items-center gap-2">
                    <PersianNumberInput
                      className={`${inputClass} w-full sm:w-32 ${isEmpty ? "border-amber-300" : ""}`}
                      dir="ltr"
                      inputMode="decimal"
                      allowNegative={false}
                      placeholder="مقدار شمارش…"
                      value={counted[i.id] ?? ""}
                      onChange={(e) => setCounted((prev) => ({ ...prev, [i.id]: e.target.value }))}
                    />
                    <button
                      type="button"
                      aria-label={`حذف ${i.name} از شمارش`}
                      className="rounded p-1 text-muted-foreground hover:text-destructive"
                      onClick={() => {
                        setOrder((prev) => prev.filter((x) => x !== i.id));
                        setCounted((prev) => {
                          const next = { ...prev };
                          delete next[i.id];
                          return next;
                        });
                      }}
                    >
                      ✕
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState>هنوز کالایی شمارش نشده است.</EmptyState>
        )}

        <div className="mt-3">
          <Field label="یادداشت">
            <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} placeholder="اختیاری" disabled={isReadOnly} />
          </Field>
        </div>
        {previewWarning ? (
          <p role="alert" className="mt-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {previewWarning}
          </p>
        ) : null}
        {showPreview && previewData ? (
          <div className="mt-3 rounded-lg border border-border p-3" id={previewId}>
            <h4 className="text-sm font-semibold">پیش‌نمایش اثر مالی</h4>
            <p className="mt-1 text-xs text-muted-foreground">
              کسری {money.formatText(previewData.shortage)} · اضافه {money.formatText(previewData.surplus)}
            </p>
            <ul className="mt-2 divide-y text-xs">
              {previewData.lines.map((l) => (
                <li key={l.itemId} className="flex justify-between py-1">
                  <span>
                    {items.find((i) => i.id === l.itemId)?.name ?? l.itemId}: سیستم {formatQuantity(l.systemQty)} → شمارش{" "}
                    {formatQuantity(l.countedQty)} ({l.variance.startsWith("-") ? "کسری" : l.variance === "0" ? "بدون اختلاف" : "اضافه"}{" "}
                    {formatQuantity(l.variance)})
                  </span>
                  {l.warnings.length > 0 ? (
                    <span className="text-amber-700">{l.warnings.join("، ")}</span>
                  ) : null}
                </li>
              ))}
            </ul>
            <div className="mt-2 flex gap-2">
              <Button type="button" className="min-h-11 w-full" disabled={busy} onClick={() => void submit()}>
                تأیید و ثبت انبارگردانی
              </Button>
              <Button type="button" variant="outline" className="min-h-11" onClick={() => setShowPreview(false)}>
                بازگشت
              </Button>
            </div>
          </div>
        ) : null}
        <Button
          type="button"
          disabled={busy || tally.length === 0 || isReadOnly}
          className="mt-3 min-h-11 w-full"
          onClick={() => void (showPreview ? submit() : fetchPreview())}
        >
          {showPreview ? "تأیید و ثبت" : "پیش‌نمایش و ثبت انبارگردانی"}
        </Button>
        <p className="mt-1 text-xs text-muted-foreground">
          شمارش به‌روزرسانی‌های هم‌زمان (فروش/رسید) را در لحظهٔ ثبت با موجودیِ فعلی می‌سنجد؛ در صورت تعارض پیش‌نمایش را تازه کنید.
        </p>
      </SectionCard>

      <SectionCard
        title="انبارگردانی‌های اخیر"
        description="یک انبارگردانی ثبت‌شده ویرایش نمی‌شود؛ برای اصلاح، آن را برگشت بزنید و شمارش تازه ثبت کنید."
      >
        {history === null ? (
          <LoadingSkeleton rows={4} />
        ) : history.length === 0 ? (
          <EmptyState>انبارگردانی ثبت نشده است.</EmptyState>
        ) : (
          <ul className="mt-3 divide-y divide-border/80 text-sm">
            {history.map((c) => (
              <li key={c.id} className="flex min-w-0 flex-col gap-2 py-3">
                <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                  <div className="min-w-0">
                    <p className="break-words font-medium text-foreground">
                      {formatPersianNumber(c.lineCount)} قلم {c.note ? `— ${c.note}` : ""}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {c.countedByName ? `${c.countedByName} — ` : ""}{formatJalali(c.countedAt)}
                    </p>
                  </div>
                  {c.reversed ? <StatusBadge tone="neutral">برگشت‌خورده</StatusBadge> : null}
                  {c.status ? <StatusBadge tone="neutral">{c.status}</StatusBadge> : null}
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <span className="text-xs">
                    <span className="text-rose-700 dark:text-rose-300">کسری {money.formatText(c.shortageValue)}</span>
                    {" · "}
                    <span className="text-emerald-700 dark:text-emerald-300">اضافه {money.formatText(c.surplusValue)}</span>
                  </span>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="ghost" onClick={() => setDetailId(c.id)}>
                      جزئیات
                    </Button>
                    {c.reversed ? null : (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy || isReadOnly}
                        onClick={() => void reverse(c.id)}
                      >
                        برگشت
                      </Button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {detailId ? <ItemCountDetailModal countId={detailId} onClose={() => setDetailId(null)} canAdjust={canAdjust} /> : null}
    </div>
  );
}

function ItemCountDetailModal({
  countId,
  onClose,
  canAdjust,
}: {
  countId: string;
  onClose: () => void;
  canAdjust?: boolean;
}) {
  const money = useMoney();
  const [detail, setDetail] = useState<CountDetail | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError("");
    api<{ count: CountDetail; error?: string }>(`/api/stock/counts/${countId}`)
      .then(({ ok, data }) => {
        if (cancelled) return;
        if (ok) setDetail(data.count);
        else setError(countError((data as unknown as { error?: string }).error));
      })
      .catch(() => {
        if (!cancelled) setError("دریافت جزئیات انبارگردانی ناموفق بود.");
      });
    return () => {
      cancelled = true;
    };
  }, [countId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center sm:p-4" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="retail-stock-count-detail-heading"
        className={`${overlayPanelClass} max-h-[88vh] w-full max-w-2xl overflow-y-auto p-4 sm:max-h-[80vh] sm:p-5`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="mb-4 flex items-start justify-between gap-3 border-b border-border pb-4">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">جزئیات انبارگردانی</p>
            <h3 id="retail-stock-count-detail-heading" className="mt-1 break-words text-lg font-bold">
              {detail ? `${formatJalali(detail.countedAt)}${detail.countedByName ? ` — ${detail.countedByName}` : ""}` : "در حال بارگذاری…"}
            </h3>
            {detail?.entryId ? <p className="text-xs text-muted-foreground">سند حسابداری: {detail.entryId}</p> : null}
          </div>
          <Button type="button" variant="outline" className="min-h-11 shrink-0" onClick={onClose}>
            بستن
          </Button>
        </header>

        {error ? (
          <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : detail === null ? (
          <LoadingSkeleton rows={4} />
        ) : (
          <div className="space-y-4">
            {detail.reversedAt ? (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                این انبارگردانی برگشت خورده و فقط برای مشاهده است. برگشت در {formatJalali(detail.reversedAt)} ثبت شد.
              </p>
            ) : null}
            {detail.note ? <p className="text-sm text-muted-foreground">یادداشت: {detail.note}</p> : null}
            {detail.lines.length === 0 ? (
              <EmptyState>برای این انبارگردانی قلمی ثبت نشده است.</EmptyState>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {detail.lines.map((line) => (
                  <li key={line.id} className="space-y-2 px-3 py-3 text-sm">
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <span className="min-w-0 break-words font-medium">
                        {line.itemName} {line.tracking ? <span className="text-xs text-muted-foreground">({line.tracking})</span> : null}
                      </span>
                      <StatusBadge tone={line.variance === "0" ? "neutral" : line.variance.startsWith("-") ? "danger" : "active"}>
                        {line.variance === "0" ? "بدون اختلاف" : line.variance.startsWith("-") ? "کسری" : "اضافه"}
                      </StatusBadge>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-4">
                      <span>
                        سیستم: <b className="font-medium text-foreground">{formatQuantity(line.systemQty)}</b>
                      </span>
                      <span>
                        شمارش: <b className="font-medium text-foreground">{formatQuantity(line.countedQty)}</b>
                      </span>
                      <span>
                        اختلاف: <b className="font-medium text-foreground">{formatQuantity(line.variance)}</b>
                      </span>
                      {line.varianceValue !== "0" ? (
                        <span>
                          ارزش: <b className="font-medium text-foreground">{money.formatText(line.varianceValue)}</b>
                        </span>
                      ) : (
                        <span className="text-amber-700">بدون ارزش (بهای تمام‌شده نامشخص)</span>
                      )}
                    </div>
                    {detail.batchAllocations?.filter((b) => b.lineId === line.id).length ? (
                      <div className="text-xs">
                        <p className="font-medium">رد بچ‌ها:</p>
                        <ul className="list-disc ps-4">
                          {detail.batchAllocations
                            .filter((b) => b.lineId === line.id)
                            .map((b, idx) => (
                              <li key={idx}>
                                {b.batchNumber} {b.expiryDate ? `(انقضا ${b.expiryDate})` : ""}: {b.kind === "relief" ? "کسر" : "افزود"}{" "}
                                {formatQuantity(b.quantity)} × {b.unitCost ?? "—"} = {money.formatText(b.value)}
                              </li>
                            ))}
                        </ul>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {!canAdjust ? (
              <p className="text-xs text-muted-foreground">جزئیات برای همه قابل مشاهده است؛ برگشت نیاز به دسترسی اصلاح دارد.</p>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}
