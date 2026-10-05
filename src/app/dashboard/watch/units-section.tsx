"use client";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { formatJalali } from "@/lib/jalali";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { api, Field, inputClass } from "../ui";
import { ItemAuditPanel } from "../item-audit-panel";
import { CustomerPicker, type PickerCustomer } from "../customer-picker";
import { JalaliDatePicker } from "../jalali-date-picker";
import {
  CONDITION_GRADE_LABELS,
  SERIAL_STATUS_LABELS,
  type Runner,
  type SerialUnit,
  type WatchModel,
} from "./watch-manager";
import { cardClass, SectionCardSkeleton } from "../page-chrome";

const watchInputClass = `${inputClass} min-h-[52px] !border-border !bg-card shadow-none placeholder:text-muted-foreground focus-visible:border-amber-500 dark:focus-visible:border-amber-500/60 focus-visible:ring-amber-400/30 dark:focus-visible:ring-amber-400/40`;
const secondaryActionClass =
  "min-h-[44px] border-border bg-card px-3 text-xs text-foreground/80 hover:border-amber-300 dark:hover:border-amber-500/40 hover:bg-amber-50 dark:hover:bg-amber-500/15 hover:text-foreground focus-visible:border-amber-500 dark:focus-visible:border-amber-500/60 focus-visible:ring-amber-400/30 dark:focus-visible:ring-amber-400/40";

const STATUS_BADGE_CLASS: Record<SerialUnit["status"], string> = {
  in_stock: "bg-emerald-100 dark:bg-emerald-500/20 text-emerald-900 dark:text-emerald-100",
  reserved: "bg-amber-100 dark:bg-amber-500/20 text-amber-900 dark:text-amber-200",
  in_repair: "bg-sky-100 dark:bg-sky-500/20 text-sky-900 dark:text-sky-100",
  sold: "bg-muted text-muted-foreground",
  supplier_returned: "bg-rose-100 dark:bg-rose-500/20 text-rose-900 dark:text-rose-100",
  written_off: "bg-rose-100 dark:bg-rose-500/20 text-rose-900 dark:text-rose-100",
};

