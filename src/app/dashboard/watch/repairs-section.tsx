"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatPersianNumber, formatQuantity, toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { api, Field, inputClass } from "../ui";
import { CustomerPicker, type PickerCustomer } from "../customer-picker";
import {
  REPAIR_STATUS_LABELS,
  type RepairPart,
  type RepairStatus,
  type RepairTicket,
  type Runner,
  type SerialUnit,
} from "./watch-manager";
import { cardClass } from "../page-chrome";

const watchInputClass = `${inputClass} min-h-[52px] !border-border !bg-card shadow-none placeholder:text-muted-foreground focus-visible:border-amber-500 dark:focus-visible:border-amber-500/60 focus-visible:ring-amber-400/30 dark:focus-visible:ring-amber-400/40`;
const secondaryActionClass =
  "min-h-[44px] border-border bg-card px-3 text-xs text-foreground/80 hover:border-amber-300 dark:hover:border-amber-500/40 hover:bg-amber-50 dark:hover:bg-amber-500/15 hover:text-foreground focus-visible:border-amber-500 dark:focus-visible:border-amber-500/60 focus-visible:ring-amber-400/30 dark:focus-visible:ring-amber-400/40";

const STATUS_BADGE_CLASS: Record<RepairStatus, string> = {
  received: "bg-sky-100 dark:bg-sky-500/20 text-sky-900 dark:text-sky-100",
  in_progress: "bg-amber-100 dark:bg-amber-500/20 text-amber-900 dark:text-amber-200",
  ready: "bg-emerald-100 dark:bg-emerald-500/20 text-emerald-900 dark:text-emerald-100",
  closed: "bg-muted text-muted-foreground",
  cancelled: "bg-rose-100 dark:bg-rose-500/20 text-rose-900 dark:text-rose-100",
};

/** The next status a ticket can be moved to by a bare status change — closing is a separate, posting action. */
const NEXT_STATUSES: Record<RepairStatus, RepairStatus[]> = {
  received: ["in_progress", "ready", "cancelled"],
  in_progress: ["ready", "cancelled"],
  ready: ["cancelled"],
  closed: [],
  cancelled: [],
};

