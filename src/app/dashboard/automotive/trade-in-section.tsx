"use client";

/**
 * Issue #963 (#839 §9) — the two-sided deal on screen: sell one exact car
 * and take the customer's car in against it, as ONE submission to
 * `POST /api/automotive/trade-ins`.
 *
 * The screen's own rules mirror the service's, so the counter hears them
 * before the server has to say no:
 *
 *   * the preview arithmetic is `computeTradeInConsideration` from
 *     `@/lib/automotive` — the same function the service freezes the deal
 *     with. The allowance is shown as consideration applied against the
 *     invoice (never as a discount line), the reservation deposit as
 *     applied-not-refunded, and whatever remains as «مابه‌التفاوت»;
 *   * the allowance and B's expected retail price are two fields, labelled
 *     as two decisions: one becomes B's purchase cost, the other its
 *     asking price;
 *   * exactly one car can be handed in — there is one handed-in block, by
 *     construction;
 *   * on a paired site (`read_only_mirror`) the form is not offered at
 *     all: a cloud-only note replaces it and nothing is queued. The
 *     server refuses there too (`trade_in_cloud_only`); this is the
 *     honest face of that refusal, not the gate.
 *   * every recorded deal for the selected car is listed with its numbers
 *     (allowance only under `vehicles.cost_view`, which the API enforces)
 *     and the whole deal reverses from here, with a reason — the server
 *     refuses legibly when the handed-in car has been sold or
 *     reconditioned since.
 *
 * The submission carries a stable `clientRequestId` per deal attempt:
 * resubmitting the same form after a lost response replays the recorded
 * deal instead of acquiring the customer's car twice.
 */
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, Field, PrimaryButton, SecondaryButton, inputClass } from "../ui";
import type { Runner } from "../industry-manager-shell";
import { EmptyState, SectionCard, SectionCardSkeleton, StatusBadge } from "../page-chrome";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "../data-table";
import { CustomerPicker, type PickerCustomer } from "../customer-picker";
import { useMoney } from "@/components/money/money-context";
import { formatJalali } from "@/lib/jalali";
import {
  TRADE_IN_DIFFERENCE_SETTLEMENT_LABELS,
  TRADE_IN_STATUS_LABELS,
  VEHICLE_STATE_LABELS,
  computeTradeInConsideration,
  type TradeInDifferenceSettlement,
} from "@/lib/automotive";
import type { VehicleListItemDto } from "./automotive-manager";

interface TradeInDealDto {
  id: string;
  saleId: string;
  orderId: string | null;
  soldSerialId: string;
  acquiredSerialId: string;
  customerId: string;
  allowanceRial?: number;
  expectedRetailRial: number;
  saleTotalRial: number;
  depositAppliedRial: number;
  tradeInAppliedRial?: number;
  remainderPayableRial?: number;
  differenceDueRial: number;
  differenceSettlement: TradeInDifferenceSettlement | "none";
  status: "active" | "reversed";
  reversalReason: string | null;
  createdAt: string;
}

interface TradeInResponseDto {
  ok?: boolean;
  tradeIn?: TradeInDealDto;
  orderNumber?: number | null;
  acquiredStockNumber?: string | null;
  replayed?: boolean;
  error?: string;
  message?: string;
}

function useTradeInMoney() {
  const moneyApi = useMoney();
  return useMemo(
    () => ({
      unitLabel: moneyApi.unitLabel,
      money: (value: number | undefined | null): string =>
        value == null ? "—" : moneyApi.format(value, { withUnit: false }),
      toRial: (input: string): number => {
        const value = Math.trunc(Number(input.trim() || 0));
        return Number.isFinite(value) && value > 0 ? moneyApi.fromInput(value) : 0;
      },
      toInput: (rial: number | null | undefined): string => (rial ? String(moneyApi.toInput(rial)) : ""),
    }),
    [moneyApi],
  );
}