export function UnitsSection({
  models,
  units,
  busy,
  run,
}: {
  models: WatchModel[];
  units: SerialUnit[];
  busy: boolean;
  run: Runner;
}) {
  const money = useMoney();
  const [modelName, setModelName] = useState("");
  const [modelSku, setModelSku] = useState("");
  const [serviceIntervalMonths, setServiceIntervalMonths] = useState("");
  const [itemId, setItemId] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [warrantyMonths, setWarrantyMonths] = useState("12");

  async function addModel(e: React.FormEvent) {
    e.preventDefault();
    if (!modelName.trim()) return;
    const ok = await run(() =>
      api("/api/watch/items", {
        method: "POST",
        body: JSON.stringify({
          name: modelName,
          sku: modelSku.trim() || null,
          serviceIntervalMonths: serviceIntervalMonths.trim() ? Number(serviceIntervalMonths) : null,
        }),
      }),
    );
    if (ok) {
      setModelName("");
      setModelSku("");
      setServiceIntervalMonths("");
    }
  }

  async function addUnit(e: React.FormEvent) {
    e.preventDefault();
    if (!itemId || !serialNumber.trim()) return;
    const ok = await run(() =>
      api("/api/watch/units", {
        method: "POST",
        body: JSON.stringify({
          itemId,
          serialNumber,
          unitCost: unitCost.trim() ? money.fromInput(Math.max(0, Math.round(Number(unitCost)))) : null,
          warrantyMonths: Number(warrantyMonths || 0),
        }),
      }),
    );
    if (ok) {
      setSerialNumber("");
      setUnitCost("");
    }
  }

  return (
    <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_18rem] lg:gap-5 lg:grid-cols-[minmax(0,1fr)_21rem] xl:grid-cols-[minmax(0,1fr)_24rem]">
      <section
        aria-labelledby="watch-units-heading"
        className={`order-2 min-w-0 overflow-hidden ${cardClass} md:order-1`}
      >
        <div className="border-b border-border/80 px-4 py-4 sm:px-5">
          <h2 id="watch-units-heading" className="font-semibold text-foreground">
            دستگاه‌های سریال‌دار
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            هر دستگاه با شماره سریال خودش ثبت می‌شود؛ گارانتی از لحظهٔ فروش شروع می‌شود.
          </p>
        </div>

        <ul className="divide-y divide-border/80">
          {units.map((unit) => (
            <UnitRow key={unit.id} unit={unit} busy={busy} run={run} />
          ))}
          {units.length === 0 ? (
            <li className="px-4 py-5 text-sm text-muted-foreground sm:px-5">دستگاهی ثبت نشده است.</li>
          ) : null}
        </ul>
      </section>

      <aside className="order-1 min-w-0 space-y-4 md:order-2">
        <div className={`${cardClass} p-4 sm:p-5`}>
          <h2 className="font-semibold text-foreground">افزودن مدل</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            مدل، خودِ کالاست؛ دستگاه‌های فیزیکی زیر همان مدل ثبت می‌شوند.
          </p>
          <form onSubmit={addModel} className="mt-4">
            <Field label="نام مدل">
              <input
                className={watchInputClass}
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                placeholder="مثلاً کاسیو ادیفایس"
                required
              />
            </Field>
            <Field label="کد کالا">
              <input
                className={watchInputClass}
                value={modelSku}
                onChange={(e) => setModelSku(e.target.value)}
                placeholder="اختیاری"
              />
            </Field>
            <Field label="فاصلهٔ سرویس (ماه)" hint="باطری کوارتز ~۲۴، موتور اتوماتیک ۳۶ تا ۶۰. خالی = بدون یادآوری.">
              <PersianNumberInput
                className={watchInputClass}
                dir="ltr"
                inputMode="numeric"
                value={serviceIntervalMonths}
                onChange={(e) => setServiceIntervalMonths(e.target.value)}
                placeholder="اختیاری"
              />
            </Field>
            <Button
              type="submit"
              disabled={busy}
              size="lg"
              className="min-h-[52px] w-full border border-amber-300 dark:border-amber-500/40 px-5 font-semibold focus-visible:ring-amber-400/30 dark:focus-visible:ring-amber-400/40"
            >
              افزودن مدل
            </Button>
          </form>
        </div>

        <div className={`${cardClass} p-4 sm:p-5`}>
          <h2 className="font-semibold text-foreground">ثبت دستگاه</h2>
          <form onSubmit={addUnit} className="mt-4">
            <Field label="مدل">
              <SearchableSelect
                className={watchInputClass}
                value={itemId}
                onChange={setItemId}
                options={models.map((m) => ({ value: m.id, label: m.name }))}
                placeholder="انتخاب مدل"
              />
            </Field>
            <Field label="شماره سریال">
              <input
                className={watchInputClass}
                dir="ltr"
                value={serialNumber}
                onChange={(e) => setSerialNumber(e.target.value)}
                required
              />
            </Field>
            <Field label={`بهای تمام‌شده (${money.unitLabel})`} hint="اگر هنوز مشخص نیست، خالی بگذارید.">
              <PersianNumberInput
                className={watchInputClass}
                dir="ltr"
                inputMode="numeric"
                value={unitCost}
                onChange={(e) => setUnitCost(e.target.value)}
                placeholder="اختیاری"
              />
            </Field>
            <Field label="گارانتی (ماه)" hint="۰ یعنی بدون گارانتی.">
              <PersianNumberInput
                className={watchInputClass}
                dir="ltr"
                inputMode="numeric"
                value={warrantyMonths}
                onChange={(e) => setWarrantyMonths(e.target.value)}
              />
            </Field>
            <Button
              type="submit"
              disabled={busy || models.length === 0}
              size="lg"
              className="min-h-[52px] w-full border border-amber-300 dark:border-amber-500/40 px-5 font-semibold focus-visible:ring-amber-400/30 dark:focus-visible:ring-amber-400/40"
            >
              ثبت دستگاه
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

const CONDITION_GRADE_OPTIONS = [
  { value: "new", label: "نو" },
  { value: "like_new", label: "در حد نو" },
  { value: "good", label: "خوب" },
  { value: "fair", label: "متوسط" },
  { value: "poor", label: "ضعیف" },
] as const;

/** Issue #795 item 18 — where a pre-owned piece came from. */
const PRE_OWNED_SOURCE_OPTIONS = [
  { value: "customer_tradein", label: "معاوضه/خرید از مشتری" },
  { value: "direct_purchase", label: "خرید مستقیم" },
  { value: "consignment", label: "امانی" },
  { value: "other", label: "سایر" },
] as const;

function UnitRow({ unit, busy, run }: { unit: SerialUnit; busy: boolean; run: Runner }) {
  const money = useMoney();
  const [panel, setPanel] = useState<"cost" | "audit" | "preowned" | "transfer" | null>(null);
  const toggle = (next: "cost" | "audit" | "preowned" | "transfer") =>
    setPanel((current) => (current === next ? null : next));

  return (
    <li className="flex min-w-0 flex-col gap-3 px-4 py-4 sm:px-5">
      <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <h3 className="min-w-0 break-words font-semibold text-foreground">{unit.itemName}</h3>
            <span className="text-xs text-muted-foreground" dir="ltr">
              {unit.serialNumber}
            </span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASS[unit.status]}`}>
              {SERIAL_STATUS_LABELS[unit.status]}
            </span>
            {unit.preOwned ? (
              <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-900 dark:bg-violet-500/20 dark:text-violet-100">
                دست‌دوم
                {unit.conditionGrade ? ` · ${CONDITION_GRADE_LABELS[unit.conditionGrade] ?? unit.conditionGrade}` : ""}
                {unit.boxAndPapers ? " · جعبه و برگه" : ""}
              </span>
            ) : null}
          </div>

          <dl className="mt-3 grid min-w-0 gap-x-5 gap-y-2 text-xs text-muted-foreground sm:grid-cols-2 xl:grid-cols-4">
            <MetaItem label="بهای تمام‌شده">
              {unit.unitCost ? money.format(unit.unitCost) : "تعیین نشده"}
            </MetaItem>
            <MetaItem label="گارانتی">{toPersianDigits(String(unit.warrantyMonths))} ماه</MetaItem>
            {unit.soldAt ? (
              <MetaItem label="تاریخ فروش">{formatJalali(unit.soldAt, { withMonthName: true })}</MetaItem>
            ) : null}
            {unit.warrantyEnd ? (
              <MetaItem label="پایان گارانتی">
                {formatJalali(unit.warrantyEnd, { withMonthName: true })}
              </MetaItem>
            ) : null}
          </dl>
        </div>

        <div className="grid shrink-0 grid-cols-2 gap-2 sm:flex sm:flex-wrap lg:justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={secondaryActionClass}
            disabled={busy || unit.status === "sold"}
            onClick={() => toggle("cost")}
          >
            ویرایش بها
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={secondaryActionClass}
            disabled={busy}
            onClick={() => toggle("audit")}
          >
            تاریخچه
          </Button>
          {unit.status === "in_stock" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={secondaryActionClass}
              disabled={busy}
              onClick={() => toggle("preowned")}
            >
              ثبت دست‌دوم
            </Button>
          ) : null}
          {unit.status === "in_stock" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={secondaryActionClass}
              disabled={busy}
              onClick={() => toggle("transfer")}
            >
              انتقال شعبه
            </Button>
          ) : null}
          {unit.status === "in_stock" ? (
            // Selling happens on the invoice screen, the only place a sale
            // becomes a document (Phase 25 Wave 3). This page manages the
            // catalogue; it no longer offers a parallel way to sell one unit
            // straight to the ledger.
            <Link
              href="/accounting/pos"
              className="inline-flex min-h-[44px] items-center rounded-xl border border-amber-300 dark:border-amber-500/40 bg-amber-100 dark:bg-amber-500/20 px-3 text-xs font-semibold text-amber-950 dark:text-amber-200 transition-colors hover:bg-amber-200 dark:hover:bg-amber-500/25"
            >
              فروش در فاکتور
            </Link>
          ) : null}
        </div>
      </div>

      {panel === "cost" ? (
        <CostPanel unit={unit} busy={busy} run={run} onDone={() => setPanel(null)} />
      ) : null}
      {panel === "audit" ? <ItemAuditPanel itemId={unit.itemId} /> : null}
      {panel === "preowned" ? (
        <PreOwnedPanel unit={unit} busy={busy} run={run} onDone={() => setPanel(null)} />
      ) : null}
      {panel === "transfer" ? (
        <TransferPanel unit={unit} busy={busy} run={run} onDone={() => setPanel(null)} />
      ) : null}
    </li>
  );
}

function PanelShell({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl bg-amber-50/60 dark:bg-amber-500/15 p-3 sm:p-4">{children}</div>;
}

function PreOwnedPanel({
  unit,
  busy,
  run,
  onDone,
}: {
  unit: SerialUnit;
  busy: boolean;
  run: Runner;
  onDone: () => void;
}) {
  const money = useMoney();
  const [conditionGrade, setConditionGrade] = useState("good");
  const [boxAndPapers, setBoxAndPapers] = useState(false);
  const [source, setSource] = useState("customer_tradein");
  const [party, setParty] = useState<PickerCustomer | null>(null);
  const [documentNo, setDocumentNo] = useState("");
  const [purchaseValue, setPurchaseValue] = useState("");
  const [intakeDate, setIntakeDate] = useState("");
  const [authenticityVerified, setAuthenticityVerified] = useState(false);
  const [authenticityNotes, setAuthenticityNotes] = useState("");
  const [serviceHistory, setServiceHistory] = useState("");
  const [productionYear, setProductionYear] = useState("");
  const [accessories, setAccessories] = useState("");
  const [notes, setNotes] = useState("");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const ok = await run(() =>
      api(`/api/watch/units/${unit.id}/pre-owned`, {
        method: "POST",
        body: JSON.stringify({
          conditionGrade,
          boxAndPapers,
          source,
          partyId: party?.id ?? null,
          documentNo: documentNo || null,
          purchaseValueRial: purchaseValue
            ? money.fromInput(Math.max(0, Math.round(Number(purchaseValue))))
            : 0,
          intakeDate: intakeDate || null,
          authenticityVerified,
          authenticityNotes: authenticityNotes || null,
          serviceHistory: serviceHistory || null,
          productionYear: productionYear ? Number(productionYear) : null,
          accessories: accessories || null,
          notes: notes || null,
        }),
      }),
    );
    if (ok) onDone();
  }

  return (
    <PanelShell>
      <p className="mb-3 text-xs leading-5 text-muted-foreground">
        سند کامل دریافت دست‌دوم: منبع، طرف معامله، سند، ارزش خرید، اصالت، سابقه سرویس و متعلقات ثبت
        می‌شود. ارزش خرید جنبهٔ سندی دارد — ثبت حسابداری خرید همان لحظهٔ ورود دستگاه به انبار انجام شده است.
      </p>
      <form onSubmit={save} className="grid min-w-0 gap-3 sm:grid-cols-2">
        <Field label="درجه وضعیت">
          <SearchableSelect
            className={watchInputClass}
            value={conditionGrade}
            onChange={setConditionGrade}
            options={CONDITION_GRADE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          />
        </Field>
        <Field label="منبع دریافت">
          <SearchableSelect
            className={watchInputClass}
            value={source}
            onChange={setSource}
            options={PRE_OWNED_SOURCE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          />
        </Field>
        <Field label="طرف معامله (اختیاری)">
          <CustomerPicker
            customer={party}
            onChange={setParty}
            disabled={busy}
            idPrefix={`watch-preowned-party-${unit.id}`}
          />
        </Field>
        <Field label="شماره سند (اختیاری)">
          <input className={watchInputClass} value={documentNo} onChange={(e) => setDocumentNo(e.target.value)} />
        </Field>
        <Field label={`ارزش خرید (${money.unitLabel}، اختیاری)`}>
          <PersianNumberInput
            className={watchInputClass}
            dir="ltr"
            inputMode="numeric"
            value={purchaseValue}
            onChange={(e) => setPurchaseValue(e.target.value)}
          />
        </Field>
        <Field label="تاریخ دریافت (اختیاری؛ پیش‌فرض امروز)">
          <JalaliDatePicker value={intakeDate} onChange={setIntakeDate} />
        </Field>
        <Field label="سال ساخت (اختیاری)">
          <PersianNumberInput
            className={watchInputClass}
            dir="ltr"
            inputMode="numeric"
            value={productionYear}
            onChange={(e) => setProductionYear(e.target.value)}
          />
        </Field>
        <Field label="متعلقات (اختیاری)">
          <input className={watchInputClass} value={accessories} onChange={(e) => setAccessories(e.target.value)} />
        </Field>
        <Field label="سابقه سرویس (اختیاری)">
          <input
            className={watchInputClass}
            value={serviceHistory}
            onChange={(e) => setServiceHistory(e.target.value)}
          />
        </Field>
        <Field label="یادداشت (اختیاری)">
          <input className={watchInputClass} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div className="flex items-end gap-4 pb-1 sm:col-span-2">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground/80">
            <input
              type="checkbox"
              className="size-4 rounded border-border text-amber-500 dark:text-amber-400 focus:ring-amber-400/30 dark:focus:ring-amber-400/40"
              checked={boxAndPapers}
              onChange={(e) => setBoxAndPapers(e.target.checked)}
            />
            همراه جعبه و مدارک
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground/80">
            <input
              type="checkbox"
              className="size-4 rounded border-border text-amber-500 dark:text-amber-400 focus:ring-amber-400/30 dark:focus:ring-amber-400/40"
              checked={authenticityVerified}
              onChange={(e) => setAuthenticityVerified(e.target.checked)}
            />
            اصالت بررسی و تأیید شد
          </label>
        </div>
        {authenticityVerified ? (
          <Field label="توضیح بررسی اصالت (اختیاری)">
            <input
              className={watchInputClass}
              value={authenticityNotes}
              onChange={(e) => setAuthenticityNotes(e.target.value)}
            />
          </Field>
        ) : null}
        <div className="sm:col-span-2">
          <Button type="submit" disabled={busy} size="sm" className="min-h-[44px] border border-amber-300 dark:border-amber-500/40 px-5 font-semibold">
            ثبت دست‌دوم
          </Button>
        </div>
      </form>
    </PanelShell>
  );
}

function CostPanel({
  unit,
  busy,
  run,
  onDone,
}: {
  unit: SerialUnit;
  busy: boolean;
  run: Runner;
  onDone: () => void;
}) {
  const money = useMoney();
  const [unitCost, setUnitCost] = useState(unit.unitCost ? String(money.toInput(unit.unitCost)) : "");
  const [warrantyMonths, setWarrantyMonths] = useState(String(unit.warrantyMonths));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const ok = await run(() =>
      api(`/api/watch/units/${unit.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          unitCost: unitCost.trim() ? money.fromInput(Math.max(0, Math.round(Number(unitCost)))) : null,
          warrantyMonths: Number(warrantyMonths || 0),
        }),
      }),
    );
    if (ok) onDone();
  }

  return (
    <PanelShell>
      <form onSubmit={save} className="grid min-w-0 gap-3 sm:grid-cols-3">
        <Field label={`بهای تمام‌شده (${money.unitLabel})`}>
          <PersianNumberInput
            className={watchInputClass}
            dir="ltr"
            inputMode="numeric"
            value={unitCost}
            onChange={(e) => setUnitCost(e.target.value)}
          />
        </Field>
        <Field label="گارانتی (ماه)">
          <PersianNumberInput
            className={watchInputClass}
            dir="ltr"
            inputMode="numeric"
            value={warrantyMonths}
            onChange={(e) => setWarrantyMonths(e.target.value)}
          />
        </Field>
        <div className="sm:col-span-3">
          <Button type="submit" disabled={busy} size="sm" className="min-h-[44px] border border-amber-300 dark:border-amber-500/40 px-5 font-semibold">
            ذخیره
          </Button>
        </div>
      </form>
    </PanelShell>
  );
}

