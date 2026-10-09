"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
/**
 * Phase 25 Wave 3 — the retail industries' selling screen.
 *
 * The café POS sells `menu_items` from a category grid; a jewellery shop has
 * none, so `/accounting/pos` branches on `salesModel` (see page.tsx) and lands
 * here instead. What a shop counter does is build up a few priced lines for one
 * customer and settle them together — so this is a cart over the industry's own
 * catalogue, and it posts one invoice.
 *
 * Every line's price comes from the pricing module Phase 21 already wrote for
 * that trade, and the server settles each line through the same sell service
 * the per-item panel always used (retail-invoice-service.ts). Nothing here
 * computes a ledger amount; the totals shown are the ones the server will
 * confirm back.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useDeferredValue } from "react";
import { PlusIcon, PrinterIcon, RefreshCwIcon, SplitIcon, Trash2Icon, XIcon } from "lucide-react";
import { formatQuantity, toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { normalizePosSearchText } from "@/lib/pos-selection";
import { computeGoldSalePrice, type MakingChargeType } from "@/lib/gold-pricing";
import { computeAccessorySalePrice } from "@/lib/accessories";
import { computeCosmeticSalePrice } from "@/lib/cosmetics";
import { computeWatchSalePrice } from "@/lib/watch-pricing";
import {
  defaultGoldMakingChargePercent,
  defaultGoldProfitPercent,
  hasCapability,
  labelFor,
} from "@/lib/industry-profile";
import { isTradeGoodsIndustry } from "@/lib/trade-goods";
import type { Industry } from "@/lib/industries";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { CameraScanTrigger } from "@/components/scanner/camera-barcode-scanner";
import { ledgerSettlementFor } from "@/lib/payment-methods";
import { MAX_RETAIL_TENDERS } from "@/lib/retail-tenders";
import { radioMoveForKey, radioTargetIndex } from "@/lib/radio-keys";
import { safeRandomId } from "@/lib/client-id";
import { HoldToConfirmButton } from "../hold-to-confirm-button";
import { kickDrawer, printSaleReceipt } from "@/lib/printing/client";
import { api, ErrorBox, errorMessage, Field, inputClass } from "../ui";
import { usePaymentMethods } from "../payment-ways";
import { PageHeader, PageShell, TabBar, TabPanel, cardClass } from "../page-chrome";
import { KnowledgeHelpButton } from "../knowledge-help";
import { toast } from "sonner";
import { InvoiceManagementView } from "./invoice-management-view";

type Purity = "18" | "21" | "24";

interface WeightItem {
  id: string;
  name: string;
  sku: string | null;
  purity: Purity;
  netWeight: string;
  status: string;
  stoneCost: number;
}

interface GoldPrice {
  purity: Purity;
  priceDate: string;
  pricePerGram: number;
}

interface SerialUnit {
  id: string;
  itemId: string;
  itemName: string;
  serialNumber: string;
  status: string;
  warrantyMonths: number;
}

interface Variant {
  id: string;
  parentName: string | null;
  name: string;
  sku: string | null;
  kind: string;
  quantity: string;
  /** Cosmetics batch-tracked items: the sellable (non-expired) quantity. */
  sellableQuantity?: string;
  tracking?: string;
  unitPrice: number | null;
}

interface Customer {
  id: string;
  name: string;
}

/** One line in the cart, before it is sent. Prices are previews of what the server will compute. */
interface CartLine {
  key: string;
  label: string;
  /** Discriminates which payload shape goes to the API. */
  payload: Record<string, unknown> & { kind: "gold" | "watch" | "accessory" | "cosmetic" | "stocked" };
  net: number;
  vat: number;
  total: number;
  /** Gold only, for the preview breakdown. */
  parts?: { metalValue: number; makingCharge: number; profit: number };
}


const PURITY_LABELS: Record<Purity, string> = {
  "18": "۱۸ عیار",
  "21": "۲۱ عیار",
  "24": "۲۴ عیار",
};

/**
 * The variant-catalogue API for a trade-goods/variant retail industry. These
 * all share the same board shape (families + variants with item_stock), so the
 * POS loads them through the same client code; only the URL namespace differs.
 */
function variantApiFor(industry: Industry): string | null {
  switch (industry) {
    case "accessories":
      return "/api/accessories";
    case "cosmetics":
      return "/api/cosmetics";
    case "wholesale":
      return "/api/wholesale";
    case "tools_fittings":
      return "/api/tools-fittings";
    case "haberdashery":
      return "/api/haberdashery";
    default:
      return null;
  }
}

function newKey(): string {
  return safeRandomId();
}

/** One slice of a split retail payment, as the screen holds it. Blank `amount` means «باقی‌مانده». */
interface TenderRow {
  key: string;
  wayId: string;
  amount: string;
  reference: string;
}

function newTenderRow(wayId: string, amount = ""): TenderRow {
  return { key: newKey(), wayId, amount, reference: "" };
}

/** Numeric inputs are editable text. A pasted currency symbol or a half-typed
 * value must make the line unavailable, not throw during render and blank the
 * whole invoice screen. */