export function RepairsSection({
  tickets,
  units,
  busy,
  run,
}: {
  tickets: RepairTicket[];
  units: SerialUnit[];
  busy: boolean;
  run: Runner;
}) {
  const money = useMoney();
  const [itemDescription, setItemDescription] = useState("");
  const [reportedIssue, setReportedIssue] = useState("");
  const [serialId, setSerialId] = useState("");
  // Issue #795 item 12 — the intake connects the job to the person. Left
  // empty for a shop-sold serial, the server resolves the original buyer
  // from the persisted invoice; picking one here explicitly overrides it
  // (the current owner may differ from the original buyer).
  const [customer, setCustomer] = useState<PickerCustomer | null>(null);
  const [laborCharge, setLaborCharge] = useState("0");
  // Empty = the business's own rate from «تنظیمات مالیات»: the intake route
  // resolves an omitted rate from `tax.config` (audit F05). A typed value,
  // 0 included, overrides it for this ticket.
  const [vatPercent, setVatPercent] = useState("");

  async function intake(e: React.FormEvent) {
    e.preventDefault();
    if (!itemDescription.trim()) return;
    const ok = await run(() =>
      api("/api/watch/repairs", {
        method: "POST",
        body: JSON.stringify({
          itemDescription,
          reportedIssue: reportedIssue.trim() || null,
          serialId: serialId || null,
          customerId: customer?.id || null,
          laborCharge: money.fromInput(Math.max(0, Math.round(Number(laborCharge || 0)))),
          vatPercent: vatPercent.trim() === "" ? undefined : Number(vatPercent),
        }),
      }),
    );
    if (ok) {
      setItemDescription("");
      setReportedIssue("");
      setSerialId("");
      setCustomer(null);
      setLaborCharge("0");
    }
  }

  return (
    <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_18rem] lg:gap-5 lg:grid-cols-[minmax(0,1fr)_21rem] xl:grid-cols-[minmax(0,1fr)_24rem]">
      <section
        aria-labelledby="watch-repairs-heading"
        className={`order-2 min-w-0 overflow-hidden ${cardClass} md:order-1`}
      >
        <div className="border-b border-border/80 px-4 py-4 sm:px-5">
          <h2 id="watch-repairs-heading" className="font-semibold text-foreground">
            تیکت‌های تعمیر
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            پذیرش → مصرف قطعات → اجرت → تسویه و بستن. با بستن تیکت، درآمد و بهای قطعات در دفتر ثبت می‌شود.
          </p>
        </div>

        <ul className="divide-y divide-border/80">
          {tickets.map((ticket) => (
            <TicketRow key={ticket.id} ticket={ticket} busy={busy} run={run} />
          ))}
          {tickets.length === 0 ? (
            <li className="px-4 py-5 text-sm text-muted-foreground sm:px-5">تیکتی ثبت نشده است.</li>
          ) : null}
        </ul>
      </section>

      <aside className="order-1 min-w-0 md:order-2">
        <div className={`${cardClass} p-4 md:sticky md:top-4 sm:p-5`}>
          <h2 className="font-semibold text-foreground">پذیرش تعمیر</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            اگر دستگاه از همین فروشگاه فروخته شده باشد، با انتخاب سریال، گارانتی به‌صورت خودکار بررسی می‌شود.
          </p>

          <form onSubmit={intake} className="mt-4">
            <Field label="شرح کالا">
              <input
                className={watchInputClass}
                value={itemDescription}
                onChange={(e) => setItemDescription(e.target.value)}
                placeholder="مثلاً ساعت مچی سیتیزن مشکی"
                required
              />
            </Field>
            <Field label="ایراد اعلامی">
              <input
                className={watchInputClass}
                value={reportedIssue}
                onChange={(e) => setReportedIssue(e.target.value)}
                placeholder="اختیاری"
              />
            </Field>
            <Field label="دستگاه فروشگاه" hint="اختیاری — فقط برای دستگاه‌های سریال‌دار خودمان.">
              <SearchableSelect
                className={watchInputClass}
                value={serialId}
                onChange={setSerialId}
                options={units.map((u) => ({
                  value: u.id,
                  label: `${u.itemName} — ${u.serialNumber}`,
                }))}
                placeholder="بدون سریال"
              />
            </Field>
            <Field
              label="مشتری"
              hint="خالی بماند، برای دستگاه فروشگاهی خریدار فاکتور به‌صورت خودکار ثبت می‌شود."
            >
              <CustomerPicker
                customer={customer}
                onChange={setCustomer}
                idPrefix="watch-repair-customer"
              />
            </Field>
            <Field label={`اجرت تعمیر (${money.unitLabel})`}>
              <PersianNumberInput
                className={watchInputClass}
                dir="ltr"
                inputMode="numeric"
                value={laborCharge}
                onChange={(e) => setLaborCharge(e.target.value)}
              />
            </Field>
            <Field label="مالیات (٪)">
              <PersianNumberInput
                className={watchInputClass}
                dir="ltr"
                inputMode="decimal"
                value={vatPercent}
                placeholder="نرخ کسب‌وکار"
                onChange={(e) => setVatPercent(e.target.value)}
              />
            </Field>
            <Button
              type="submit"
              disabled={busy}
              size="lg"
              className="min-h-[52px] w-full border border-amber-300 dark:border-amber-500/40 px-5 font-semibold focus-visible:ring-amber-400/30 dark:focus-visible:ring-amber-400/40"
            >
              پذیرش
            </Button>
          </form>
        </div>
      </aside>
    </div>
  );
}

function MetaItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words font-medium text-foreground/80">{children}</dd>
    </div>
  );
}