export function TradeInSection({
  vehicles,
  vehiclesLoading,
  canTradeIn,
  canSeeCost,
  canOverrideMinPrice,
  canCreateCustomer,
  defaultVatPercent,
  run,
}: {
  vehicles: VehicleListItemDto[];
  vehiclesLoading: boolean;
  canTradeIn: boolean;
  canSeeCost: boolean;
  canOverrideMinPrice: boolean;
  canCreateCustomer: boolean;
  defaultVatPercent: number;
  run: Runner;
}) {
  const { money, unitLabel, toRial, toInput } = useTradeInMoney();
  const [cloudOnly, setCloudOnly] = useState(false);
  const [serialId, setSerialId] = useState("");
  const [customer, setCustomer] = useState<PickerCustomer | null>(null);
  const [price, setPrice] = useState("");
  const [discount, setDiscount] = useState("");
  const [settlement, setSettlement] = useState<TradeInDifferenceSettlement>("cash");
  const [override, setOverride] = useState(false);
  const [allowance, setAllowance] = useState("");
  const [expectedRetail, setExpectedRetail] = useState("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [trim, setTrim] = useState("");
  const [modelYear, setModelYear] = useState("");
  const [mileageKm, setMileageKm] = useState("");
  const [vin, setVin] = useState("");
  const [chassisNumber, setChassisNumber] = useState("");
  const [plateNumber, setPlateNumber] = useState("");
  const [exteriorColor, setExteriorColor] = useState("");
  const [inspectionNotes, setInspectionNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<{ orderNumber: number | null; stockNumber: string | null } | null>(null);
  const [deals, setDeals] = useState<TradeInDealDto[]>([]);
  const [dealsLoading, setDealsLoading] = useState(false);
  const [reversalReason, setReversalReason] = useState<Record<string, string>>({});
  const requestIdRef = useRef<string>(crypto.randomUUID());

  // A paired site reads a mirror and queues only holds: a trade-in is
  // shown as cloud-only there and is never turned into a request.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await api<{ capability?: { mode?: string } }>("/api/automotive/offline");
      if (!cancelled && result.ok && result.data.capability?.mode === "read_only_mirror") {
        setCloudOnly(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const sellable = vehicles.filter((vehicle) => vehicle.state === "in_stock" || vehicle.state === "reserved");
  const selected = vehicles.find((vehicle) => vehicle.serialId === serialId);

  useEffect(() => {
    let cancelled = false;
    if (!serialId) {
      setDeals([]);
      setDealsLoading(false);
      return;
    }
    setDealsLoading(true);
    void (async () => {
      const result = await api<{ tradeIns?: TradeInDealDto[] }>(
        `/api/automotive/trade-ins?serialId=${encodeURIComponent(serialId)}`,
      );
      if (!cancelled && result.ok) setDeals(result.data.tradeIns ?? []);
      if (!cancelled) setDealsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [serialId]);

  const priceRial = toRial(price);
  const discountRial = toRial(discount);
  const allowanceRial = toRial(allowance);
  const expectedRetailRial = toRial(expectedRetail);
  const net = Math.max(0, priceRial - discountRial);
  const vat = Math.round((net * defaultVatPercent) / 100);
  const total = net + vat;
  const depositPreview =
    selected && customer && selected.reservedForCustomerId === customer.id ? selected.reservedDepositRial : 0;
  const preview = useMemo(() => {
    if (allowanceRial <= 0 || total <= 0) return null;
    try {
      return computeTradeInConsideration({
        saleTotalRial: total,
        depositAppliedRial: depositPreview,
        allowanceRial,
        expectedRetailRial,
      });
    } catch {
      return null;
    }
  }, [allowanceRial, total, depositPreview, expectedRetailRial]);

  const belowFloor = selected?.minimumPriceRial != null && net > 0 && net < selected.minimumPriceRial;
  const canSubmit =
    canTradeIn &&
    !cloudOnly &&
    !busy &&
    !!selected &&
    sellable.some((vehicle) => vehicle.serialId === serialId) &&
    !!customer &&
    priceRial > 0 &&
    discountRial <= priceRial &&
    allowanceRial > 0 &&
    make.trim() !== "" &&
    model.trim() !== "";

  async function submit() {
    if (!canSubmit || !selected || !customer) return;
    setBusy(true);
    setReceipt(null);
    const ok = await run(async () => {
      const result = await api<TradeInResponseDto>("/api/automotive/trade-ins", {
        method: "POST",
        body: JSON.stringify({
          soldSerialId: selected.serialId,
          customerId: customer.id,
          salePriceRial: priceRial,
          discountRial,
          overrideMinPrice: override,
          differenceSettlement: settlement,
          allowanceRial,
          expectedRetailRial,
          clientRequestId: requestIdRef.current,
          tradeIn: {
            make: make.trim(),
            model: model.trim(),
            trim: trim.trim() || null,
            modelYear: modelYear.trim() ? Number(modelYear) : null,
            mileageKm: mileageKm.trim() ? Number(mileageKm) : null,
            vin: vin.trim() || null,
            chassisNumber: chassisNumber.trim() || null,
            plateNumber: plateNumber.trim() || null,
            exteriorColor: exteriorColor.trim() || null,
            inspectionNotes: inspectionNotes.trim() || null,
          },
        }),
      });
      if (result.ok) {
        setReceipt({
          orderNumber: result.data.orderNumber ?? null,
          stockNumber: result.data.acquiredStockNumber ?? null,
        });
        // The next deal is a new intent, with a new submission key.
        requestIdRef.current = crypto.randomUUID();
        setSerialId("");
        setAllowance("");
        setExpectedRetail("");
        setMake("");
        setModel("");
        setTrim("");
        setModelYear("");
        setMileageKm("");
        setVin("");
        setChassisNumber("");
        setPlateNumber("");
        setExteriorColor("");
        setInspectionNotes("");
      }
      return result;
    });
    void ok;
    setBusy(false);
  }

  async function reverse(deal: TradeInDealDto) {
    const reason = (reversalReason[deal.id] ?? "").trim();
    if (!reason) return;
    setBusy(true);
    await run(async () =>
      api<{ error?: string; message?: string }>(`/api/automotive/trade-ins/${deal.id}/reverse`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      }),
    );
    setReversalReason((map) => ({ ...map, [deal.id]: "" }));
    setBusy(false);
  }

  if (!canTradeIn) {
    return (
      <SectionCard title="معاوضه خودرو" description="فروش یک خودرو با تحویل گرفتن خودروی مشتری در همان معامله">
        <EmptyState title="دسترسی معاوضه ندارید">
          ثبت و برگشت معاوضه به مجوز «معاوضه خودرو» نیاز دارد؛ معاملات ثبت‌شده از گزارش فروش قابل مشاهده‌اند.
        </EmptyState>
      </SectionCard>
    );
  }

  return (
    <div className="space-y-4">
      <SectionCard
        title="معاوضه خودرو"
        description="فروش خودروی موجود و تحویل گرفتن خودروی مشتری در یک معامله؛ هر دو طرف با هم ثبت می‌شوند یا هیچ‌کدام"
      >
        {cloudOnly ? (
          <p className="text-sm text-amber-700 dark:text-amber-300" role="status">
            این نصب شعبهٔ همگام‌شده است: معاوضه فقط روی سرور مرکزی ثبت می‌شود و به‌صورت آفلاین در صف درخواست قرار
            نمی‌گیرد.
          </p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="خودروی فروخته‌شده">
                <select
                  className={inputClass}
                  value={serialId}
                  disabled={vehiclesLoading}
                  onChange={(event) => {
                    setSerialId(event.target.value);
                    requestIdRef.current = crypto.randomUUID();
                    const next = sellable.find((vehicle) => vehicle.serialId === event.target.value);
                    if (next) {
                      setPrice(toInput(next.askingPriceRial));
                      if (next.reservedForCustomerId && next.reservedForName) {
                        setCustomer({ id: next.reservedForCustomerId, name: next.reservedForName } as PickerCustomer);
                      }
                    }
                  }}
                >
                  <option value="">{vehiclesLoading ? "در حال دریافت خودروها…" : "— انتخاب خودرو —"}</option>
                  {sellable.map((vehicle) => (
                    <option key={vehicle.serialId} value={vehicle.serialId}>
                      {vehicle.stockNumber} — {vehicle.displayName}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="مشتری (خریدار و تحویل‌دهنده)">
                <CustomerPicker customer={customer} onChange={setCustomer} idPrefix="automotive-trade-in" canCreate={canCreateCustomer} />
              </Field>
              <Field label={`قیمت خودروی فروخته‌شده (${unitLabel})`}>
                <PersianNumberInput className={inputClass} inputMode="numeric" value={price} onChange={(event) => setPrice(event.target.value)} />
              </Field>
              <Field label={`تخفیف (${unitLabel})`}>
                <PersianNumberInput className={inputClass} inputMode="numeric" value={discount} onChange={(event) => setDiscount(event.target.value)} />
              </Field>
              <Field label="تسویهٔ مابه‌التفاوت">
                <select className={inputClass} value={settlement} onChange={(event) => setSettlement(event.target.value as TradeInDifferenceSettlement)}>
                  {(Object.keys(TRADE_IN_DIFFERENCE_SETTLEMENT_LABELS) as TradeInDifferenceSettlement[]).map((value) => (
                    <option key={value} value={value}>
                      {TRADE_IN_DIFFERENCE_SETTLEMENT_LABELS[value]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <fieldset className="mt-4 rounded-md border p-3">
              <legend className="px-1 text-sm font-medium">خودروی تحویلی مشتری (کارکرده)</legend>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="برند">
                  <input className={inputClass} value={make} onChange={(event) => setMake(event.target.value)} />
                </Field>
                <Field label="مدل">
                  <input className={inputClass} value={model} onChange={(event) => setModel(event.target.value)} />
                </Field>
                <Field label="تیپ">
                  <input className={inputClass} value={trim} onChange={(event) => setTrim(event.target.value)} />
                </Field>
                <Field label="سال مدل">
                  <PersianNumberInput className={inputClass} inputMode="numeric" value={modelYear} onChange={(event) => setModelYear(event.target.value)} />
                </Field>
                <Field label="کارکرد (کیلومتر)">
                  <PersianNumberInput className={inputClass} inputMode="numeric" value={mileageKm} onChange={(event) => setMileageKm(event.target.value)} />
                </Field>
                <Field label="رنگ">
                  <input className={inputClass} value={exteriorColor} onChange={(event) => setExteriorColor(event.target.value)} />
                </Field>
                <Field label="شماره VIN">
                  <input className={inputClass} dir="ltr" value={vin} onChange={(event) => setVin(event.target.value)} />
                </Field>
                <Field label="شماره شاسی">
                  <input className={inputClass} dir="ltr" value={chassisNumber} onChange={(event) => setChassisNumber(event.target.value)} />
                </Field>
                <Field label="پلاک">
                  <input className={inputClass} value={plateNumber} onChange={(event) => setPlateNumber(event.target.value)} />
                </Field>
                <Field label={`ارزش توافق‌شدهٔ معاوضه (${unitLabel}) — بهای خرید این خودرو می‌شود`}>
                  <PersianNumberInput className={inputClass} inputMode="numeric" value={allowance} onChange={(event) => setAllowance(event.target.value)} />
                </Field>
                <Field label={`قیمت فروش مورد انتظار (${unitLabel}) — قیمت آگهی آینده، جدا از ارزش معاوضه`}>
                  <PersianNumberInput className={inputClass} inputMode="numeric" value={expectedRetail} onChange={(event) => setExpectedRetail(event.target.value)} />
                </Field>
                <Field label="یادداشت کارشناسی">
                  <input className={inputClass} value={inspectionNotes} onChange={(event) => setInspectionNotes(event.target.value)} />
                </Field>
              </div>
            </fieldset>

            <div className="mt-3 space-y-1 text-sm text-muted-foreground" aria-live="polite">
              <p>
                جمع فاکتور: <span className="font-medium text-foreground">{money(total)}</span> {unitLabel} (خالص{" "}
                {money(net)} + مالیات {money(vat)}) — ارزش معاوضه تخفیف نیست و از قیمت کم نمی‌شود، بخشی از تسویه است.
              </p>
              {preview ? (
                <>
                  {preview.depositAppliedRial > 0 ? (
                    <p>بیعانهٔ رزرو اعمال می‌شود: {money(preview.depositAppliedRial)} {unitLabel}</p>
                  ) : null}
                  <p>
                    از ارزش معاوضه اعمال می‌شود: {money(preview.tradeInAppliedRial)} {unitLabel}
                    {preview.remainderPayableRial > 0
                      ? ` — ماندهٔ ${money(preview.remainderPayableRial)} ${unitLabel} به‌عنوان بدهی نمایشگاه به مشتری می‌ماند`
                      : ""}
                  </p>
                  <p>
                    مابه‌التفاوت قابل تسویه:{" "}
                    <span className="font-medium text-foreground">{money(preview.differenceDueRial)}</span> {unitLabel}
                    {preview.differenceDueRial > 0
                      ? ` (${TRADE_IN_DIFFERENCE_SETTLEMENT_LABELS[settlement]})`
                      : " — چیزی برای دریافت نمی‌ماند"}
                  </p>
                  {canSeeCost && expectedRetailRial > 0 ? (
                    <p>
                      حاشیهٔ مورد انتظار خودروی تحویلی (قیمت آگهی منهای ارزش معاوضه):{" "}
                      {money(expectedRetailRial - allowanceRial)} {unitLabel}
                    </p>
                  ) : null}
                </>
              ) : null}
              {selected?.reservedForName ? (
                <p className="text-amber-700 dark:text-amber-300">
                  این خودرو برای «{selected.reservedForName}» رزرو شده است؛ معامله باید به نام همان مشتری باشد و
                  بیعانه‌اش به همین معامله اعمال می‌شود.
                </p>
              ) : null}
              {belowFloor ? (
                <p className="text-rose-700 dark:text-rose-300">
                  مبلغ پس از تخفیف از حداقل قیمت تعیین‌شده ({money(selected?.minimumPriceRial)} {unitLabel}) کمتر است.
                </p>
              ) : null}
            </div>

            {canOverrideMinPrice ? (
              <label className="mt-3 flex items-center gap-2 text-sm text-foreground">
                <input type="checkbox" checked={override} onChange={(event) => setOverride(event.target.checked)} />
                مجوز من برای فروش زیر حداقل قیمت استفاده شود
              </label>
            ) : null}

            <div className="mt-4">
              <PrimaryButton onClick={submit} disabled={!canSubmit}>
                {busy ? "در حال ثبت معامله…" : "ثبت معاوضه (فروش + تحویل خودرو)"}
              </PrimaryButton>
            </div>

            {receipt ? (
              <p className="mt-3 text-sm text-emerald-700 dark:text-emerald-300">
                معاوضه ثبت شد؛ فاکتور {receipt.orderNumber ?? "—"} صادر و خودروی مشتری با شمارهٔ انبار{" "}
                {receipt.stockNumber ?? "—"} وارد موجودی این شعبه شد.
              </p>
            ) : null}
          </>
        )}
      </SectionCard>

      <SectionCard title="معاوضه‌های این خودرو" description="پیوند فروش و خودروی تحویلی، با امکان برگشت کل معامله">
        {dealsLoading ? (
          <SectionCardSkeleton />
        ) : !selected ? (
          <EmptyState title="خودرویی انتخاب نشده">برای دیدن معاوضه‌های یک خودرو، آن را از فهرست بالا انتخاب کنید.</EmptyState>
        ) : deals.length === 0 ? (
          <EmptyState title="معاوضه‌ای ثبت نشده">
            «{selected.displayName}» ({selected.stockNumber}، {VEHICLE_STATE_LABELS[selected.state]}) در هیچ معاملهٔ
            معاوضه‌ای نیست.
          </EmptyState>
        ) : (
          <DataTable caption="معاوضه‌های خودرو">
            <DataTableHead>
              <Th>تاریخ</Th>
              <Th>جمع فاکتور ({unitLabel})</Th>
              {canSeeCost ? <Th>ارزش معاوضه ({unitLabel})</Th> : null}
              <Th>مابه‌التفاوت ({unitLabel})</Th>
              <Th>وضعیت</Th>
              <Th>برگشت معامله</Th>
            </DataTableHead>
            <DataTableBody>
              {deals.map((deal) => (
                <DataTableRow key={deal.id}>
                  <Td>{formatJalali(deal.createdAt.slice(0, 10))}</Td>
                  <Td>{money(deal.saleTotalRial)}</Td>
                  {canSeeCost ? <Td>{money(deal.allowanceRial)}</Td> : null}
                  <Td>
                    {money(deal.differenceDueRial)}
                    {deal.differenceSettlement !== "none"
                      ? ` — ${TRADE_IN_DIFFERENCE_SETTLEMENT_LABELS[deal.differenceSettlement]}`
                      : ""}
                  </Td>
                  <Td>
                    <StatusBadge tone={deal.status === "active" ? "positive" : "neutral"}>
                      {TRADE_IN_STATUS_LABELS[deal.status]}
                    </StatusBadge>
                    {deal.reversalReason ? (
                      <span className="ms-2 text-xs text-muted-foreground">{deal.reversalReason}</span>
                    ) : null}
                  </Td>
                  <Td>
                    {deal.status === "active" ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          className={`${inputClass} sm:max-w-xs`}
                          aria-label="دلیل برگشت معاوضه"
                          placeholder="دلیل برگشت کل معامله"
                          value={reversalReason[deal.id] ?? ""}
                          onChange={(event) => setReversalReason((map) => ({ ...map, [deal.id]: event.target.value }))}
                        />
                        <SecondaryButton onClick={() => reverse(deal)} disabled={busy || !(reversalReason[deal.id] ?? "").trim()}>
                          برگشت معاوضه
                        </SecondaryButton>
                      </div>
                    ) : (
                      "—"
                    )}
                  </Td>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
      </SectionCard>
    </div>
  );
}
