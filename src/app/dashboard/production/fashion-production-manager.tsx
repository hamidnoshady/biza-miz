"use client";

/**
 * GH #1567 Phase 6B — production orders for a fashion workshop
 * (cut → sew → finish → QC → pack).
 *
 * Sized for the boutique that sews a few dresses a week first: one list of the
 * branch's orders (the shell's branch switcher is the branch filter — the API
 * refuses another branch's orders), a sheet that carries an order from release
 * to receipt, a bill-of-materials editor and a report that shows the work in
 * progress tying to the ledger. Larger workshops get configurable stages,
 * per-stage assignee, rework and controlled cancellation from the same screen.
 *
 * Every button is one server action under an optimistic lock
 * (`expectedVersion`) and an idempotency key, so a double-click or a retry
 * never moves stock twice and two people get a conflict, not an overwrite.
 * Stock and money move only on the server (F1 WAC + posting engine).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { FactoryIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useMoney } from "@/components/money/money-context";
import { toLatinDigits, toPersianDigits } from "@/lib/digits";
import type { ProductionOrderStatus } from "@/lib/fashion-production";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "../data-table";
import { FilterChip, FilterChipRow } from "../filters";
import { IndustryManagerShell } from "../industry-manager-shell";
import { JalaliDatePicker } from "../jalali-date-picker";
import { EmptyState, SectionCard, SectionCardSkeleton, StatusBadge } from "../page-chrome";
import { api, ErrorBox, InfoBox } from "../ui";
import { productionErrorMessage } from "./production-errors";
import { SubcontractsSection, SUBCONTRACT_ACTION_LABELS, type Subcontract } from "./subcontracts-section";

export interface ProductionPermissions {
  canAdjust: boolean;
  canWriteOff: boolean;
}

interface Costs {
  materialRial: number; conversionRial: number; receivedRial: number; returnedRial: number;
  writtenOffRial: number; recoveredRial?: number; wipRial: number; unitCostRial: string | null;
}

export interface OrderSummary {
  id: string; reference: string; status: ProductionOrderStatus; outputItemId: string; outputName: string;
  plannedQuantity: string; receivedQuantity: string; scrappedQuantity: string; dueDate: string | null; version: number;
  receivableQuantity: string; outstandingQuantity: string; costs: Costs;
  stages?: { seq: number; code: string; label: string; completed: string; scrapped: string }[];
}

interface Stage {
  seq: number; code: string; label: string; assigneeName: string | null;
  completedQuantity: string; scrappedQuantity: string; reworkQuantity: string;
}

interface Material {
  materialItemId: string; name: string; unit: string | null; quantityPerUnit: string; requiredQuantity: string;
  issuedQuantity: string; issuedValueRial: number; returnedQuantity: string; onHand: string;
}

export interface OrderDetail {
  order: OrderSummary & { outputUnit: string | null };
  stages: Stage[];
  materials: Material[];
  actions: { id: string; action: string; actorName: string | null; amountRial: number | null; at: string; detail: Record<string, unknown> }[];
  /** GH #1567 6.3 — subcontracted stages and the branch's suppliers. */
  subcontracts?: Subcontract[];
  suppliers?: { id: string; name: string }[];
}

interface Bom {
  id: string; name: string; outputItemId: string; outputName: string; conversionCostPerUnitRial: number; isActive: boolean;
  lines: { materialItemId: string; name: string; unit: string | null; quantityPerUnit: string }[];
}

interface StockItem { id: string; name: string; sku: string | null; tracking: string; quantity: string }

export const STATUS_LABELS: Record<ProductionOrderStatus, string> = {
  draft: "پیش‌نویس",
  released: "رزرو مواد",
  in_progress: "در حال تولید",
  completed: "تکمیل‌شده",
  cancelled: "لغوشده",
};

const STATUS_TONE: Record<ProductionOrderStatus, "active" | "positive" | "neutral" | "danger"> = {
  draft: "neutral", released: "active", in_progress: "active", completed: "positive", cancelled: "danger",
};

const ACTION_LABELS: Record<string, string> = {
  create: "ایجاد سفارش", release: "رزرو مواد", issue: "حوالهٔ مواد به تولید", return: "برگشت مواد مصرف‌نشده",
  progress: "ثبت پیشرفت مرحله", rework: "ارسال برای دوباره‌کاری", assign: "تعیین مسئول مرحله", cost: "ثبت هزینهٔ تبدیل",
  receive: "ورود محصول به انبار", complete: "بستن سفارش", cancel: "لغو سفارش",
  ...SUBCONTRACT_ACTION_LABELS,
};