function TicketRow({ ticket, busy, run }: { ticket: RepairTicket; busy: boolean; run: Runner }) {
  const money = useMoney();
  const [panel, setPanel] = useState<"parts" | "close" | "estimate" | null>(null);
  const toggle = (next: "parts" | "close" | "estimate") =>
    setPanel((current) => (current === next ? null : next));
  const isOpen = ticket.status !== "closed" && ticket.status !== "cancelled";

  return (
    <li className="flex min-w-0 flex-col gap-3 px-4 py-4 sm:px-5">
      <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <h3 className="min-w-0 break-words font-semibold text-foreground">
              تیکت {formatPersianNumber(ticket.ticketNumber)} — {ticket.itemDescription}
            </h3>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASS[ticket.status]}`}>
              {REPAIR_STATUS_LABELS[ticket.status]}
            </span>
            {ticket.underWarranty ? (
              <span className="rounded-full bg-emerald-100 dark:bg-emerald-500/20 px-2 py-0.5 text-xs font-medium text-emerald-900 dark:text-emerald-100">
                در گارانتی
              </span>
            ) : null}
          </div>

          <dl className="mt-3 grid min-w-0 gap-x-5 gap-y-2 text-xs text-muted-foreground sm:grid-cols-2 xl:grid-cols-4">
            {ticket.reportedIssue ? <MetaItem label="ایراد اعلامی">{ticket.reportedIssue}</MetaItem> : null}
            <MetaItem label="اجرت">{money.format(ticket.laborCharge)}</MetaItem>
            <MetaItem label="مالیات">{toPersianDigits(String(ticket.vatPercent))}٪</MetaItem>
          </dl>
        </div>

        <div className="grid shrink-0 grid-cols-2 gap-2 sm:flex sm:flex-wrap lg:justify-end">
          {NEXT_STATUSES[ticket.status].map((status) => (
            <Button
              key={status}
              type="button"
              variant="outline"
              size="sm"
              className={secondaryActionClass}
              disabled={busy}
              onClick={() =>
                run(() =>
                  api(`/api/watch/repairs/${ticket.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ status }),
                  }),
                )
              }
            >
              {REPAIR_STATUS_LABELS[status]}
            </Button>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={secondaryActionClass}
            disabled={busy}
            onClick={() => toggle("parts")}
          >
            قطعات
          </Button>
          {isOpen ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={secondaryActionClass}
              disabled={busy}
              onClick={() => toggle("estimate")}
            >
              برآورد
            </Button>
          ) : null}
          {isOpen ? (
            <Button
              type="button"
              size="sm"
              className="min-h-[44px] border border-amber-300 dark:border-amber-500/40 px-3 text-xs font-semibold focus-visible:ring-amber-400/30 dark:focus-visible:ring-amber-400/40"
              disabled={busy}
              onClick={() => toggle("close")}
            >
              تسویه و بستن
            </Button>
          ) : null}
        </div>
      </div>

      {panel === "parts" ? <PartsPanel ticket={ticket} busy={busy} run={run} /> : null}
      {panel === "close" ? (
        <ClosePanel ticket={ticket} busy={busy} run={run} onDone={() => setPanel(null)} />
      ) : null}
      {panel === "estimate" ? <EstimatePanel ticket={ticket} busy={busy} run={run} /> : null}
    </li>
  );
}