/**
 * Issue #795 — moving one unit to another branch. The destination must
 * already carry the same model in its catalogue; the move is
 * accounting-neutral (business-scoped inventory account) and leaves a
 * domain-event audit trail.
 */
function TransferPanel({
  unit,
  busy,
  run,
  onDone,
}: {
  unit: SerialUnit;
  busy: boolean;
  run: Runner;
  onDone: () => void;
}) {
  const [destinations, setDestinations] = useState<{ id: string; name: string }[] | null>(null);
  const [toLocationId, setToLocationId] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    api<{ destinations: { id: string; name: string }[] }>(
      `/api/watch/units/${unit.id}/transfer`,
    ).then(({ ok, data }) => {
      if (ok) setDestinations(data.destinations);
    });
  }, [unit.id]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!toLocationId) return;
    const ok = await run(() =>
      api(`/api/watch/units/${unit.id}/transfer`, {
        method: "POST",
        body: JSON.stringify({ toLocationId, note: note || null }),
      }),
    );
    if (ok) onDone();
  }

  if (destinations === null) {
    return (
      <PanelShell>
        <SectionCardSkeleton rows={2} />
      </PanelShell>
    );
  }
  if (destinations.length === 0) {
    return (
      <PanelShell>
        <p className="text-xs leading-5 text-muted-foreground">شعبهٔ دیگری برای انتقال وجود ندارد.</p>
      </PanelShell>
    );
  }

  return (
    <PanelShell>
      <p className="mb-3 text-xs leading-5 text-muted-foreground">
        دستگاه به کاتالوگ همان مدل در شعبهٔ مقصد منتقل می‌شود؛ اگر مدل در مقصد تعریف نشده باشد، انتقال
        انجام نمی‌شود.
      </p>
      <form onSubmit={save} className="grid min-w-0 gap-3 sm:grid-cols-2">
        <Field label="شعبهٔ مقصد">
          <SearchableSelect
            className={watchInputClass}
            value={toLocationId}
            onChange={setToLocationId}
            options={[
              { value: "", label: "انتخاب کنید…" },
              ...destinations.map((d) => ({ value: d.id, label: d.name })),
            ]}
          />
        </Field>
        <Field label="یادداشت (اختیاری)">
          <input className={watchInputClass} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div className="sm:col-span-2">
          <Button
            type="submit"
            disabled={busy || !toLocationId}
            size="sm"
            className="min-h-[44px] border border-amber-300 dark:border-amber-500/40 px-5 font-semibold"
          >
            انتقال
          </Button>
        </div>
      </form>
    </PanelShell>
  );
}