const COST_KIND_OPTIONS = [
  { value: "labour", label: "دستمزد" },
  { value: "subcontract", label: "پیمانکار (صورت‌حساب در خرید/هزینه ثبت می‌شود)" },
  { value: "overhead", label: "سربار" },
  { value: "standard", label: "هزینهٔ تبدیل استاندارد فرمول" },
];

/** Accepts Persian or Latin digits; returns canonical text or null. */
export function parseQuantity(raw: string): string | null {
  const text = toLatinDigits(raw).replace(/[٫,]/g, ".").trim();
  return /^\d+(\.\d{1,9})?$/.test(text) && Number(text) > 0 ? text : null;
}

const fa = (value: string | number) => toPersianDigits(String(value));

function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random()}`;
}

/** Progress of an order as "packed / planned". */
export function progressText(order: Pick<OrderSummary, "plannedQuantity" | "stages" | "receivedQuantity">): string {
  const last = order.stages?.[order.stages.length - 1];
  return `${fa(last?.completed ?? order.receivedQuantity)} از ${fa(order.plannedQuantity)}`;
}

type Tab = "orders" | "boms" | "report";

export function FashionProductionManager({ permissions }: { permissions: ProductionPermissions }) {
  const tabs = useMemo(() => [
    { key: "orders" as const, label: "سفارش‌های تولید" },
    { key: "boms" as const, label: "فرمول ساخت (BOM)" },
    { key: "report" as const, label: "گزارش و تطبیق" },
  ], []);
  const [tab, setTab] = useState<Tab>("orders");
  return (
    <IndustryManagerShell idPrefix="production" navLabel="بخش‌های تولید" tabs={tabs} activeTab={tab} onTabChange={setTab} error="">
      {tab === "orders" ? <OrdersBoard permissions={permissions} /> : null}
      {tab === "boms" ? <BomsSection canEdit={permissions.canAdjust} /> : null}
      {tab === "report" ? <ReportSection /> : null}
    </IndustryManagerShell>
  );
}

// ── orders ────────────────────────────────────────────────────────────────

const FILTERS: { key: "open" | ProductionOrderStatus | "all"; label: string }[] = [
  { key: "open", label: "باز" },
  { key: "draft", label: STATUS_LABELS.draft },
  { key: "released", label: STATUS_LABELS.released },
  { key: "in_progress", label: STATUS_LABELS.in_progress },
  { key: "completed", label: STATUS_LABELS.completed },
  { key: "cancelled", label: STATUS_LABELS.cancelled },
  { key: "all", label: "همه" },
];

function OrdersBoard({ permissions }: { permissions: ProductionPermissions }) {
  const money = useMoney();
  const [orders, setOrders] = useState<OrderSummary[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("open");
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api<{ orders?: OrderSummary[]; error?: string }>("/api/production-orders");
    if (!res.ok) { setError(productionErrorMessage(res.data.error)); setOrders([]); return; }
    setError("");
    setOrders(res.data.orders ?? []);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: orders?.length ?? 0, open: 0 };
    for (const o of orders ?? []) {
      c[o.status] = (c[o.status] ?? 0) + 1;
      if (o.status !== "completed" && o.status !== "cancelled") c.open += 1;
    }
    return c;
  }, [orders]);
  const visible = (orders ?? []).filter((o) =>
    filter === "all" ? true : filter === "open" ? o.status !== "completed" && o.status !== "cancelled" : o.status === filter);

  return (
    <div className="space-y-4">
      <SectionCard
        title="سفارش‌های تولید این شعبه"
        description="برش، دوخت، تکمیل، کنترل کیفیت و بسته‌بندی؛ مواد به بهای میانگین موزون از انبار خارج و محصول به بهای تمام‌شده وارد انبار می‌شود."
        actions={permissions.canAdjust ? (
          <Button onClick={() => setCreating(true)}><PlusIcon aria-hidden="true" className="size-4" />سفارش تولید تازه</Button>
        ) : null}
      >
        <div className="space-y-3">
          <FilterChipRow label="وضعیت سفارش">
            {FILTERS.map((f) => (
              <FilterChip key={f.key} selected={filter === f.key} onClick={() => setFilter(f.key)}>{f.label} ({fa(counts[f.key] ?? 0)})</FilterChip>
            ))}
          </FilterChipRow>
          {error ? <ErrorBox>{error}</ErrorBox> : null}
          {orders === null ? <SectionCardSkeleton /> : visible.length === 0 ? (
            <EmptyState title="سفارشی نیست" icon={FactoryIcon}>
              برای شروع، یک فرمول ساخت (مواد هر عدد محصول) بسازید و سپس سفارش تولید ثبت کنید.
            </EmptyState>
          ) : (
            <DataTable caption="سفارش‌های تولید">
              <DataTableHead>
                <Th>سفارش</Th><Th>محصول</Th><Th>پیشرفت</Th><Th>وضعیت</Th><Th>سررسید</Th><Th>کالای در جریان ساخت</Th>
              </DataTableHead>
              <DataTableBody>
                {visible.map((o) => (
                  <DataTableRow key={o.id} onClick={() => setOpenId(o.id)} className="cursor-pointer">
                    <Td><button type="button" className="font-medium underline-offset-4 hover:underline" onClick={() => setOpenId(o.id)}>{o.reference}</button></Td>
                    <Td>{o.outputName}</Td>
                    <Td>{progressText(o)}{Number(o.scrappedQuantity) > 0 ? <span className="ms-1 text-xs text-muted-foreground">ضایعات {fa(o.scrappedQuantity)}</span> : null}</Td>
                    <Td><StatusBadge tone={STATUS_TONE[o.status]}>{STATUS_LABELS[o.status]}</StatusBadge></Td>
                    <Td>{o.dueDate ? fa(o.dueDate) : "—"}</Td>
                    <Td>{money.formatText(String(o.costs.wipRial))}</Td>
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>
          )}
        </div>
      </SectionCard>

      <Sheet open={creating} onOpenChange={setCreating}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>سفارش تولید تازه</SheetTitle>
            <SheetDescription>مواد لازم از روی فرمول ساخت محاسبه و در سفارش ثابت می‌شود؛ تغییر بعدی فرمول روی این سفارش اثری ندارد.</SheetDescription>
          </SheetHeader>
          {creating ? <CreateOrderForm onCreated={(id) => { setCreating(false); setOpenId(id); void load(); }} /> : null}
        </SheetContent>
      </Sheet>

      <Sheet open={openId !== null} onOpenChange={(open) => { if (!open) setOpenId(null); }}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-3xl">
          <SheetHeader>
            <SheetTitle>سفارش تولید</SheetTitle>
            <SheetDescription>هر مرحله با یک دکمه ثبت می‌شود؛ موجودی و سند حسابداری هم‌زمان و یکجا ثبت می‌شوند.</SheetDescription>
          </SheetHeader>
          {openId ? <OrderPanel orderId={openId} permissions={permissions} onChanged={load} /> : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function CreateOrderForm({ onCreated }: { onCreated: (id: string) => void }) {
  const [boms, setBoms] = useState<Bom[] | null>(null);
  const [bomId, setBomId] = useState("");
  const [planned, setPlanned] = useState("");
  const [reference, setReference] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<{ boms?: Bom[]; error?: string }>("/api/production-boms").then((res) => {
      if (!res.ok) setError(productionErrorMessage(res.data.error));
      setBoms((res.data.boms ?? []).filter((b) => b.isActive));
    });
  }, []);

  async function submit() {
    const quantity = parseQuantity(planned);
    if (!bomId || !quantity) { setError("فرمول ساخت و تعداد را وارد کنید."); return; }
    setBusy(true);
    const res = await api<{ order?: { id: string }; error?: string }>("/api/production-orders", {
      method: "POST",
      body: JSON.stringify({ bomId, plannedQuantity: quantity, reference: reference.trim() || null, dueDate: dueDate || null, idempotencyKey: newKey() }),
    });
    setBusy(false);
    if (!res.ok || !res.data.order) { setError(productionErrorMessage(res.data.error)); return; }
    onCreated(res.data.order.id);
  }

  if (boms === null) return <div className="px-4"><SectionCardSkeleton /></div>;
  return (
    <div className="space-y-4 px-4 pb-6">
      {boms.length === 0 ? <InfoBox>هنوز فرمول ساختی ندارید؛ از زبانهٔ «فرمول ساخت» یکی بسازید.</InfoBox> : null}
      <div className="space-y-1.5">
        <Label>فرمول ساخت</Label>
        <SearchableSelect ariaLabel="فرمول ساخت" value={bomId} onChange={setBomId}
          options={boms.map((b) => ({ value: b.id, label: `${b.name} — ${b.outputName}` }))} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="po-planned">تعداد برنامه‌ریزی‌شده</Label>
        <Input id="po-planned" inputMode="decimal" value={planned} onChange={(e) => setPlanned(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="po-ref">شمارهٔ سفارش (اختیاری)</Label>
        <Input id="po-ref" value={reference} maxLength={60} onChange={(e) => setReference(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label>سررسید (اختیاری)</Label>
        <JalaliDatePicker value={dueDate} onChange={setDueDate} ariaLabel="سررسید" />
      </div>
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      <Button onClick={submit} disabled={busy || boms.length === 0}>ثبت سفارش</Button>
    </div>
  );
}

function OrderPanel({ orderId, permissions, onChanged }: { orderId: string; permissions: ProductionPermissions; onChanged: () => void }) {
  const money = useMoney();
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [error, setError] = useState("");
  const [shortage, setShortage] = useState<{ name: string; need: string; available: string; missing: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [receiveQty, setReceiveQty] = useState("");
  const [costKind, setCostKind] = useState("labour");
  const [costAmount, setCostAmount] = useState("");
  const [cancelReason, setCancelReason] = useState("");

  const load = useCallback(async () => {
    const res = await api<OrderDetail & { error?: string }>(`/api/production-orders/${orderId}`);
    if (!res.ok) { setError(productionErrorMessage(res.data.error)); return; }
    setDetail(res.data);
  }, [orderId]);
  useEffect(() => { void load(); }, [load]);

  async function act(body: Record<string, unknown>): Promise<boolean> {
    if (!detail) return false;
    setBusy(true);
    setError("");
    setShortage([]);
    const res = await api<OrderDetail & { error?: string; detail?: { shortages?: typeof shortage } }>(`/api/production-orders/${orderId}`, {
      method: "POST",
      body: JSON.stringify({ ...body, expectedVersion: detail.order.version, idempotencyKey: newKey() }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(productionErrorMessage(res.data.error));
      if (res.data.detail?.shortages) setShortage(res.data.detail.shortages);
      if (res.data.error === "version_conflict") void load();
      return false;
    }
    setDetail(res.data);
    onChanged();
    return true;
  }

  if (!detail) return <div className="px-4">{error ? <ErrorBox>{error}</ErrorBox> : <SectionCardSkeleton />}</div>;
  const { order, stages, materials } = detail;
  const open = order.status !== "completed" && order.status !== "cancelled";
  const canAct = permissions.canAdjust && open;
  const unit = order.outputUnit ?? "عدد";

  return (
    <div className="space-y-5 px-4 pb-6">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-lg font-semibold">{order.reference}</span>
        <StatusBadge tone={STATUS_TONE[order.status]}>{STATUS_LABELS[order.status]}</StatusBadge>
        <span className="text-sm text-muted-foreground">{order.outputName} · برنامه {fa(order.plannedQuantity)} {unit} · وارد انبار {fa(order.receivedQuantity)} · ضایعات {fa(order.scrappedQuantity)}</span>
      </div>

      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3" aria-label="خلاصهٔ بهای تمام‌شده">
        <div><dt className="text-muted-foreground">مواد</dt><dd>{money.formatText(String(order.costs.materialRial))}</dd></div>
        <div><dt className="text-muted-foreground">دستمزد و سربار</dt><dd>{money.formatText(String(order.costs.conversionRial))}</dd></div>
        <div><dt className="text-muted-foreground">کالای در جریان ساخت</dt><dd className="font-semibold">{money.formatText(String(order.costs.wipRial))}</dd></div>
        <div><dt className="text-muted-foreground">واردشده به انبار</dt><dd>{money.formatText(String(order.costs.receivedRial))}</dd></div>
        <div><dt className="text-muted-foreground">بهای هر عدد</dt><dd>{order.costs.unitCostRial ? money.formatText(order.costs.unitCostRial.split(".")[0]) : "—"}</dd></div>
        <div><dt className="text-muted-foreground">برگشت / زیان</dt><dd>{money.formatText(String(order.costs.returnedRial))} / {money.formatText(String(order.costs.writtenOffRial))}</dd></div>
      </dl>

      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {shortage.length > 0 ? (
        <ul className="list-disc space-y-1 ps-5 text-sm" aria-label="کمبود مواد">
          {shortage.map((s) => <li key={s.name}>{s.name}: نیاز {fa(s.need)}، آزاد {fa(s.available)}، کمبود {fa(s.missing)}</li>)}
        </ul>
      ) : null}

      <section aria-labelledby="po-materials" className="space-y-2">
        <h3 id="po-materials" className="font-medium">مواد</h3>
        <DataTable caption="مواد سفارش">
          <DataTableHead><Th>ماده</Th><Th>هر عدد</Th><Th>لازم</Th><Th>حواله‌شده</Th><Th>برگشتی</Th><Th>موجودی انبار</Th></DataTableHead>
          <DataTableBody>
            {materials.map((m) => (
              <DataTableRow key={m.materialItemId}>
                <Td>{m.name}</Td><Td>{fa(m.quantityPerUnit)} {m.unit ?? ""}</Td><Td>{fa(m.requiredQuantity)}</Td>
                <Td>{fa(m.issuedQuantity)}</Td><Td>{fa(m.returnedQuantity)}</Td><Td>{fa(m.onHand)}</Td>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
        {canAct && order.status === "draft" ? <Button disabled={busy} onClick={() => act({ action: "release" })}>رزرو مواد و آزادسازی سفارش</Button> : null}
        {canAct && (order.status === "released" || order.status === "in_progress") ? (
          <Button variant="outline" disabled={busy} onClick={() => act({ action: "issue" })}>حوالهٔ باقی‌ماندهٔ مواد به تولید</Button>
        ) : null}
      </section>

      <section aria-labelledby="po-stages" className="space-y-2">
        <h3 id="po-stages" className="font-medium">مراحل</h3>
        <ol className="space-y-2">
          {stages.map((s, i) => (
            <StageRow key={s.code} stage={s} previous={i === 0 ? null : stages[i - 1]} planned={order.plannedQuantity} stages={stages}
              disabled={!canAct || order.status !== "in_progress" || busy} onAct={act} />
          ))}
        </ol>
      </section>

      <SubcontractsSection
        subcontracts={detail.subcontracts ?? []}
        suppliers={detail.suppliers ?? []}
        stages={stages}
        materials={materials}
        orderStatus={order.status}
        canAct={canAct}
        canApprove={permissions.canWriteOff}
        busy={busy}
        onAct={act}
        onError={setError}
      />

      {canAct && order.status !== "draft" ? (
        <section aria-labelledby="po-cost" className="space-y-2">
          <h3 id="po-cost" className="font-medium">هزینهٔ تبدیل</h3>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-56"><SearchableSelect ariaLabel="نوع هزینه" value={costKind} onChange={setCostKind} options={COST_KIND_OPTIONS} /></div>
            <Input aria-label={`مبلغ (${money.unitLabel})`} placeholder={`مبلغ (${money.unitLabel})`} inputMode="numeric" className="max-w-40"
              value={costAmount} onChange={(e) => setCostAmount(e.target.value)} />
            <Button variant="outline" disabled={busy} onClick={async () => {
              let amountRial: number;
              try { amountRial = money.parse(costAmount); } catch { setError("مبلغ معتبر نیست."); return; }
              if (await act({ action: "cost", kind: costKind, amountRial })) setCostAmount("");
            }}>ثبت هزینه</Button>
          </div>
        </section>
      ) : null}

      {canAct && order.status === "in_progress" ? (
        <section aria-labelledby="po-receive" className="space-y-2">
          <h3 id="po-receive" className="font-medium">ورود محصول به انبار</h3>
          <p className="text-sm text-muted-foreground">آمادهٔ ورود: {fa(order.receivableQuantity)} {unit}. ورود آخر کل مانده را می‌برد تا کالای در جریان ساخت صفر شود.</p>
          <div className="flex flex-wrap items-end gap-2">
            <Input aria-label="تعداد ورودی" inputMode="decimal" className="max-w-32" value={receiveQty} onChange={(e) => setReceiveQty(e.target.value)} />
            <Button disabled={busy || Number(order.receivableQuantity) <= 0} onClick={async () => {
              const quantity = parseQuantity(receiveQty || order.receivableQuantity);
              if (!quantity) { setError("تعداد معتبر نیست."); return; }
              if (await act({ action: "receive", quantity })) setReceiveQty("");
            }}>ورود به انبار</Button>
            {Number(order.outstandingQuantity) === 0 ? <Button variant="outline" disabled={busy} onClick={() => act({ action: "complete" })}>بستن سفارش</Button> : null}
          </div>
        </section>
      ) : null}

      {canAct ? (
        <section aria-labelledby="po-cancel" className="space-y-2">
          <h3 id="po-cancel" className="font-medium">لغو کنترل‌شده</h3>
          <p className="text-sm text-muted-foreground">
            رزرو مواد آزاد می‌شود. مانده کالای در جریان ساخت به هزینهٔ کاهش ارزش موجودی می‌رود
            {permissions.canWriteOff ? "." : " و به دسترسی «تأیید سند حسابداری» نیاز دارد."}
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <Input aria-label="دلیل لغو" placeholder="دلیل لغو" className="max-w-sm" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
            <Button variant="destructive" disabled={busy || cancelReason.trim().length < 3} onClick={() => act({ action: "cancel", reason: cancelReason.trim() })}>لغو سفارش</Button>
          </div>
        </section>
      ) : null}

      <section aria-labelledby="po-trail" className="space-y-2">
        <h3 id="po-trail" className="font-medium">سابقه</h3>
        <ol className="space-y-1 text-sm">
          {detail.actions.map((a) => (
            <li key={a.id} className="flex flex-wrap gap-x-2">
              <span>{ACTION_LABELS[a.action] ?? a.action}</span>
              {a.amountRial ? <span className="text-muted-foreground">{money.formatText(String(a.amountRial))}</span> : null}
              <span className="text-muted-foreground">{a.actorName ?? "—"}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function StageRow({ stage, previous, planned, stages, disabled, onAct }: {
  stage: Stage; previous: Stage | null; planned: string; stages: Stage[]; disabled: boolean;
  onAct: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [completed, setCompleted] = useState("");
  const [scrapped, setScrapped] = useState("");
  const [reworkTo, setReworkTo] = useState("");
  const inflow = Number(previous ? previous.completedQuantity : planned);
  const waiting = Math.max(inflow - Number(stage.completedQuantity) - Number(stage.scrappedQuantity), 0);
  const earlier = stages.filter((s) => s.seq < stage.seq);
  return (
    <li className="rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{fa(stage.seq)}. {stage.label}</span>
        <span className="text-sm text-muted-foreground">
          انجام‌شده {fa(stage.completedQuantity)} · منتظر {fa(waiting)} · ضایعات {fa(stage.scrappedQuantity)}
          {Number(stage.reworkQuantity) > 0 ? ` · دوباره‌کاری ${fa(stage.reworkQuantity)}` : ""}
          {stage.assigneeName ? ` · مسئول: ${stage.assigneeName}` : ""}
        </span>
      </div>
      {!disabled && waiting > 0 ? (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <Input aria-label={`تعداد انجام‌شده در ${stage.label}`} placeholder="انجام‌شده" inputMode="decimal" className="max-w-28" value={completed} onChange={(e) => setCompleted(e.target.value)} />
          <Input aria-label={`ضایعات در ${stage.label}`} placeholder="ضایعات" inputMode="decimal" className="max-w-28" value={scrapped} onChange={(e) => setScrapped(e.target.value)} />
          <Button size="sm" onClick={async () => {
            const c = completed ? parseQuantity(completed) : null;
            const s = scrapped ? parseQuantity(scrapped) : null;
            if (!c && !s) return;
            if (await onAct({ action: "progress", stage: stage.code, completed: c, scrapped: s })) { setCompleted(""); setScrapped(""); }
          }}>ثبت</Button>
          {earlier.length > 0 ? (
            <>
              <div className="min-w-36"><SearchableSelect ariaLabel={`برگشت از ${stage.label} به`} placeholder="دوباره‌کاری در…" value={reworkTo} onChange={setReworkTo}
                options={earlier.map((e) => ({ value: e.code, label: e.label }))} /></div>
              <Button size="sm" variant="outline" disabled={!reworkTo || !parseQuantity(completed)} onClick={async () => {
                const quantity = parseQuantity(completed);
                if (quantity && await onAct({ action: "rework", fromStage: stage.code, toStage: reworkTo, quantity })) setCompleted("");
              }}>ارسال برای دوباره‌کاری</Button>
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

// ── BOMs ──────────────────────────────────────────────────────────────────

function BomsSection({ canEdit }: { canEdit: boolean }) {
  const money = useMoney();
  const [boms, setBoms] = useState<Bom[] | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Bom | "new" | null>(null);
  const load = useCallback(async () => {
    const res = await api<{ boms?: Bom[]; error?: string }>("/api/production-boms");
    if (!res.ok) setError(productionErrorMessage(res.data.error));
    setBoms(res.data.boms ?? []);
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <SectionCard
      title="فرمول ساخت"
      description="مواد لازم برای ساخت یک عدد محصول (به واحد خود ماده، مثلاً متر پارچه) و هزینهٔ تبدیل استاندارد."
      actions={canEdit ? <Button onClick={() => setEditing("new")}><PlusIcon aria-hidden="true" className="size-4" />فرمول تازه</Button> : null}
    >
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {boms === null ? <SectionCardSkeleton /> : boms.length === 0 ? (
        <EmptyState title="فرمولی نیست" icon={FactoryIcon}>برای هر مدل لباس یک بار مواد لازم را تعریف کنید.</EmptyState>
      ) : (
        <DataTable caption="فرمول‌های ساخت">
          <DataTableHead><Th>نام</Th><Th>محصول</Th><Th>مواد</Th><Th>هزینهٔ تبدیل هر عدد</Th><Th>وضعیت</Th></DataTableHead>
          <DataTableBody>
            {boms.map((b) => (
              <DataTableRow key={b.id} onClick={canEdit ? () => setEditing(b) : undefined} className={canEdit ? "cursor-pointer" : undefined}>
                <Td>{b.name}</Td><Td>{b.outputName}</Td>
                <Td>{b.lines.map((l) => `${l.name} ${fa(l.quantityPerUnit)}${l.unit ? ` ${l.unit}` : ""}`).join("، ")}</Td>
                <Td>{money.formatText(String(b.conversionCostPerUnitRial))}</Td>
                <Td><StatusBadge tone={b.isActive ? "positive" : "neutral"}>{b.isActive ? "فعال" : "غیرفعال"}</StatusBadge></Td>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      )}
      <Sheet open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null); }}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>{editing === "new" ? "فرمول ساخت تازه" : "ویرایش فرمول ساخت"}</SheetTitle>
            <SheetDescription>سفارش‌های ثبت‌شده نسخهٔ خود را نگه می‌دارند.</SheetDescription>
          </SheetHeader>
          {editing ? <BomEditor bom={editing === "new" ? null : editing} onSaved={() => { setEditing(null); void load(); }} /> : null}
        </SheetContent>
      </Sheet>
    </SectionCard>
  );
}

export function BomEditor({ bom, onSaved }: { bom: Bom | null; onSaved: () => void }) {
  const money = useMoney();
  const [items, setItems] = useState<StockItem[] | null>(null);
  const [name, setName] = useState(bom?.name ?? "");
  const [outputItemId, setOutputItemId] = useState(bom?.outputItemId ?? "");
  const [conversion, setConversion] = useState(bom && bom.conversionCostPerUnitRial > 0 ? money.formatText(String(bom.conversionCostPerUnitRial), { withUnit: false }) : "");
  const [lines, setLines] = useState<{ materialItemId: string; quantityPerUnit: string }[]>(
    bom?.lines.map((l) => ({ materialItemId: l.materialItemId, quantityPerUnit: l.quantityPerUnit })) ?? [{ materialItemId: "", quantityPerUnit: "" }]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<{ items?: StockItem[] }>("/api/stock/items?forCounts=false").then((res) =>
      setItems((res.data.items ?? []).filter((i) => i.tracking === "none")));
  }, []);
  const options = (items ?? []).map((i) => ({ value: i.id, label: i.sku ? `${i.name} (${i.sku})` : i.name, searchString: `${i.name} ${i.sku ?? ""}` }));

  async function save() {
    const parsed = lines.map((l) => ({ materialItemId: l.materialItemId, quantityPerUnit: parseQuantity(l.quantityPerUnit) }));
    if (!name.trim() || !outputItemId || parsed.some((l) => !l.materialItemId || !l.quantityPerUnit)) {
      setError("نام، محصول و مقدار هر ماده را کامل کنید.");
      return;
    }
    let conversionCostPerUnitRial = 0;
    if (conversion.trim()) {
      try { conversionCostPerUnitRial = money.parse(conversion); } catch { setError("هزینهٔ تبدیل معتبر نیست."); return; }
    }
    setBusy(true);
    const res = await api<{ error?: string }>(bom ? `/api/production-boms/${bom.id}` : "/api/production-boms", {
      method: bom ? "PUT" : "POST",
      body: JSON.stringify({ name: name.trim(), outputItemId, conversionCostPerUnitRial, lines: parsed }),
    });
    setBusy(false);
    if (!res.ok) { setError(productionErrorMessage(res.data.error)); return; }
    onSaved();
  }

  if (items === null) return <div className="px-4"><SectionCardSkeleton /></div>;
  return (
    <div className="space-y-4 px-4 pb-6">
      <div className="space-y-1.5">
        <Label htmlFor="bom-name">نام فرمول</Label>
        <Input id="bom-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label>محصول نهایی (تنوع سایز/رنگ)</Label>
        <SearchableSelect ariaLabel="محصول نهایی" value={outputItemId} onChange={setOutputItemId} options={options} />
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">مواد برای یک عدد</legend>
        {lines.map((line, index) => (
          <div key={index} className="flex flex-wrap items-end gap-2">
            <div className="min-w-56 flex-1">
              <SearchableSelect ariaLabel={`ماده ${index + 1}`} value={line.materialItemId}
                onChange={(value) => setLines((ls) => ls.map((l, i) => (i === index ? { ...l, materialItemId: value } : l)))}
                options={options.filter((o) => o.value !== outputItemId)} />
            </div>
            <Input aria-label={`مقدار ماده ${index + 1}`} placeholder="مقدار" inputMode="decimal" className="max-w-28" value={line.quantityPerUnit}
              onChange={(e) => setLines((ls) => ls.map((l, i) => (i === index ? { ...l, quantityPerUnit: e.target.value } : l)))} />
            <Button variant="ghost" size="icon" aria-label={`حذف ماده ${index + 1}`} disabled={lines.length === 1}
              onClick={() => setLines((ls) => ls.filter((_, i) => i !== index))}><Trash2Icon aria-hidden="true" className="size-4" /></Button>
          </div>
        ))}
        <Button variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, { materialItemId: "", quantityPerUnit: "" }])}>
          <PlusIcon aria-hidden="true" className="size-4" />افزودن ماده
        </Button>
      </fieldset>
      <div className="space-y-1.5">
        <Label htmlFor="bom-conv">هزینهٔ تبدیل استاندارد هر عدد ({money.unitLabel}، اختیاری)</Label>
        <Input id="bom-conv" inputMode="numeric" value={conversion} onChange={(e) => setConversion(e.target.value)} />
      </div>
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      <Button onClick={save} disabled={busy}>ذخیره</Button>
    </div>
  );
}

// ── report ────────────────────────────────────────────────────────────────

interface Report {
  openOrders: number; completedOrders: number; cancelledOrders: number; plannedQuantity: string; receivedQuantity: string;
  scrappedQuantity: string; scrapRate: string | null; receivedValueRial: number; averageUnitCostRial: string | null;
  materialCostRial: number; conversionCostRial: number; wipRial: number;
  reconciliation: { subledgerWipRial: number; glWipRial: number; reconciled: boolean };
  subcontracting?: {
    openSubcontracts: number; unitsWithSubcontractors: string; accruedRial: number; chargebackRial: number;
    reconciliation: { subledgerPayableRial: number; glPayableRial: number; reconciled: boolean };
  };
}

function ReportSection() {
  const money = useMoney();
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void api<{ report?: Report; error?: string }>("/api/production-orders?view=report").then((res) => {
      if (!res.ok || !res.data.report) { setError(productionErrorMessage(res.data.error)); return; }
      setReport(res.data.report);
    });
  }, []);
  if (error) return <ErrorBox>{error}</ErrorBox>;
  if (!report) return <SectionCardSkeleton />;
  const rows: [string, string][] = [
    ["سفارش‌های باز / تکمیل / لغو", `${fa(report.openOrders)} / ${fa(report.completedOrders)} / ${fa(report.cancelledOrders)}`],
    ["تعداد واردشده به انبار", fa(report.receivedQuantity)],
    ["ضایعات", `${fa(report.scrappedQuantity)}${report.scrapRate ? ` (${fa((Number(report.scrapRate) * 100).toFixed(1))}٪)` : ""}`],
    ["بهای تمام‌شدهٔ محصول واردشده", money.formatText(String(report.receivedValueRial))],
    ["میانگین بهای هر عدد", report.averageUnitCostRial ? money.formatText(report.averageUnitCostRial.split(".")[0]) : "—"],
    ["مواد مصرفی (خالص)", money.formatText(String(report.materialCostRial))],
    ["دستمزد، پیمانکار و سربار", money.formatText(String(report.conversionCostRial))],
    ["کالای در جریان ساخت این شعبه", money.formatText(String(report.wipRial))],
  ];
  return (
    <div className="space-y-4">
      <SectionCard title="گزارش تولید" description="ارقام از سفارش‌های همین شعبه؛ همه از اسناد ثبت‌شده، بدون برآورد.">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          {rows.map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="font-medium">{value}</dd></div>)}
        </dl>
      </SectionCard>
      <SectionCard title="تطبیق با دفتر کل" description="جمع کالای در جریان ساخت همهٔ سفارش‌ها (کل کسب‌وکار) در برابر ماندهٔ حساب ۱۳۱۰.">
        {report.reconciliation.reconciled
          ? <InfoBox>تطبیق است: {money.formatText(String(report.reconciliation.glWipRial))}</InfoBox>
          : <ErrorBox>مغایرت: سفارش‌ها {money.formatText(String(report.reconciliation.subledgerWipRial))}، دفتر کل {money.formatText(String(report.reconciliation.glWipRial))}</ErrorBox>}
      </SectionCard>
      {report.subcontracting ? (
        <SectionCard title="پیمانکاران" description="اجرت کار پذیرفته‌شده و کسر خسارت، در برابر بستانکار حساب‌های پرداختنی از همین قراردادها؛ تسویه با پرداخت عادی به تأمین‌کننده.">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-muted-foreground">قرارداد باز</dt><dd className="font-medium">{fa(report.subcontracting.openSubcontracts)}</dd></div>
            <div><dt className="text-muted-foreground">واحد نزد پیمانکاران</dt><dd className="font-medium">{fa(report.subcontracting.unitsWithSubcontractors)}</dd></div>
            <div><dt className="text-muted-foreground">اجرت پذیرفته‌شده</dt><dd className="font-medium">{money.formatText(String(report.subcontracting.accruedRial))}</dd></div>
            <div><dt className="text-muted-foreground">کسر خسارت</dt><dd className="font-medium">{money.formatText(String(report.subcontracting.chargebackRial))}</dd></div>
          </dl>
          <div className="mt-3">
            {report.subcontracting.reconciliation.reconciled
              ? <InfoBox>تطبیق است: {money.formatText(String(report.subcontracting.reconciliation.glPayableRial))}</InfoBox>
              : <ErrorBox>مغایرت: قراردادها {money.formatText(String(report.subcontracting.reconciliation.subledgerPayableRial))}، دفتر کل {money.formatText(String(report.subcontracting.reconciliation.glPayableRial))}</ErrorBox>}
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}