function PanelShell({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl bg-amber-50/60 dark:bg-amber-500/15 p-3 sm:p-4">{children}</div>;
}

function PartsPanel({ ticket, busy, run }: { ticket: RepairTicket; busy: boolean; run: Runner }) {
  const money = useMoney();
  const [parts, setParts] = useState<RepairPart[]>([]);
  const [loading, setLoading] = useState(true);
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unitCost, setUnitCost] = useState("");
  const [charge, setCharge] = useState("");
  const [source, setSource] = useState("stock");

  const load = useCallback(() => {
    setLoading(true);
    api<{ parts: RepairPart[] }>(`/api/watch/repairs/${ticket.id}`).then(({ ok, data }) => {
      setLoading(false);
      if (ok) setParts(data.parts);
    });
  }, [ticket.id]);
  useEffect(load, [load]);

  const isOpen = ticket.status !== "closed" && ticket.status !== "cancelled";

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!description.trim()) return;
    const ok = await run(() =>
      api(`/api/watch/repairs/${ticket.id}/parts`, {
        method: "POST",
        body: JSON.stringify({
          description,
          quantity: quantity || "1",
          unitCost: money.fromInput(Math.max(0, Math.round(Number(unitCost || 0)))),
          charge: money.fromInput(Math.max(0, Math.round(Number(charge || 0)))),
          source,
        }),
      }),
    );
    if (ok) {
      setDescription("");
      setQuantity("1");
      setUnitCost("");
      setCharge("");
      setSource("stock");
      load();
    }
  }

  return (
    <PanelShell>
      <ul className="mb-3 space-y-2">
        {loading ? <li><LoadingSkeleton rows={2} compact /></li> : null}
        {!loading && parts.length === 0 ? (
          <li className="text-xs text-muted-foreground">قطعه‌ای ثبت نشده است.</li>
        ) : null}
        {parts.map((part) => (
          <li key={part.id} className="flex items-center justify-between gap-3 text-xs text-foreground/80">
            <span className="min-w-0 break-words">
              {part.description} × {formatQuantity(part.quantity)} — بهای تمام‌شده {money.format(part.unitCost)} / دریافتی{" "}
              {money.format(part.charge)}
              {part.source === "external" ? " · خرید بیرونی" : " · از انبار"}
            </span>
            {isOpen ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={secondaryActionClass}
                disabled={busy}
                onClick={async () => {
                  const ok = await run(() =>
                    api(`/api/watch/repairs/${ticket.id}/parts/${part.id}`, { method: "DELETE" }),
                  );
                  if (ok) load();
                }}
              >
                حذف
              </Button>
            ) : null}
          </li>
        ))}
      </ul>

      {isOpen ? (
        <form onSubmit={add} className="grid min-w-0 gap-3 sm:grid-cols-4">
          <Field label="شرح قطعه">
            <input
              className={watchInputClass}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
            />
          </Field>
          <Field label="تعداد">
            <PersianNumberInput
              className={watchInputClass}
              dir="ltr"
              inputMode="decimal"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </Field>
          <Field label={`بهای تمام‌شده (${money.unitLabel})`}>
            <PersianNumberInput
              className={watchInputClass}
              dir="ltr"
              inputMode="numeric"
              value={unitCost}
              onChange={(e) => setUnitCost(e.target.value)}
            />
          </Field>
          <Field
            label={`دریافتی از مشتری (${money.unitLabel})`}
            hint={ticket.underWarranty ? "در گارانتی فقط با ثبت «علت خارج از پوشش» مبلغ مجاز است." : undefined}
          >
            <PersianNumberInput
              className={watchInputClass}
              dir="ltr"
              inputMode="numeric"
              value={charge}
              onChange={(e) => setCharge(e.target.value)}
            />
          </Field>
          <Field label="منبع قطعه" hint="«از انبار» هنگام بستن تیکت از موجودی کسر می‌شود.">
            <SearchableSelect
              className={watchInputClass}
              value={source}
              onChange={setSource}
              options={[
                { value: "stock", label: "از انبار" },
                { value: "external", label: "خرید بیرونی" },
              ]}
            />
          </Field>
          <div className="sm:col-span-4">
            <Button type="submit" disabled={busy} size="sm" className="min-h-[44px] border border-amber-300 dark:border-amber-500/40 px-5 font-semibold">
              افزودن قطعه
            </Button>
          </div>
        </form>
      ) : null}
    </PanelShell>
  );
}