function safeMoneyInput(parse: (value: string) => number, value: string): number | null {
  if (!value.trim()) return 0;
  try {
    const parsed = parse(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The VAT percent a fresh line proposes: this business's own «تنظیمات مالیات»
 * rate (`vat-policy.ts`), read once by the page — never a per-trade literal
 * (audit F05). Every line form can still edit it before the line is added.
 */
const DefaultVatContext = createContext(0);

export function RetailInvoiceScreen({
  industry,
  canVoidInvoice = false,
  defaultVatPercent = 0,
}: {
  industry: Industry;
  /** `PERMISSIONS.ordersAmendClosed` — threaded down to «مدیریت فاکتورها»'s void button. */
  canVoidInvoice?: boolean;
  /** The business's default VAT percent from `tax.config` (0 when unset). */
  defaultVatPercent?: number;
}) {
  const money = useMoney();
  const [weightItems, setWeightItems] = useState<WeightItem[]>([]);
  const [prices, setPrices] = useState<GoldPrice[]>([]);
  const [units, setUnits] = useState<SerialUnit[]>([]);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [view, setView] = useState<"issue" | "manage">("issue");

  const [lines, setLines] = useState<CartLine[]>([]);
  const [customerId, setCustomerId] = useState("");
  // The business's own payment ways (migration 0091) rather than three fixed
  // buttons — so a shop that renamed «کارت‌خوان» to «پوز ملت» reads its own
  // name here too. A retail invoice still settles *one* way: it posts through
  // the domain-event engine per line, which knows one destination per sale,
  // so `ledgerSettlementFor` narrows the chosen way to what that engine
  // understands. Splitting a bill is the order path's (see PaymentWays).
  const {
    methods: paymentWays,
    loaded: paymentWaysLoaded,
    error: paymentWaysError,
    reload: reloadPaymentWays,
  } = usePaymentMethods();
  const settlementWays = paymentWays.filter((way) => ledgerSettlementFor(way.settlement) !== null);
  const [paymentWayId, setPaymentWayId] = useState("");
  const selectedWay = settlementWays.find((way) => way.id === paymentWayId) ?? settlementWays[0];
  // No fallback to "cash": when the business has no settlement-eligible
  // payment way configured (or none has loaded yet), there is nothing correct
  // to post — silently defaulting to cash would misattribute the sale to a
  // tender the cashier never picked. `submit` (and the button below) refuses
  // to run without a real selection.
  const paymentMethod = selectedWay ? ledgerSettlementFor(selectedWay.settlement) : null;
  const [paymentReference, setPaymentReference] = useState("");
  // Roving focus for the `role="radiogroup"` below — see radio-keys.ts (the
  // same helper business-settings.tsx's currency choice and the branch-colour
  // picker already use). Without it every way is its own Tab stop and the
  // arrow keys do nothing, which is a tab list wearing a radiogroup's name.
  const paymentWayButtonsRef = useRef<Array<HTMLButtonElement | null>>([]);
  // «تقسیم بین چند روش» — an invoice still posts through the per-line
  // domain-event engine (one destination per *line*, drawn from a shared
  // queue; see retail-tenders.ts), but the till can hand over cash+card for
  // one bill. Off (the ordinary sale) sends one open tender, exactly as
  // before. On, every row sends its own amount and at most one may stay
  // blank — «باقی‌مانده» — to absorb whatever the server's own total comes to
  // (promotions are only known once the transaction runs).
  const [splitPayment, setSplitPayment] = useState(false);
  const [tenderRows, setTenderRows] = useState<TenderRow[]>([]);
  const [note, setNote] = useState("");

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ orderNumber: number; total: number } | null>(null);
  // The sale just issued — enough to name it for a reprint, and all a reprint
  // needs: the document is loaded from the sale's own rows by the server.
  const [lastOrderId, setLastOrderId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const requests: Promise<unknown>[] = [
      api<{ customers?: Customer[] }>("/api/parties?page=1&pageSize=500&roles=Customer").then(({ ok, data }) => {
        if (ok) setCustomers(data.customers ?? []);
      }),
    ];
    if (industry === "jewelry") {
      requests.push(
        api<{ items?: WeightItem[] }>("/api/jewelry/items").then(({ ok, data }) => {
          if (ok) setWeightItems(data.items ?? []);
        }),
        api<{ prices?: GoldPrice[] }>("/api/jewelry/prices").then(({ ok, data }) => {
          if (ok) setPrices(data.prices ?? []);
        }),
      );
    }
    if (industry === "watch") {
      requests.push(
        api<{ units?: SerialUnit[] }>("/api/watch/units").then(({ ok, data }) => {
          if (ok) setUnits(data.units ?? []);
        }),
      );
    }
    const variantApi = variantApiFor(industry);
    if (variantApi) {
      requests.push(
        api<{ items?: Variant[] }>(`${variantApi}/items`).then(({ ok, data }) => {
          if (ok) setVariants(data.items ?? []);
        }),
      );
    }
    await Promise.all(requests);
    setLoading(false);
  }, [industry]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(
    () =>
      lines.reduce(
        (acc, l) => ({ net: acc.net + l.net, vat: acc.vat + l.vat, total: acc.total + l.total }),
        { net: 0, vat: 0, total: 0 },
      ),
    [lines],
  );

  // Split-payment helpers. A row without a recognised way is treated as
  // unpicked (blocks submit); the preview below is best-effort against the
  // client's own line preview, which is why the exact-match check ultimately
  // happens on the server (see the submit-time comment below).
  function tenderRowWay(row: TenderRow) {
    return settlementWays.find((way) => way.id === row.wayId);
  }
  const blankTenderRows = tenderRows.filter((row) => !row.amount.trim());
  const typedTenderTotal = tenderRows.reduce((sum, row) => {
    const parsed = safeMoneyInput(money.parse, row.amount);
    return sum + (parsed ?? 0);
  }, 0);
  const tenderRemaining = totals.total - typedTenderTotal;
  const requiresCustomer = splitPayment
    ? tenderRows.some((row) => tenderRowWay(row) && ledgerSettlementFor(tenderRowWay(row)!.settlement) === "credit")
    : paymentMethod === "credit";

  function startSplit() {
    const firstWayId = selectedWay?.id ?? settlementWays[0]?.id ?? "";
    setSplitPayment(true);
    setTenderRows([newTenderRow(firstWayId), newTenderRow("")]);
  }

  function stopSplit() {
    setSplitPayment(false);
    setTenderRows([]);
  }

  function addTenderRow() {
    setTenderRows((rows) => (rows.length >= MAX_RETAIL_TENDERS ? rows : [...rows, newTenderRow("")]));
  }

  function removeTenderRow(key: string) {
    setTenderRows((rows) => (rows.length <= 2 ? rows : rows.filter((row) => row.key !== key)));
  }

  function patchTenderRow(key: string, patch: Partial<Pick<TenderRow, "wayId" | "amount" | "reference">>) {
    setTenderRows((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function addLine(line: CartLine) {
    setDone(null);
    setError(null);
    setLines((current) => [...current, line]);
  }

  function removeLine(key: string) {
    setLines((current) => current.filter((l) => l.key !== key));
  }

  async function submit() {
    if (lines.length === 0) return;

    let tendersBody: { method: string; amount?: number; paymentMethodId: string; reference: string | null }[];
    if (!splitPayment) {
      if (!selectedWay || !paymentMethod) {
        setError("روش پرداخت را انتخاب کنید.");
        return;
      }
      if (selectedWay.requiresReference && !paymentReference.trim()) {
        setError("برای این روش پرداخت، واردکردن شماره پیگیری الزامی است.");
        return;
      }
      // No amount: the whole invoice, whatever the server's own total comes
      // to — exactly what this screen has always sent for a single-way sale.
      tendersBody = [
        { method: paymentMethod, paymentMethodId: selectedWay.id, reference: paymentReference.trim() || null },
      ];
    } else {
      if (tenderRows.length < 2) {
        setError("برای تقسیم پرداخت، حداقل دو روش لازم است.");
        return;
      }
      if (blankTenderRows.length > 1) {
        setError("فقط یکی از روش‌های پرداخت می‌تواند بدون مبلغ (باقی‌مانده) باشد.");
        return;
      }
      const built: { method: string; amount?: number; paymentMethodId: string; reference: string | null }[] = [];
      for (const row of tenderRows) {
        const way = tenderRowWay(row);
        const method = way ? ledgerSettlementFor(way.settlement) : null;
        if (!way || !method) {
          setError("روش پرداخت را برای همهٔ ردیف‌ها انتخاب کنید.");
          return;
        }
        if (way.requiresReference && !row.reference.trim()) {
          setError("برای این روش پرداخت، واردکردن شماره پیگیری الزامی است.");
          return;
        }
        const amountText = row.amount.trim();
        let amount: number | undefined;
        if (amountText) {
          const parsed = safeMoneyInput(money.parse, amountText);
          if (parsed === null || parsed <= 0) {
            setError("مبلغ یکی از روش‌های پرداخت معتبر نیست.");
            return;
          }
          amount = parsed;
        }
        built.push({ method, paymentMethodId: way.id, reference: row.reference.trim() || null, amount });
      }
      tendersBody = built;
    }
    // Server-enforced too (createRetailInvoice) — this just saves the round
    // trip: a نسیه sale needs someone to owe the receivable to.
    if (requiresCustomer && !customerId) {
      setError("برای فروش نسیه، انتخاب مشتری الزامی است.");
      return;
    }
    setBusy(true);
    setError(null);
    const { ok, data } = await api<{
      invoice?: {
        orderId: string;
        orderNumber: number;
        total: string;
      };
      error?: string;
      message?: string;
    }>("/api/sales/invoices", {
      method: "POST",
      body: JSON.stringify({
        lines: lines.map((l) => l.payload),
        tenders: tendersBody,
        customerId: customerId || null,
        note: note.trim() || null,
      }),
    });
    setBusy(false);
    if (ok && data.invoice) {
      const invoice = data.invoice;
      setDone({ orderNumber: invoice.orderNumber, total: Number(invoice.total) });
      setLines([]);
      setCustomerId("");
      setPaymentReference("");
      stopSplit();
      setNote("");
      void load();

      setLastOrderId(invoice.orderId);

      // The invoice is already committed at this point — everything below is
      // best-effort presentation, and a print that fails must never look like
      // the sale failed: it only ever surfaces as a non-blocking toast, same
      // as "printer not configured".
      const openedDrawer = splitPayment
        ? tenderRows.some((row) => tenderRowWay(row)?.opensDrawer === true)
        : (selectedWay?.opensDrawer ?? false);
      const receiptRequestId = `invoice:${invoice.orderId}`;
      // One call, no fetch: the server loads this sale through
      // `getRetailInvoicePrintData` — the same builder the reprint endpoint and
      // every later reprint use — and renders it. The sale's own rows are the
      // only source, so the first print cannot drift from a later reprint of
      // the same sale (see src/lib/retail-invoice/print-data.ts's header).
      const issue = (requestId: string) => printSaleReceipt(null, invoice.orderId, { requestId });
      void issue(receiptRequestId).then((result) => {
        if (!result.ok && result.error !== "printer_not_configured") {
          toast.warning("چاپ رسید انجام نشد؛ فاکتور با موفقیت ثبت شده است.", {
            action: { label: "چاپ دوباره", onClick: () => void issue(`${receiptRequestId}:retry`) },
          });
        }
        if (openedDrawer && result.supportsDrawer && result.printerId) void kickDrawer(result.printerId);
      });
    } else {
      // The server sends the sell services' own Persian refusals (no stock, no
      // cost basis, no gold rate recorded for today) as `message`; showing that
      // is far more useful than a generic failure.
      setError(data.message ?? errorMessage(data.error));
    }
  }

  function reprintLast() {
    if (!lastOrderId) return;
    const requestId = `reprint:${lastOrderId}:${crypto.randomUUID()}`;
    const issue = (id: string) => printSaleReceipt(null, lastOrderId, { requestId: id });
    void issue(requestId).then((result) => {
      if (result.ok) {
        toast.success("رسید برای چاپ ارسال شد");
      } else if (result.error === "printer_not_configured") {
        // The auto-print right after submit stays silent on a missing
        // printer (see submit() above — a background attempt must never
        // look like the sale failed). This button is different: the cashier
        // pressed it on purpose expecting a receipt, so silence here just
        // looks broken. Same message and settings link the invoice detail
        // modal's own reprint gives for the same error.
        toast.warning("چاپگری برای این شعبه تنظیم نشده است.", {
          action: { label: "تنظیمات چاپگر", onClick: () => window.open("/dashboard/settings/printers", "_blank") },
        });
      } else {
        toast.warning("چاپ رسید انجام نشد.", {
          action: { label: "چاپ دوباره", onClick: () => void issue(`${requestId}:retry`) },
        });
      }
    });
  }

  return (
    <PageShell>
      <PageHeader
        title={labelFor(industry, "sellScreen")}
        description="کالاها را به فاکتور اضافه کنید، مشتری و روش پرداخت را انتخاب کنید و فاکتور را ثبت کنید."
        actions={
          <>
            <KnowledgeHelpButton section="pos" />
            <Button variant="outline" onClick={() => void load()} disabled={loading || busy}>
              <RefreshCwIcon aria-hidden="true" className="size-4" />
              به‌روزرسانی
            </Button>
          </>
        }
      />

      <ErrorBox>{error}</ErrorBox>
      {done ? (
        <div
          role="status"
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-300/60 dark:border-emerald-700/60 bg-emerald-50 dark:bg-emerald-500/15 px-4 py-3 text-sm text-emerald-900 dark:text-emerald-100"
        >
          <span>
            فاکتور شمارهٔ {toPersianDigits(done.orderNumber)} به مبلغ {money.format(done.total)} ثبت شد.
          </span>
          {lastOrderId ? (
            <Button variant="outline" size="sm" onClick={reprintLast}>
              <PrinterIcon aria-hidden="true" className="size-4" />
              چاپ رسید
            </Button>
          ) : null}
        </div>
      ) : null}

      <TabBar
        idPrefix="retail-invoice"
        label="بخش‌های فروش"
        tabs={[
          { key: "issue", label: "صدور فاکتور" },
          { key: "manage", label: "مدیریت فاکتورها" },
        ]}
        active={view}
        onChange={setView}
        className="mb-4"
      />
      <TabPanel idPrefix="retail-invoice" active={view}>
      {view === "issue" ? (
      <DefaultVatContext.Provider value={defaultVatPercent}>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] xl:grid-cols-[minmax(0,1fr)_26rem]">
        <div className="min-w-0 space-y-4">
          {hasCapability(industry, "barcode") ? (
            <BarcodeScanField
              industry={industry}
              variants={variants}
              weightItems={weightItems}
              prices={prices}
              units={units}
              onAdd={addLine}
            />
          ) : null}
          {industry === "jewelry" ? (
            <GoldLineForm industry={industry} items={weightItems} prices={prices} onAdd={addLine} loading={loading} />
          ) : null}
          {industry === "watch" ? (
            <WatchLineForm industry={industry} units={units} onAdd={addLine} loading={loading} />
          ) : null}
          {industry === "accessories" ? (
            <AccessoryLineForm industry={industry} variants={variants} onAdd={addLine} kind="accessory" loading={loading} />
          ) : null}
          {industry === "cosmetics" ? (
            <CosmeticsLineForm industry={industry} variants={variants} onAdd={addLine} loading={loading} />
          ) : null}
          {isTradeGoodsIndustry(industry) ? (
            <AccessoryLineForm industry={industry} variants={variants} onAdd={addLine} kind="stocked" loading={loading} />
          ) : null}

        </div>

        <aside className="min-w-0">
          <div className={`${cardClass} p-4 lg:sticky lg:top-4 sm:p-5`}>
            <h2 className="font-semibold text-foreground">فاکتور جاری</h2>

            {lines.length === 0 ? (
              <p className="mt-4 rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                هنوز کالایی اضافه نشده است.
              </p>
            ) : (
              <ul className="mt-4 divide-y divide-border/80">
                {lines.map((line) => (
                  <li key={line.key} className="py-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">{line.label}</p>
                        {line.parts ? (
                          <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground">
                            طلا {money.format(line.parts.metalValue)} · اجرت{" "}
                            {money.format(line.parts.makingCharge)} · سود {money.format(line.parts.profit)}
                          </p>
                        ) : null}
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          مالیات {money.format(line.vat)}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <span className="text-sm font-semibold text-foreground">
                          {money.format(line.total)}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeLine(line.key)}
                          className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-xs text-rose-700 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-500/15"
                          aria-label={`حذف ${line.label}`}
                        >
                          <Trash2Icon aria-hidden="true" className="size-3.5" />
                          حذف
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <dl className="mt-4 space-y-1.5 border-t border-border/80 pt-4 text-sm">
              <Row label="جمع جزء" value={money.format(totals.net)} />
              <Row label="مالیات" value={money.format(totals.vat)} />
              <Row label="جمع کل" value={money.format(totals.total)} strong />
            </dl>

            <div className="mt-4">
              <Field
                label="مشتری"
                hint={
                  requiresCustomer && !customerId
                    ? "برای فروش نسیه، انتخاب مشتری الزامی است."
                    : undefined
                }
              >
                <SearchableSelect
                  value={customerId}
                  onChange={setCustomerId}
                  ariaLabel="انتخاب مشتری"
                  options={[
                    { value: "", label: "بدون مشتری" },
                    ...customers.map((c) => ({ value: c.id, label: c.name })),
                  ]}
                />
              </Field>

              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-foreground">روش پرداخت</span>
                {settlementWays.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => (splitPayment ? stopSplit() : startSplit())}
                    aria-pressed={splitPayment}
                    className={`inline-flex min-h-9 items-center gap-1 rounded-lg border px-2 text-xs font-bold transition ${
                      splitPayment
                        ? "border-amber-500 dark:border-amber-500/60 bg-amber-50 dark:bg-amber-500/15 text-amber-900 dark:text-amber-200"
                        : "border-border/80 text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    <SplitIcon aria-hidden="true" className="size-3.5 shrink-0" />
                    {splitPayment ? "پرداخت یکجا" : "تقسیم بین چند روش"}
                  </button>
                ) : null}
              </div>

              {!splitPayment ? (
                <div className="mb-4">
                  {/* Not a <label>: this wraps a *group* of buttons, and a
                      <label> forwards a click on its own whitespace to the
                      first labelable descendant — silently switching the
                      payment way to whichever button happens to be first.
                      The group names itself via `role="radiogroup"` below. */}
                  {!paymentWaysLoaded ? (
                    <LoadingSkeleton rows={3} compact label="در حال بارگذاری روش‌های پرداخت" />
                  ) : paymentWaysError ? (
                    <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs" role="alert">
                      <p className="text-destructive">{paymentWaysError.message}</p>
                      <button type="button" onClick={reloadPaymentWays} className="mt-2 min-h-9 rounded-lg border px-3 font-bold">
                        تلاش دوباره
                      </button>
                    </div>
                  ) : settlementWays.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                      هیچ روش فعالی برای دریافت وجه پیکربندی نشده است. با مدیر کسب‌وکار تماس بگیرید.
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="روش پرداخت">
                      {settlementWays.map((way, index) => {
                        const active = selectedWay?.id === way.id;
                        return (
                          <button
                            key={way.id}
                            ref={(node) => {
                              paymentWayButtonsRef.current[index] = node;
                            }}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            tabIndex={active ? 0 : -1}
                            onClick={() => setPaymentWayId(way.id)}
                            onKeyDown={(event) => {
                              const move = radioMoveForKey(event.key, true);
                              const target = move && radioTargetIndex(move, index, settlementWays.length);
                              if (target === null || target === undefined) return;
                              event.preventDefault();
                              setPaymentWayId(settlementWays[target].id);
                              paymentWayButtonsRef.current[target]?.focus();
                            }}
                            className={`min-h-11 flex-1 rounded-xl border px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 ${
                              active
                                ? "border-amber-500 dark:border-amber-500/60 bg-amber-50 dark:bg-amber-500/15 font-medium text-amber-900 dark:text-amber-200"
                                : "border-border text-foreground/80 hover:border-amber-300 dark:hover:border-amber-500/40"
                            }`}
                          >
                            {way.name}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {selectedWay?.requiresReference ? (
                    <Field label="شماره پیگیری" hint="برای ثبت این روش پرداخت الزامی است.">
                      <input
                        className={inputClass}
                        value={paymentReference}
                        maxLength={120}
                        onChange={(event) => setPaymentReference(event.target.value)}
                        placeholder="شماره پیگیری یا مرجع تراکنش"
                      />
                    </Field>
                  ) : null}
                </div>
              ) : (
                <div className="mb-4 space-y-2">
                  {tenderRows.map((row, index) => {
                    const way = tenderRowWay(row);
                    const isLast = index === tenderRows.length - 1;
                    return (
                      <div key={row.key} className="rounded-xl border border-border/80 p-2.5">
                        <div className="flex items-center gap-2">
                          <select
                            className={inputClass + " min-w-0 flex-1"}
                            value={row.wayId}
                            aria-label={`روش پرداخت ردیف ${index + 1}`}
                            onChange={(event) => patchTenderRow(row.key, { wayId: event.target.value })}
                          >
                            <option value="">انتخاب روش…</option>
                            {settlementWays.map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.name}
                              </option>
                            ))}
                          </select>
                          <PersianNumberInput
                            className={inputClass + " w-32 shrink-0 tabular-nums"}
                            dir="ltr"
                            inputMode="numeric"
                            value={row.amount}
                            onChange={(event) => patchTenderRow(row.key, { amount: event.target.value })}
                            placeholder="باقی‌مانده"
                            aria-label={`مبلغ ردیف ${index + 1}`}
                          />
                          <button
                            type="button"
                            onClick={() => removeTenderRow(row.key)}
                            disabled={tenderRows.length <= 2}
                            aria-label={`حذف ردیف ${index + 1}`}
                            className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/80 text-muted-foreground hover:bg-muted disabled:opacity-40"
                          >
                            <XIcon aria-hidden="true" className="size-4" />
                          </button>
                        </div>
                        {way?.requiresReference ? (
                          <input
                            className={inputClass + " mt-2"}
                            value={row.reference}
                            maxLength={120}
                            onChange={(event) => patchTenderRow(row.key, { reference: event.target.value })}
                            placeholder="شماره پیگیری یا مرجع تراکنش (الزامی)"
                            aria-label={`شماره پیگیری ردیف ${index + 1}`}
                          />
                        ) : null}
                        {isLast && !row.amount.trim() ? (
                          <p className="mt-1.5 text-[11px] text-muted-foreground">
                            بدون مبلغ: باقی‌ماندهٔ فاکتور با این روش دریافت می‌شود.
                          </p>
                        ) : null}
                      </div>
                    );
                  })}
                  <button
                    type="button"
                    onClick={addTenderRow}
                    disabled={tenderRows.length >= MAX_RETAIL_TENDERS}
                    className="flex min-h-10 w-full items-center justify-center gap-1 rounded-xl border border-dashed border-border px-3 text-sm text-muted-foreground hover:bg-muted disabled:opacity-55"
                  >
                    <PlusIcon aria-hidden="true" className="size-4" />
                    افزودن روش پرداخت
                  </button>
                  {blankTenderRows.length > 1 ? (
                    <p className="text-xs font-medium text-rose-700 dark:text-rose-300">
                      فقط یکی از روش‌ها می‌تواند بدون مبلغ (باقی‌مانده) باشد.
                    </p>
                  ) : blankTenderRows.length === 0 && tenderRemaining !== 0 ? (
                    <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
                      {tenderRemaining > 0
                        ? `باقی‌مانده تقریبی: ${money.format(tenderRemaining)}`
                        : `مازاد تقریبی: ${money.format(-tenderRemaining)}`}
                    </p>
                  ) : null}
                </div>
              )}

              <Field label="توضیح">
                <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
            </div>

            <HoldToConfirmButton
              durationMs={2000}
              label="ثبت فاکتور"
              holdingLabel="نگه دارید…"
              cancelledMessage="برای ثبت فاکتور، دکمه را ۲ ثانیه نگه دارید."
              busy={busy}
              disabled={
                lines.length === 0 ||
                (!splitPayment && !paymentMethod) ||
                (splitPayment && (tenderRows.length < 2 || blankTenderRows.length > 1))
              }
              onComplete={() => void submit()}
              className="min-h-12 w-full rounded-xl bg-amber-500 dark:bg-amber-400 px-4 text-sm font-bold text-amber-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 disabled:opacity-55"
            />
          </div>
        </aside>
      </div>
      </DefaultVatContext.Provider>
      ) : (
        <InvoiceManagementView canVoidInvoice={canVoidInvoice} />
      )}
      </TabPanel>
    </PageShell>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={strong ? "font-bold text-foreground" : "text-foreground"}>{value}</dd>
    </div>
  );
}

function Panel({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className={`${cardClass} p-4 sm:p-5`}>
      <h2 className="font-semibold text-foreground">{title}</h2>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{hint}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/**
 * Phase 27 Wave 4 — scan-to-add. A handheld scanner types the code and presses
 * Enter; this resolves it to exactly one sellable thing and appends the line
 * (or, for a watch, which has no catalogue price, surfaces the unit so the
 * one remaining input — the agreed price — is entered by hand). Ambiguity is
 * surfaced, never silently guessed.
 */
function BarcodeScanField({
  industry,
  variants,
  weightItems,
  prices,
  units,
  onAdd,
}: {
  industry: Industry;
  variants: Variant[];
  weightItems: WeightItem[];
  prices: GoldPrice[];
  units: SerialUnit[];
  onAdd: (line: CartLine) => void;
}) {
  const defaultVatPercent = useContext(DefaultVatContext);
  const [code, setCode] = useState("");
  const [scanBusy, setScanBusy] = useState(false);
  const [scanError, setScanError] = useState("");
  // A neutral, non-error follow-up ("device identified; enter its price") —
  // a successful scan that still needs one more step must never look like a
  // failed one: same red/alert styling on a scan that actually worked reads
  // as "something went wrong" to the cashier and to a screen reader.
  const [scanNotice, setScanNotice] = useState("");

  async function resolve(rawCode: string) {
    const needle = rawCode.trim();
    if (!needle) return;
    setScanBusy(true);
    setScanError("");
    setScanNotice("");
    const { ok, data } = await api<{
      matches?: { itemId: string; serialId?: string | null; itemName: string; kind: string; tracking: string }[];
      message?: string;
    }>(`/api/barcodes/lookup?code=${encodeURIComponent(needle)}`);
    setScanBusy(false);
    setCode("");
    if (!ok) {
      setScanError(data.message ?? "بارکد خوانده نشد.");
      return;
    }
    const matches = data.matches ?? [];
    if (matches.length === 0) {
      setScanError("بارکدی با این کد یافت نشد.");
      return;
    }
    if (matches.length > 1) {
      setScanError("این بارکد به بیش از یک کالا اشاره دارد؛ کالا را دستی انتخاب کنید.");
      return;
    }
    const match = matches[0];

    if (variantApiFor(industry)) {
      const variant = variants.find((v) => v.id === match.itemId);
      if (!variant || !variant.unitPrice) {
        setScanError("این کالا قیمت یا موجودی ندارد؛ از فرم کالا استفاده کنید.");
        return;
      }
      try {
        const vatPercent = defaultVatPercent;
        const breakdown =
          industry === "cosmetics"
            ? computeCosmeticSalePrice({ unitPrice: variant.unitPrice, quantity: "1", discount: 0, vatPercent })
            : computeAccessorySalePrice({ unitPrice: variant.unitPrice, quantity: "1", discount: 0, vatPercent });
        onAdd({
          key: newKey(),
          label: variant.name,
          payload: {
            kind: industry === "cosmetics" ? "cosmetic" : isTradeGoodsIndustry(industry) ? "stocked" : "accessory",
            itemId: variant.id,
            quantity: "1",
            discount: 0,
            vatPercent,
          },
          net: Number(breakdown.net),
          vat: Number(breakdown.vat),
          total: Number(breakdown.total),
        });
        return;
      } catch (err) {
        setScanError(err instanceof Error ? err.message : "افزودن کالا ناموفق بود.");
        return;
      }
    }

    if (industry === "jewelry") {
      const item = weightItems.find((i) => i.id === match.itemId);
      const rate = item
        ? prices.filter((p) => p.purity === item.purity).sort((a, b) => b.priceDate.localeCompare(a.priceDate))[0]
        : null;
      if (!item || !rate) {
        setScanError("نرخ روز برای این قطعه ثبت نشده است؛ از فرم کالا استفاده کنید.");
        return;
      }
      try {
        // The business's configured defaults (product/category override is not
        // wired up yet — see industry-profile.ts's retailDefaults) — the
        // cashier still sees the breakdown in the cart before settling.
        const makingChargeValue = defaultGoldMakingChargePercent(industry);
        const profitPercent = defaultGoldProfitPercent(industry);
        const vatPercent = defaultVatPercent;
        const breakdown = computeGoldSalePrice({
          netWeight: item.netWeight,
          pricePerGram: rate.pricePerGram,
          makingCharge: { type: "percent", value: makingChargeValue },
          profitPercent,
          vatPercent,
        });
        const metalValue = Number(breakdown.metalValue);
        const makingCharge = Number(breakdown.makingCharge);
        const profit = Number(breakdown.profit);
        onAdd({
          key: newKey(),
          label: `${item.name} (${formatQuantity(item.netWeight)} گرم، ${PURITY_LABELS[item.purity]})`,
          payload: {
            kind: "gold",
            itemId: item.id,
            makingChargeType: "percent",
            makingChargeValue,
            profitPercent,
            vatPercent,
          },
          net: metalValue + makingCharge + profit,
          vat: Number(breakdown.vat),
          total: Number(breakdown.total),
          parts: { metalValue, makingCharge, profit },
        });
        return;
      } catch (err) {
        setScanError(err instanceof Error ? err.message : "افزودن کالا ناموفق بود.");
        return;
      }
    }

    if (industry === "watch") {
      const serial = match.serialId
        ? units.find((u) => u.id === match.serialId)
        : units.filter((u) => u.itemId === match.itemId && u.status === "in_stock")[0];
      if (!serial) {
        setScanError("دستگاه با این بارکد موجود نیست.");
        return;
      }
      // A watch has no catalogue price — it is agreed per sale — so the scan
      // names the unit and the cashier enters the one figure the scan cannot.
      // This identified the device; it is not a failure, so it is reported
      // through `scanNotice`, not `scanError`.
      setScanNotice(`دستگاه «${serial.itemName} — ${serial.serialNumber}» شناسایی شد؛ قیمت را در فرم دستگاه وارد کنید.`);
      return;
    }
  }

  return (
    <Panel title="بارکدخوان" hint="بارکد را با بارکدخوان دستی یا دوربین موبایل اسکن کنید؛ کالا بدون لمس کیبورد به فاکتور اضافه می‌شود.">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
        <input
          className={inputClass}
          dir="ltr"
          value={code}
          disabled={scanBusy}
          autoFocus
          placeholder="اسکن بارکد…"
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void resolve(code);
          }}
        />
        <CameraScanTrigger
          label="دوربین"
          disabled={scanBusy}
          className="min-h-11 shrink-0 gap-1.5 sm:min-w-28"
          title="اسکن بارکد فروش"
          description="بارکد یا QR کالا را با دوربین بخوانید تا به فاکتور اضافه شود."
          onScan={(scanned) => void resolve(scanned)}
        />
      </div>
      {scanBusy ? (
        <LoadingSkeleton rows={1} compact className="mt-2" label="در حال جست‌وجوی کالا" />
      ) : null}
      {scanError ? <p role="alert" className="mt-2 text-xs leading-5 text-rose-700 dark:text-rose-300">{scanError}</p> : null}
      {scanNotice ? (
        <p role="status" className="mt-2 text-xs leading-5 text-amber-800 dark:text-amber-300">{scanNotice}</p>
      ) : null}
    </Panel>
  );
}

/**
 * A gold line: pick a piece, and the price is its net weight × today's rate for
 * its purity, plus اجرت, plus سود, plus VAT — `computeGoldSalePrice`, the same
 * pure function the server will run. Showing it before submitting is the point:
 * the cashier and the customer agree the اجرت before the sale is posted.
 */
function GoldLineForm({
  industry,
  items,
  prices,
  onAdd,
  loading = false,
}: {
  industry: Industry;
  items: WeightItem[];
  prices: GoldPrice[];
  onAdd: (line: CartLine) => void;
  /** The catalogue fetch is still in flight — an empty picker at this point means "not loaded yet", not "nothing in stock". */
  loading?: boolean;
}) {
  const money = useMoney();
  const [itemId, setItemId] = useState("");
  const [makingChargeType, setMakingChargeType] = useState<MakingChargeType>("percent");
  const [makingChargeValue, setMakingChargeValue] = useState(() => String(defaultGoldMakingChargePercent(industry)));
  const [profitPercent, setProfitPercent] = useState(() => String(defaultGoldProfitPercent(industry)));
  const defaultVatPercent = useContext(DefaultVatContext);
  const [vatPercent, setVatPercent] = useState(() => String(defaultVatPercent));
  const [search, setSearch] = useState("");

  const inStock = useMemo(() => items.filter((i) => i.status === "in_stock"), [items]);
  const deferredSearch = useDeferredValue(search);

  // ⚡ Bolt: Extract expensive string normalization out of the hot filter loop
  // that runs on every keystroke.
  const normalizedInStock = useMemo(() => {
    return inStock.map((i) => ({
      item: i,
      normalizedStr: normalizePosSearchText(`${i.name} ${i.sku ?? ""}`),
    }));
  }, [inStock]);

  const filtered = useMemo(() => {
    const needle = normalizePosSearchText(deferredSearch);
    if (!needle) return inStock;
    return normalizedInStock
      .filter((ni) => ni.normalizedStr.includes(needle))
      .map((ni) => ni.item);
  }, [inStock, normalizedInStock, deferredSearch]);

  const item = inStock.find((i) => i.id === itemId) ?? null;
  // The rate the server will use: the most recent one recorded for this purity.
  const rate = item
    ? prices.filter((p) => p.purity === item.purity).sort((a, b) => b.priceDate.localeCompare(a.priceDate))[0]
    : null;

  let preview: { net: number; vat: number; total: number; parts: CartLine["parts"] } | null = null;
  let previewError: string | null = null;
  if (item && rate) {
    try {
      const breakdown = computeGoldSalePrice({
        netWeight: item.netWeight,
        pricePerGram: rate.pricePerGram,
        makingCharge: {
          type: makingChargeType,
          value:
            makingChargeType === "fixed"
              ? money.fromInput(Math.max(0, Math.round(Number(makingChargeValue))))
              : Number(makingChargeValue),
        },
        profitPercent: Number(profitPercent),
        vatPercent: Number(vatPercent),
      });
      const metalValue = Number(breakdown.metalValue);
      const makingCharge = Number(breakdown.makingCharge);
      const profit = Number(breakdown.profit);
      preview = {
        net: metalValue + makingCharge + profit,
        vat: Number(breakdown.vat),
        total: Number(breakdown.total),
        parts: { metalValue, makingCharge, profit },
      };
    } catch (err) {
      previewError = err instanceof Error ? err.message : "محاسبهٔ قیمت ممکن نیست.";
    }
  }

  return (
    <Panel
      title="افزودن کالای طلا"
      hint="قیمت از وزن خالص و نرخ روزِ عیار همان قطعه محاسبه می‌شود؛ اجرت و سود را اینجا تعیین کنید."
    >
      <Field label="جستجوی کالا">
        <input
          className={inputClass}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="نام یا کد کالا"
        />
      </Field>
      <Field label="کالا">
        <SearchableSelect
          value={itemId}
          onChange={setItemId}
          ariaLabel="انتخاب کالای طلا"
          loading={loading}
          options={[
            { value: "", label: "انتخاب کنید" },
            ...filtered.map((i) => ({
              value: i.id,
              label: `${i.name} — ${formatQuantity(i.netWeight)} گرم — ${PURITY_LABELS[i.purity]}`,
            })),
          ]}
        />
      </Field>

      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field label="نوع اجرت">
          <select
            className={inputClass}
            value={makingChargeType}
            onChange={(e) => setMakingChargeType(e.target.value as MakingChargeType)}
          >
            <option value="percent">درصدی</option>
            <option value="fixed">مبلغ ثابت ({money.unitLabel})</option>
          </select>
        </Field>
        <Field label="مقدار اجرت">
          <PersianNumberInput inputMode={makingChargeType === "percent" ? "decimal" : "numeric"}
            className={inputClass}
            dir="ltr"
            value={makingChargeValue}
            onChange={(e) => setMakingChargeValue(e.target.value)}
          />
        </Field>
        <Field label="درصد سود">
          <PersianNumberInput inputMode="decimal"
            className={inputClass}
            dir="ltr"
            value={profitPercent}
            onChange={(e) => setProfitPercent(e.target.value)}
          />
        </Field>
        <Field label="درصد مالیات">
          <PersianNumberInput inputMode="decimal"
            className={inputClass}
            dir="ltr"
            value={vatPercent}
            onChange={(e) => setVatPercent(e.target.value)}
          />
        </Field>
      </div>

      {item && !rate ? (
        <p className="mb-3 rounded-lg border border-amber-300/60 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/15 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
          نرخ طلای {PURITY_LABELS[item.purity]} ثبت نشده است؛ ابتدا نرخ روز را در صفحهٔ «طلا و جواهر» وارد کنید.
        </p>
      ) : null}
      {previewError ? (
        <p role="alert" className="mb-3 text-xs text-rose-700 dark:text-rose-300">{previewError}</p>
      ) : null}
      {preview ? (
        <p className="mb-3 text-xs leading-6 text-muted-foreground">
          طلا {money.format(preview.parts!.metalValue)} · اجرت {money.format(preview.parts!.makingCharge)} · سود{" "}
          {money.format(preview.parts!.profit)} · مالیات {money.format(preview.vat)} —{" "}
          <b className="text-foreground">{money.format(preview.total)}</b>
        </p>
      ) : null}

      <Button
        disabled={!item || !preview}
        onClick={() => {
          if (!item || !preview) return;
          onAdd({
            key: newKey(),
            label: `${item.name} (${formatQuantity(item.netWeight)} گرم، ${PURITY_LABELS[item.purity]})`,
            payload: {
              kind: "gold",
              itemId: item.id,
              makingChargeType,
              makingChargeValue:
                makingChargeType === "fixed"
                  ? money.fromInput(Math.max(0, Math.round(Number(makingChargeValue))))
                  : Number(makingChargeValue),
              profitPercent: Number(profitPercent),
              vatPercent: Number(vatPercent),
            },
            net: preview.net,
            vat: preview.vat,
            total: preview.total,
            parts: preview.parts,
          });
          setItemId("");
        }}
      >
        <PlusIcon aria-hidden="true" className="size-4" />
        افزودن به فاکتور
      </Button>
    </Panel>
  );
}

/** A watch line: one serialised unit at an agreed price. Selling it starts its warranty. */
function WatchLineForm({
  industry,
  units,
  onAdd,
  loading = false,
}: {
  industry: Industry;
  units: SerialUnit[];
  onAdd: (line: CartLine) => void;
  /** The catalogue fetch is still in flight — an empty picker at this point means "not loaded yet", not "nothing in stock". */
  loading?: boolean;
}) {
  const money = useMoney();
  const [serialId, setSerialId] = useState("");
  const [price, setPrice] = useState("");
  const [discount, setDiscount] = useState("");
  const defaultVatPercent = useContext(DefaultVatContext);
  const [vatPercent, setVatPercent] = useState(() => String(defaultVatPercent));

  const inStock = useMemo(() => units.filter((u) => u.status === "in_stock"), [units]);
  const unit = inStock.find((u) => u.id === serialId) ?? null;

  const parsedPrice = safeMoneyInput(money.parse, price);
  const priceRial = parsedPrice ?? 0;
  const parsedDiscount = safeMoneyInput(money.parse, discount);
  const discountRial = parsedDiscount ?? 0;

  let preview: { net: number; vat: number; total: number } | null = null;
  let previewError: string | null = null;
  if (unit && parsedPrice !== null && parsedDiscount !== null && priceRial > 0) {
    try {
      const breakdown = computeWatchSalePrice({
        price: priceRial,
        discount: discountRial,
        vatPercent: Number(vatPercent),
      });
      preview = {
        net: Number(breakdown.net),
        vat: Number(breakdown.vat),
        total: Number(breakdown.total),
      };
    } catch (err) {
      previewError = err instanceof Error ? err.message : "محاسبهٔ قیمت ممکن نیست.";
    }
  }

  return (
    <Panel title="افزودن دستگاه" hint="هر دستگاه با شماره سریال خودش فروخته می‌شود و گارانتی از همین لحظه آغاز می‌شود.">
      <Field label="دستگاه">
        <SearchableSelect
          value={serialId}
          onChange={setSerialId}
          ariaLabel="انتخاب دستگاه"
          loading={loading}
          options={[
            { value: "", label: "انتخاب کنید" },
            ...inStock.map((u) => ({ value: u.id, label: `${u.itemName} — ${u.serialNumber}` })),
          ]}
        />
      </Field>
      <div className="grid gap-x-4 sm:grid-cols-3">
        <Field label={`قیمت (${money.unitLabel})`}>
          <PersianNumberInput inputMode="numeric" className={inputClass} dir="ltr" value={price} onChange={(e) => setPrice(e.target.value)} />
        </Field>
        <Field label={`تخفیف (${money.unitLabel})`}>
          <PersianNumberInput inputMode="numeric" className={inputClass} dir="ltr" value={discount} onChange={(e) => setDiscount(e.target.value)} />
        </Field>
        <Field label="درصد مالیات">
          <PersianNumberInput inputMode="decimal" className={inputClass} dir="ltr" value={vatPercent} onChange={(e) => setVatPercent(e.target.value)} />
        </Field>
      </div>
      {previewError ? (
        <p role="alert" className="mb-3 text-xs text-rose-700 dark:text-rose-300">{previewError}</p>
      ) : null}
      {preview ? (
        <p className="mb-3 text-xs leading-6 text-muted-foreground">
          خالص {money.format(preview.net)} · مالیات {money.format(preview.vat)} —{" "}
          <b className="text-foreground">{money.format(preview.total)}</b>
        </p>
      ) : null}
      <Button
        disabled={!unit || !preview}
        onClick={() => {
          if (!unit || !preview) return;
          onAdd({
            key: newKey(),
            label: `${unit.itemName} — ${unit.serialNumber}`,
            payload: {
              kind: "watch",
              serialId: unit.id,
              price: priceRial,
              discount: discountRial,
              vatPercent: Number(vatPercent),
            },
            net: preview.net,
            vat: preview.vat,
            total: preview.total,
          });
          setSerialId("");
          setPrice("");
          setDiscount("");
        }}
      >
        <PlusIcon aria-hidden="true" className="size-4" />
        افزودن به فاکتور
      </Button>
    </Panel>
  );
}

/**
 * A fungible catalogue line: a quantity of one variant, at its standard price
 * unless overridden. Used by accessories (`kind = "accessory"`) and by the
 * trade-goods industries (`kind = "stocked"`); the payload shape is the same
 * and the server routes it to the trade's own posting rule.
 */
function AccessoryLineForm({
  industry,
  variants,
  onAdd,
  kind = "accessory",
  loading = false,
}: {
  industry: Industry;
  variants: Variant[];
  onAdd: (line: CartLine) => void;
  kind?: "accessory" | "stocked";
  /** The catalogue fetch is still in flight — an empty picker at this point means "not loaded yet", not "nothing in stock". */
  loading?: boolean;
}) {
  const money = useMoney();
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unitPrice, setUnitPrice] = useState("");
  const [discount, setDiscount] = useState("");
  const defaultVatPercent = useContext(DefaultVatContext);
  const [vatPercent, setVatPercent] = useState(() => String(defaultVatPercent));

  const sellable = useMemo(
    () => variants.filter((v) => v.kind !== "variant_parent" && Number(v.quantity) > 0),
    [variants],
  );
  const variant = sellable.find((v) => v.id === itemId) ?? null;

  const parsedUnitPrice = unitPrice.trim() ? safeMoneyInput(money.parse, unitPrice) : variant?.unitPrice ?? 0;
  const effectivePrice = parsedUnitPrice ?? 0;
  const parsedDiscount = safeMoneyInput(money.parse, discount);
  const discountRial = parsedDiscount ?? 0;

  let preview: { net: number; vat: number; total: number } | null = null;
  let previewError: string | null = null;
  if (variant && parsedUnitPrice !== null && parsedDiscount !== null && effectivePrice > 0 && quantity.trim()) {
    try {
      const breakdown = computeAccessorySalePrice({
        unitPrice: effectivePrice,
        quantity,
        discount: discountRial,
        vatPercent: Number(vatPercent),
      });
      preview = {
        net: Number(breakdown.net),
        vat: Number(breakdown.vat),
        total: Number(breakdown.total),
      };
    } catch (err) {
      previewError = err instanceof Error ? err.message : "محاسبهٔ قیمت ممکن نیست.";
    }
  }

  return (
    <Panel title="افزودن کالا" hint="از هر تنوع به تعداد دلخواه؛ قیمت پیش‌فرض همان قیمت ثبت‌شدهٔ تنوع است.">
      <Field label="کالا">
        <SearchableSelect
          value={itemId}
          onChange={setItemId}
          ariaLabel="انتخاب کالا"
          loading={loading}
          options={[
            { value: "", label: "انتخاب کنید" },
            ...sellable.map((v) => ({
              value: v.id,
              label: `${v.parentName ? `${v.parentName} — ` : ""}${v.name} (موجودی ${formatQuantity(v.quantity)})`,
            })),
          ]}
        />
      </Field>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field label="تعداد">
          <PersianNumberInput inputMode="decimal" className={inputClass} dir="ltr" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </Field>
        <Field
          label={`قیمت واحد (${money.unitLabel})`}
          hint={variant?.unitPrice ? `قیمت ثبت‌شده: ${money.format(variant.unitPrice)}` : undefined}
        >
          <PersianNumberInput inputMode="numeric"
            className={inputClass}
            dir="ltr"
            value={unitPrice}
            onChange={(e) => setUnitPrice(e.target.value)}
            placeholder="خالی = قیمت ثبت‌شده"
          />
        </Field>
        <Field label={`تخفیف (${money.unitLabel})`}>
          <PersianNumberInput inputMode="numeric" className={inputClass} dir="ltr" value={discount} onChange={(e) => setDiscount(e.target.value)} />
        </Field>
        <Field label="درصد مالیات">
          <PersianNumberInput inputMode="decimal" className={inputClass} dir="ltr" value={vatPercent} onChange={(e) => setVatPercent(e.target.value)} />
        </Field>
      </div>
      {previewError ? (
        <p role="alert" className="mb-3 text-xs text-rose-700 dark:text-rose-300">{previewError}</p>
      ) : null}
      {preview ? (
        <p className="mb-3 text-xs leading-6 text-muted-foreground">
          خالص {money.format(preview.net)} · مالیات {money.format(preview.vat)} —{" "}
          <b className="text-foreground">{money.format(preview.total)}</b>
        </p>
      ) : null}
      <Button
        disabled={!variant || !preview}
        onClick={() => {
          if (!variant || !preview) return;
          onAdd({
            key: newKey(),
            label: `${variant.name} × ${formatQuantity(quantity)}`,
            payload: {
              kind,
              itemId: variant.id,
              quantity,
              unitPrice: unitPrice.trim() ? effectivePrice : undefined,
              discount: discountRial,
              vatPercent: Number(vatPercent),
            },
            net: preview.net,
            vat: preview.vat,
            total: preview.total,
          });
          setItemId("");
          setQuantity("1");
          setUnitPrice("");
          setDiscount("");
        }}
      >
        <PlusIcon aria-hidden="true" className="size-4" />
        افزودن به فاکتور
      </Button>
    </Panel>
  );
}

/** A cosmetics line: a quantity of one variant, at its standard price unless overridden — the same shape as an accessories line, posted through the cosmetics sell path. */
function CosmeticsLineForm({
  industry,
  variants,
  onAdd,
  loading = false,
}: {
  industry: Industry;
  variants: Variant[];
  onAdd: (line: CartLine) => void;
  /** The catalogue fetch is still in flight — an empty picker at this point means "not loaded yet", not "nothing in stock". */
  loading?: boolean;
}) {
  const money = useMoney();
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unitPrice, setUnitPrice] = useState("");
  const [discount, setDiscount] = useState("");
  const defaultVatPercent = useContext(DefaultVatContext);
  const [vatPercent, setVatPercent] = useState(() => String(defaultVatPercent));

  const sellable = useMemo(
    () =>
      variants.filter(
        (v) => v.kind !== "variant_parent" && Number(v.sellableQuantity ?? v.quantity) > 0,
      ),
    [variants],
  );
  const variant = sellable.find((v) => v.id === itemId) ?? null;

  const parsedUnitPrice = unitPrice.trim() ? safeMoneyInput(money.parse, unitPrice) : variant?.unitPrice ?? 0;
  const effectivePrice = parsedUnitPrice ?? 0;
  const parsedDiscount = safeMoneyInput(money.parse, discount);
  const discountRial = parsedDiscount ?? 0;

  let preview: { net: number; vat: number; total: number } | null = null;
  let previewError: string | null = null;
  if (variant && parsedUnitPrice !== null && parsedDiscount !== null && effectivePrice > 0 && quantity.trim()) {
    try {
      const breakdown = computeCosmeticSalePrice({
        unitPrice: effectivePrice,
        quantity,
        discount: discountRial,
        vatPercent: Number(vatPercent),
      });
      preview = {
        net: Number(breakdown.net),
        vat: Number(breakdown.vat),
        total: Number(breakdown.total),
      };
    } catch (err) {
      previewError = err instanceof Error ? err.message : "محاسبهٔ قیمت ممکن نیست.";
    }
  }

  return (
    <Panel title="افزودن کالا" hint="از هر تنوع به تعداد دلخواه؛ قیمت پیش‌فرض همان قیمت ثبت‌شدهٔ تنوع است.">
      <Field label="کالا">
        <SearchableSelect
          value={itemId}
          onChange={setItemId}
          ariaLabel="انتخاب کالا"
          loading={loading}
          options={[
            { value: "", label: "انتخاب کنید" },
            ...sellable.map((v) => ({
              value: v.id,
              label: `${v.parentName ? `${v.parentName} — ` : ""}${v.name} (موجودی ${formatQuantity(v.sellableQuantity ?? v.quantity)})`,
            })),
          ]}
        />
      </Field>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field label="تعداد">
          <PersianNumberInput inputMode="decimal" className={inputClass} dir="ltr" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </Field>
        <Field
          label={`قیمت واحد (${money.unitLabel})`}
          hint={variant?.unitPrice ? `قیمت ثبت‌شده: ${money.format(variant.unitPrice)}` : undefined}
        >
          <PersianNumberInput inputMode="numeric"
            className={inputClass}
            dir="ltr"
            value={unitPrice}
            onChange={(e) => setUnitPrice(e.target.value)}
            placeholder="خالی = قیمت ثبت‌شده"
          />
        </Field>
        <Field label={`تخفیف (${money.unitLabel})`}>
          <PersianNumberInput inputMode="numeric" className={inputClass} dir="ltr" value={discount} onChange={(e) => setDiscount(e.target.value)} />
        </Field>
        <Field label="درصد مالیات">
          <PersianNumberInput inputMode="decimal" className={inputClass} dir="ltr" value={vatPercent} onChange={(e) => setVatPercent(e.target.value)} />
        </Field>
      </div>
      {previewError ? (
        <p role="alert" className="mb-3 text-xs text-rose-700 dark:text-rose-300">{previewError}</p>
      ) : null}
      {preview ? (
        <p className="mb-3 text-xs leading-6 text-muted-foreground">
          خالص {money.format(preview.net)} · مالیات {money.format(preview.vat)} —{" "}
          <b className="text-foreground">{money.format(preview.total)}</b>
        </p>
      ) : null}
      <Button
        disabled={!variant || !preview}
        onClick={() => {
          if (!variant || !preview) return;
          onAdd({
            key: newKey(),
            label: `${variant.name} × ${formatQuantity(quantity)}`,
            payload: {
              kind: "cosmetic",
              itemId: variant.id,
              quantity,
              unitPrice: unitPrice.trim() ? effectivePrice : undefined,
              discount: discountRial,
              vatPercent: Number(vatPercent),
            },
            net: preview.net,
            vat: preview.vat,
            total: preview.total,
          });
          setItemId("");
          setQuantity("1");
          setUnitPrice("");
          setDiscount("");
        }}
      >
        <PlusIcon aria-hidden="true" className="size-4" />
        افزودن به فاکتور
      </Button>
    </Panel>
  );
}