function EstimatePanel({ ticket, busy, run }: { ticket: RepairTicket; busy: boolean; run: Runner }) {
  const money = useMoney();
  const [labor, setLabor] = useState(String(money.toInput(ticket.estimatedLaborRial)));
  const [parts, setParts] = useState(String(money.toInput(ticket.estimatedPartsRial)));
  const [discount, setDiscount] = useState(String(money.toInput(ticket.estimatedDiscountRial)));

  const hasEstimate = ticket.estimatedTotalRial > 0;
  const approved =
    Boolean(ticket.estimateApprovedAt) && ticket.estimateApprovedVersion === ticket.estimateVersion;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const ok = await run(() =>
      api(`/api/watch/repairs/${ticket.id}/estimate`, {
        method: "PUT",
        body: JSON.stringify({
          laborRial: money.fromInput(Math.max(0, Math.round(Number(labor || 0)))),
          partsRial: money.fromInput(Math.max(0, Math.round(Number(parts || 0)))),
          discountRial: money.fromInput(Math.max(0, Math.round(Number(discount || 0)))),
        }),
      }),
    );
    if (ok) {
      setLabor("");
      setParts("");
      setDiscount("");
    }
  }

  return (
    <PanelShell>
      <p className="mb-3 text-xs leading-5 text-muted-foreground">
        برآورد هزینه باید پیش از شروع کار (در حال تعمیر) به تأیید مشتری برسد. برآورد شامل مالیات با نرخ همین
        تیکت است تا مبلغ تأییدشده همان مبلغ قابل پرداخت باشد؛ هر تغییر مالی (برآورد جدید، تغییر اجرت یا
        مالیات، افزودن/حذف قطعهٔ پولی) تأیید قبلی را باطل می‌کند.
      </p>
      {hasEstimate ? (
        <div className="mb-3 rounded-lg bg-white/70 p-3 text-xs text-foreground/80">
          <p>
            اجرت {money.format(ticket.estimatedLaborRial)} · قطعات {money.format(ticket.estimatedPartsRial)}
            {ticket.estimatedDiscountRial > 0 ? <> · تخفیف {money.format(ticket.estimatedDiscountRial)}−</> : null}
            {" "}· مالیات {money.format(ticket.estimatedVatRial)} · مبلغ قابل پرداخت{" "}
            {money.format(ticket.estimatedTotalRial)}
          </p>
          <p className="mt-1">
            {approved ? (
              <span className="font-semibold text-emerald-700 dark:text-emerald-300">تأیید مشتری ثبت شده است.</span>
            ) : (
              <span className="font-semibold text-amber-700 dark:text-amber-300">هنوز تأیید نشده است.</span>
            )}
          </p>
        </div>
      ) : null}

      <form onSubmit={save} className="grid min-w-0 gap-3 sm:grid-cols-2">
        <Field label={`اجرت (${money.unitLabel})`}>
          <PersianNumberInput
            className={watchInputClass}
            dir="ltr"
            inputMode="numeric"
            value={labor}
            onChange={(e) => setLabor(e.target.value)}
          />
        </Field>
        <Field label={`قطعات (${money.unitLabel})`}>
          <PersianNumberInput
            className={watchInputClass}
            dir="ltr"
            inputMode="numeric"
            value={parts}
            onChange={(e) => setParts(e.target.value)}
          />
        </Field>
        <Field label={`تخفیف (${money.unitLabel})`}>
          <PersianNumberInput
            className={watchInputClass}
            dir="ltr"
            inputMode="numeric"
            value={discount}
            onChange={(e) => setDiscount(e.target.value)}
          />
        </Field>
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <Button type="submit" disabled={busy} size="sm" className="min-h-[44px] border border-amber-300 dark:border-amber-500/40 px-5 font-semibold">
            ثبت برآورد
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={secondaryActionClass}
            disabled={busy || !hasEstimate || approved}
            onClick={() =>
              run(() => api(`/api/watch/repairs/${ticket.id}/estimate`, { method: "POST" }))
            }
          >
            تأیید مشتری
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={secondaryActionClass}
            disabled={busy || !hasEstimate}
            onClick={() => {
              window.open(`/api/watch/repairs/${ticket.id}/estimate/print`, "_blank");
            }}
          >
            چاپ برآورد
          </Button>
        </div>
      </form>
    </PanelShell>
  );
}

function ClosePanel({
  ticket,
  busy,
  run,
  onDone,
}: {
  ticket: RepairTicket;
  busy: boolean;
  run: Runner;
  onDone: () => void;
}) {
  const money = useMoney();
  const [laborCharge, setLaborCharge] = useState(String(money.toInput(ticket.laborCharge)));
  const [vatPercent, setVatPercent] = useState(String(ticket.vatPercent));
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [nonCoveredReason, setNonCoveredReason] = useState(ticket.nonCoveredReason ?? "");

  async function close(e: React.FormEvent) {
    e.preventDefault();
    const saved = await run(() =>
      api(`/api/watch/repairs/${ticket.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          laborCharge: money.fromInput(Math.max(0, Math.round(Number(laborCharge || 0)))),
          vatPercent: Number(vatPercent || 0),
          // The server refuses any customer charge on a warranty job without
          // this explicit out-of-coverage reason (issue #795).
          ...(ticket.underWarranty ? { nonCoveredReason: nonCoveredReason.trim() || null } : {}),
        }),
      }),
    );
    if (!saved) return;
    const ok = await run(() =>
      api(`/api/watch/repairs/${ticket.id}/close`, {
        method: "POST",
        body: JSON.stringify({ paymentMethod }),
      }),
    );
    if (ok) onDone();
  }

  return (
    <PanelShell>
      {ticket.underWarranty ? (
        <p className="mb-3 text-xs leading-5 text-muted-foreground">
          این تیکت در گارانتی است: اجرت و قطعات تحت پوشش برای مشتری رایگان است. دریافت هر مبلغی فقط با ثبت
          «علت خارج از پوشش گارانتی» (کار خارج از پوشش که مشتری پذیرفته) مجاز است.
        </p>
      ) : null}
      <form onSubmit={close} className="grid min-w-0 gap-3 sm:grid-cols-3">
        <Field label={`اجرت تعمیر (${money.unitLabel})`}>
          <PersianNumberInput
            className={watchInputClass}
            dir="ltr"
            inputMode="numeric"
            value={laborCharge}
            onChange={(e) => setLaborCharge(e.target.value)}
          />
        </Field>
        <Field label="مالیات (٪)">
          <PersianNumberInput
            className={watchInputClass}
            dir="ltr"
            inputMode="decimal"
            value={vatPercent}
            onChange={(e) => setVatPercent(e.target.value)}
          />
        </Field>
        <Field label="روش پرداخت">
          <SearchableSelect
            className={watchInputClass}
            value={paymentMethod}
            onChange={setPaymentMethod}
            options={[
              { value: "cash", label: "نقدی" },
              { value: "bank", label: "کارت‌خوان" },
              { value: "credit", label: "نسیه" },
            ]}
          />
        </Field>
        {ticket.underWarranty ? (
          <div className="sm:col-span-3">
            <Field label="علت خارج از پوشش گارانتی" hint="فقط اگر مبلغی از مشتری دریافت می‌شود.">
              <input
                className={watchInputClass}
                value={nonCoveredReason}
                onChange={(e) => setNonCoveredReason(e.target.value)}
                placeholder="مثلاً آب‌خوردگی — خارج از پوشش، با تأیید مشتری"
              />
            </Field>
          </div>
        ) : null}
        <div className="sm:col-span-3">
          <Button type="submit" disabled={busy} size="sm" className="min-h-[44px] border border-amber-300 dark:border-amber-500/40 px-5 font-semibold">
            تسویه و بستن
          </Button>
        </div>
      </form>
    </PanelShell>
  );
}
