"use client";

/**
 * Issue #839 §19 / Wave 6 — «موجودی همگام‌شده»: what a paired dealership
 * desktop may actually do with a car when the cloud is across a wire it does
 * not control.
 *
 * The panel exists to keep three things visibly apart, because blurring them is
 * how a real dealership loses a car or a customer's money:
 *
 *   1. **what the cloud says** — the read-only mirror, with its age shown. A
 *      board that has not synced in two minutes says «قدیمی» rather than
 *      pretending. Nothing on this screen writes to the mirror.
 *   2. **what this counter asked** — the queued requests, each labelled
 *      «در انتظار تأیید سرور». A pending request is never drawn as a hold, and
 *      its deposit is not a liability: the cloud creates the reservation and
 *      posts the deposit inside one transaction, or it refuses with a reason.
 *   3. **what the cloud decided** — confirmed holds and refusals, the latter
 *      with the action an operator can take (retry, cancel, look at the car).
 *
 * A sale cannot be started here at all: `offlineSaleFinalization` is `false` in
 * the type system, and the panel says so in words instead of offering a button
 * that would have to be taken back.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Field, PrimaryButton, SecondaryButton, api, errorMessage, inputClass } from "../ui";
import { EmptyState, SectionCard, SectionCardSkeleton, StatusBadge } from "../page-chrome";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "../data-table";
import { CustomerPicker, type PickerCustomer } from "../customer-picker";
import { JalaliDatePicker } from "../jalali-date-picker";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useMoney } from "@/components/money/money-context";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import {
  AUTOMOTIVE_CONFLICT_ACTION_LABELS,
  AUTOMOTIVE_MIRROR_FRESHNESS_LABELS,
  AUTOMOTIVE_OFFLINE_CONFLICT_MESSAGES,
  AUTOMOTIVE_OFFLINE_REQUEST_STATUS_LABELS,
  automotiveConflictResolution,
  automotiveSyncSummary,
  mirrorFreshness,
  type AutomotiveConflictResolutionAction,
  type AutomotiveOfflineConflictCode,
  type AutomotiveOfflineRequestStatus,
  type AutomotiveMirrorFreshness,
} from "@/lib/automotive-offline";
// The board's vocabulary, not the wire contract: `automotive-stock-projection.ts`
// hashes snapshots with `node:crypto`, so a client component importing it would
// pull the server layer into the browser bundle (client-bundle-boundary.test.ts).
import {
  mirrorDaysInStock,
  VEHICLE_AVAILABILITY_LABELS,
  type VehicleAvailability,
} from "@/lib/automotive-board";

interface CapabilityDto {
  mode: "local_authority" | "read_only_mirror" | "cloud_authority";
  localStockReads: boolean;
  reservationRequests: boolean;
  releaseRequests: boolean;
  offlineSaleFinalization: false;
  offlineAcquisition: false;
  label: string;
  reason: string;
}

interface MirrorVehicleDto {
  serial_id: string;
  stock_number: string;
  make: string;
  model: string;
  trim: string | null;
  condition: "new" | "used";
  state: string;
  availability: VehicleAvailability;
  model_year: number | null;
  mileage_km: number | null;
  vin: string | null;
  chassis_number: string | null;
  acquired_on: string | null;
  asking_price_rial: string | null;
  reservation_id: string | null;
  reservation_customer_name: string | null;
  source_version: string;
  cloud_updated_at: string;
  synced_at: string;
}

interface OfflineRequestDto {
  id: string;
  request_type: "reserve" | "release";
  serial_id: string;
  stock_number: string;
  customer_id: string | null;
  customer_name: string | null;
  reservation_id: string | null;
  deposit_amount_rial: string;
  deposit_method: string | null;
  deposit_refundable: boolean;
  note: string | null;
  expires_at: string | null;
  reason: string | null;
  refund_deposit: boolean | null;
  status: AutomotiveOfflineRequestStatus;
  conflict_code: string | null;
  acknowledged_at: string | null;
  requested_at: string;
  resolved_at: string | null;
}

interface OfflineBoardDto {
  capability: CapabilityDto;
  status: {
    vehicles: number;
    reserved: number;
    pendingRequests: number;
    conflicts: number;
    lastSyncedAt: string | null;
    state: { checkedAt: string | null; appliedAt: string | null; lastError: string | null };
  };
  vehicles: MirrorVehicleDto[];
  requests: OfflineRequestDto[];
}

const DEPOSIT_METHODS = [
  { value: "cash", label: "نقدی" },
  { value: "card", label: "کارت‌خوان" },
  { value: "card_to_card", label: "کارت‌به‌کارت" },
  { value: "online", label: "آنلاین" },
] as const;

/** The board's money, the same shape the rest of the module uses (`useVehicleMoney`). */
function useBoardMoney() {
  const api = useMoney();
  return useMemo(
    () => ({
      unitLabel: api.unitLabel,
      money: (rialText: string | null): string => (rialText == null ? "—" : api.formatText(rialText, { withUnit: false })),
      fromInput: (input: string): number => {
        const value = Math.trunc(Number(input.trim() || 0));
        return Number.isFinite(value) && value > 0 ? api.fromInput(value) : 0;
      },
    }),
    [api],
  );
}

const AVAILABILITY_TONE: Record<VehicleAvailability, "positive" | "active" | "neutral" | "danger"> = {
  available: "positive",
  reserved: "active",
  sold: "neutral",
  unavailable: "danger",
};

const REQUEST_TONE: Record<AutomotiveOfflineRequestStatus, "active" | "positive" | "danger" | "neutral"> = {
  pending: "active",
  confirmed: "positive",
  conflict: "danger",
  cancelled: "neutral",
};

export function AutomotiveOfflineBoard({ onOpenVehicle }: { onOpenVehicle?: (serialId: string) => void }) {
  const { money, unitLabel, fromInput } = useBoardMoney();
  const [board, setBoard] = useState<OfflineBoardDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => new Date());

  const [serialId, setSerialId] = useState("");
  const [customer, setCustomer] = useState<PickerCustomer | null>(null);
  const [expiresAt, setExpiresAt] = useState("");
  const [deposit, setDeposit] = useState("");
  const [depositMethod, setDepositMethod] = useState("cash");
  const [releaseReason, setReleaseReason] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    void (async () => {
      const result = await api<OfflineBoardDto & { error?: string; message?: string }>("/api/automotive/offline", {
        signal: controller.signal,
      });
      if (cancelled) return;
      if (result.ok) {
        setBoard(result.data);
        setError("");
      } else {
        setError(errorMessage(result.data.error) || "خطا در دریافت موجودی همگام‌شده");
      }
      setLoading(false);
      setNow(new Date());
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [reloadKey]);

  const freshness: AutomotiveMirrorFreshness = useMemo(
    () => mirrorFreshness(board?.status.lastSyncedAt ?? null, now),
    [board?.status.lastSyncedAt, now],
  );

  const openRequests = useMemo(
    () => (board?.requests ?? []).filter((request) => request.status === "pending"),
    [board?.requests],
  );
  const conflicts = useMemo(
    () => (board?.requests ?? []).filter((request) => request.status === "conflict" && !request.acknowledged_at),
    [board?.requests],
  );
  const decided = useMemo(
    () =>
      (board?.requests ?? []).filter(
        (request) => request.status === "confirmed" || (request.status === "conflict" && Boolean(request.acknowledged_at)),
      ),
    [board?.requests],
  );
  const heldByBranch = useMemo(
    () =>
      (board?.vehicles ?? []).filter(
        (vehicle) => vehicle.availability === "reserved" && Boolean(vehicle.reservation_id),
      ),
    [board?.vehicles],
  );

  const capability = board?.capability;
  const canQueue = Boolean(capability?.reservationRequests && capability?.releaseRequests);
  const candidate = (board?.vehicles ?? []).find((vehicle) => vehicle.serial_id === serialId) ?? null;

  const run = useCallback(async (work: () => Promise<{ ok: boolean; data: { error?: string; message?: string } }>) => {
    setBusy(true);
    const result = await work();
    setNotice(result.ok ? "" : errorMessage(result.data.error) || result.data.message || "خطا در ثبت درخواست");
    if (result.ok) setReloadKey((key) => key + 1);
    setBusy(false);
    return result.ok;
  }, []);

  async function queueReserve() {
    if (!candidate || !customer) return;
    const ok = await run(() =>
      api<{ error?: string; message?: string }>("/api/automotive/offline/requests", {
        method: "POST",
        body: JSON.stringify({
          kind: "reserve",
          serialId: candidate.serial_id,
          stockNumber: candidate.stock_number,
          customerId: customer.id,
          customerName: customer.name,
          expiresAt: expiresAt || null,
          depositRial: fromInput(deposit),
          depositMethod: fromInput(deposit) > 0 ? depositMethod : null,
          depositRefundable: true,
          expectedVersion: Number(candidate.source_version),
          expectedState: candidate.state,
        }),
      }),
    );
    if (ok) {
      setNotice("درخواست رزرو ثبت شد و در انتظار تأیید سرور است؛ تا آن زمان خودرو رزرو محسوب نمی‌شود.");
      setSerialId("");
      setCustomer(null);
      setExpiresAt("");
      setDeposit("");
    }
  }

  async function queueRelease(vehicle: MirrorVehicleDto) {
    const reason = (releaseReason[vehicle.serial_id] ?? "").trim();
    if (!reason || !vehicle.reservation_id) return;
    const ok = await run(() =>
      api<{ error?: string; message?: string }>("/api/automotive/offline/requests", {
        method: "POST",
        body: JSON.stringify({
          kind: "release",
          reservationId: vehicle.reservation_id,
          serialId: vehicle.serial_id,
          stockNumber: vehicle.stock_number,
          reason,
          refundDeposit: true,
          expectedVersion: Number(vehicle.source_version),
          expectedState: vehicle.state,
        }),
      }),
    );
    if (ok) {
      setNotice("درخواست آزادسازی ثبت شد و پس از تأیید سرور، رزرو آزاد و ودیعه (در صورت قابل استرداد بودن) برمی‌گردد.");
      setReleaseReason((map) => ({ ...map, [vehicle.serial_id]: "" }));
    }
  }

  async function cancelRequest(id: string) {
    await run(() => api<{ error?: string; message?: string }>(`/api/automotive/offline/requests/${id}/cancel`, { method: "POST" }));
  }

  async function acknowledgeRequest(id: string) {
    await run(() =>
      api<{ error?: string; message?: string }>(`/api/automotive/offline/requests/${id}/acknowledge`, { method: "POST" }),
    );
  }

  /** Re-queue a refused request against the row the cloud has now, with a fresh id. */
  async function retryRequest(request: OfflineRequestDto) {
    const vehicle = (board?.vehicles ?? []).find((row) => row.serial_id === request.serial_id);
    if (!vehicle || request.request_type !== "reserve" || !request.customer_id) return;
    const ok = await run(() =>
      api<{ error?: string; message?: string }>("/api/automotive/offline/requests", {
        method: "POST",
        body: JSON.stringify({
          kind: "reserve",
          serialId: vehicle.serial_id,
          stockNumber: vehicle.stock_number,
          customerId: request.customer_id,
          customerName: request.customer_name ?? "",
          expiresAt: request.expires_at,
          depositRial: Number(request.deposit_amount_rial),
          depositMethod: request.deposit_method,
          depositRefundable: request.deposit_refundable,
          expectedVersion: Number(vehicle.source_version),
          expectedState: vehicle.state,
        }),
      }),
    );
    if (ok) setNotice("درخواست تازه با وضعیت فعلی خودرو ثبت شد.");
  }

  function resolveConflictAction(request: OfflineRequestDto, action: AutomotiveConflictResolutionAction) {
    if (action === "cancel") return cancelRequest(request.id);
    if (action === "retry") return retryRequest(request);
    onOpenVehicle?.(request.serial_id);
    return Promise.resolve();
  }

  return (
    <div className="space-y-4">
      <SectionCard
        title="موجودی همگام‌شدهٔ خودرو"
        description={capability?.label ?? "وضعیت دسترسی محلی به موجودی خودرو"}
      >
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {notice ? <p className="text-xs leading-5 text-muted-foreground">{notice}</p> : null}
        {capability ? (
          <p className="mt-2 text-xs leading-6 text-muted-foreground">{capability.reason}</p>
        ) : null}
        {board ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <StatusBadge tone={freshness === "fresh" ? "positive" : freshness === "stale" ? "danger" : "neutral"}>
              {AUTOMOTIVE_MIRROR_FRESHNESS_LABELS[freshness]}
            </StatusBadge>
            <span>
              {automotiveSyncSummary({
                vehicles: board.status.vehicles,
                reserved: board.status.reserved,
                pendingRequests: board.status.pendingRequests,
                conflicts: board.status.conflicts,
                freshness,
              })}
            </span>
            {board.status.lastSyncedAt ? (
              <span>آخرین همگام‌سازی: {formatJalali(board.status.lastSyncedAt.slice(0, 10))}</span>
            ) : null}
            {board.status.state.lastError ? <span className="text-destructive">آخرین خطا: {board.status.state.lastError}</span> : null}
          </div>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <SecondaryButton onClick={() => setReloadKey((key) => key + 1)} disabled={loading || busy}>
            به‌روزرسانی
          </SecondaryButton>
          <span className="text-xs text-muted-foreground">
            فروش، خرید و انتقال خودرو در این نسخه فقط با اتصال به سرور مرکزی ثبت می‌شود؛ این صفحه فقط خواندنی است.
          </span>
        </div>
      </SectionCard>

      {canQueue ? (
        <SectionCard title="رزرو در حالت آفلاین" description="درخواست ذخیره می‌شود و پس از تأیید سرور قطعی می‌گردد">
          <p className="text-xs leading-5 text-muted-foreground">
            این درخواست تا زمانی که سرور مرکزی تأیید نکند «رزرو» نیست: خودرو همچنان آزاد نمایش داده می‌شود و ودیعه
            ثبت حسابداری نمی‌شود. اگر سرور خودرو را نپذیرد (فروخته یا رزروشده)، دلیل آن ثبت و در همین صفحه نمایش داده
            می‌شود.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="خودرو">
              <select className={inputClass} value={serialId} onChange={(event) => setSerialId(event.target.value)}>
                <option value="">— انتخاب خودرو —</option>
                {(board?.vehicles ?? [])
                  .filter((vehicle) => vehicle.availability === "available")
                  .map((vehicle) => (
                    <option key={vehicle.serial_id} value={vehicle.serial_id}>
                      {vehicle.stock_number} — {vehicle.make} {vehicle.model}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="مشتری">
              <CustomerPicker customer={customer} onChange={setCustomer} idPrefix="automotive-offline" canCreate={false} />
            </Field>
            <Field label="تاریخ انقضا (اختیاری)">
              <JalaliDatePicker value={expiresAt} onChange={setExpiresAt} ariaLabel="تاریخ انقضای رزرو" />
            </Field>
            <Field label={`ودیعه (${unitLabel})`}>
              <PersianNumberInput
                className={inputClass}
                inputMode="numeric"
                value={deposit}
                onChange={(event) => setDeposit(event.target.value)}
              />
            </Field>
            <Field label="روش دریافت ودیعه">
              <select
                className={inputClass}
                value={depositMethod}
                disabled={fromInput(deposit) === 0}
                onChange={(event) => setDepositMethod(event.target.value)}
              >
                {DEPOSIT_METHODS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="mt-4">
            <PrimaryButton onClick={queueReserve} disabled={busy || !serialId || !customer}>
              {busy ? "در حال ثبت…" : "ثبت درخواست رزرو"}
            </PrimaryButton>
          </div>
        </SectionCard>
      ) : null}

      <SectionCard title="موجودی محلی" description="آخرین تصویری که سرور مرکزی از این شعبه داده است">
        {loading && !board ? (
          <SectionCardSkeleton />
        ) : (board?.vehicles ?? []).length === 0 ? (
          <EmptyState title="خودرویی در موجودی محلی نیست">
            یا این شعبه خودرویی ندارد، یا هنوز همگام‌سازی نخست انجام نشده است.
          </EmptyState>
        ) : (
          <DataTable caption="موجودی محلی خودرو">
            <DataTableHead>
              <Th>خودرو</Th>
              <Th>وضعیت</Th>
              <Th>قیمت</Th>
              <Th>روز در انبار</Th>
              <Th>رزرو</Th>
              <Th>{canQueue ? "آزادسازی" : "شناسه"}</Th>
            </DataTableHead>
            <DataTableBody>
              {(board?.vehicles ?? []).map((vehicle) => (
                <DataTableRow key={vehicle.serial_id}>
                  <Td>
                    <button
                      type="button"
                      className="text-right"
                      onClick={() => onOpenVehicle?.(vehicle.serial_id)}
                    >
                      <span className="block font-medium">
                        {vehicle.stock_number} — {vehicle.make} {vehicle.model}
                        {vehicle.trim ? ` ${vehicle.trim}` : ""}
                      </span>
                      <span className="block text-xs text-muted-foreground" dir="ltr">
                        {vehicle.vin ?? vehicle.chassis_number ?? "—"}
                      </span>
                    </button>
                  </Td>
                  <Td>
                    <StatusBadge tone={AVAILABILITY_TONE[vehicle.availability]}>
                      {VEHICLE_AVAILABILITY_LABELS[vehicle.availability]}
                    </StatusBadge>
                  </Td>
                  <Td>{money(vehicle.asking_price_rial)}</Td>
                  <Td>{toPersianDigits(mirrorDaysInStock(vehicle.acquired_on, now.toISOString().slice(0, 10)) ?? 0)}</Td>
                  <Td>{vehicle.reservation_customer_name ?? "—"}</Td>
                  <Td>
                    {canQueue && vehicle.availability === "reserved" && vehicle.reservation_id ? (
                      <div className="flex items-center gap-2">
                        <input
                          className={`${inputClass} h-9`}
                          placeholder="دلیل آزادسازی"
                          value={releaseReason[vehicle.serial_id] ?? ""}
                          onChange={(event) =>
                            setReleaseReason((map) => ({ ...map, [vehicle.serial_id]: event.target.value }))
                          }
                        />
                        <SecondaryButton
                          onClick={() => queueRelease(vehicle)}
                          disabled={busy || !(releaseReason[vehicle.serial_id] ?? "").trim()}
                        >
                          درخواست آزادسازی
                        </SecondaryButton>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground" dir="ltr">
                        {vehicle.serial_id.slice(0, 8)}
                      </span>
                    )}
                  </Td>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
      </SectionCard>

      <SectionCard
        title="درخواست‌های در انتظار تأیید سرور"
        description={`${toPersianDigits(openRequests.length)} درخواست باز`}
      >
        {openRequests.length === 0 ? (
          <EmptyState title="درخواست بازی نیست">همهٔ درخواست‌ها به سرور مرکزی رسیده و پاسخ گرفته‌اند.</EmptyState>
        ) : (
          <DataTable caption="درخواست‌های در انتظار تأیید">
            <DataTableHead>
              <Th>خودرو</Th>
              <Th>نوع</Th>
              <Th>مشتری</Th>
              <Th>ودیعه</Th>
              <Th>ثبت</Th>
              <Th>لغو</Th>
            </DataTableHead>
            <DataTableBody>
              {openRequests.map((request) => (
                <DataTableRow key={request.id}>
                  <Td>{request.stock_number}</Td>
                  <Td>{request.request_type === "reserve" ? "رزرو" : "آزادسازی"}</Td>
                  <Td>{request.customer_name ?? "—"}</Td>
                  <Td>{money(Number(request.deposit_amount_rial) > 0 ? request.deposit_amount_rial : null)}</Td>
                  <Td>{formatJalali(request.requested_at.slice(0, 10))}</Td>
                  <Td>
                    <SecondaryButton onClick={() => cancelRequest(request.id)} disabled={busy}>
                      لغو
                    </SecondaryButton>
                  </Td>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
      </SectionCard>

      {conflicts.length > 0 ? (
        <SectionCard title="تعارض‌های نیازمند تصمیم" description={`${toPersianDigits(conflicts.length)} مورد`}>
          <ul className="space-y-3">
            {conflicts.map((request) => {
              const resolution = automotiveConflictResolution(request.conflict_code as AutomotiveOfflineConflictCode);
              return (
                <li key={request.id} className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
                  <p className="text-sm font-medium">
                    {request.stock_number} — {resolution.message}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    درخواست {request.request_type === "reserve" ? "رزرو" : "آزادسازی"} در{" "}
                    {formatJalali(request.requested_at.slice(0, 10))} ثبت و توسط سرور رد شد.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {resolution.actions.map((action) => (
                      <SecondaryButton
                        key={action}
                        onClick={() => resolveConflictAction(request, action)}
                        disabled={busy}
                      >
                        {AUTOMOTIVE_CONFLICT_ACTION_LABELS[action]}
                      </SecondaryButton>
                    ))}
                    <SecondaryButton onClick={() => acknowledgeRequest(request.id)} disabled={busy}>
                      خواندم و بستم
                    </SecondaryButton>
                  </div>
                </li>
              );
            })}
          </ul>
        </SectionCard>
      ) : null}

      <SectionCard title="پاسخ‌های سرور" description="رزروهای تأییدشده و تعارض‌های بسته‌شده">
        {decided.length === 0 ? (
          <EmptyState title="هنوز پاسخ تأییدشده‌ای نیست">پس از تأیید سرور، نتیجه در همین جدول نمایش داده می‌شود.</EmptyState>
        ) : (
          <DataTable caption="پاسخ‌های سرور به درخواست‌ها">
            <DataTableHead>
              <Th>خودرو</Th>
              <Th>نوع</Th>
              <Th>نتیجه</Th>
              <Th>به‌روزرسانی</Th>
            </DataTableHead>
            <DataTableBody>
              {decided.map((request) => (
                <DataTableRow key={request.id}>
                  <Td>{request.stock_number}</Td>
                  <Td>{request.request_type === "reserve" ? "رزرو" : "آزادسازی"}</Td>
                  <Td>
                    <StatusBadge tone={REQUEST_TONE[request.status]}>
                      {AUTOMOTIVE_OFFLINE_REQUEST_STATUS_LABELS[request.status]}
                    </StatusBadge>
                    {request.status === "conflict" ? (
                      <span className="block text-xs text-muted-foreground">
                        {AUTOMOTIVE_OFFLINE_CONFLICT_MESSAGES[request.conflict_code as AutomotiveOfflineConflictCode]}
                      </span>
                    ) : null}
                  </Td>
                  <Td>{request.resolved_at ? formatJalali(request.resolved_at.slice(0, 10)) : "—"}</Td>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
        {heldByBranch.length > 0 ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {toPersianDigits(heldByBranch.length)} خودرو در این شعبه رزرو فعال دارد؛ فروش آن فقط از سرور مرکزی و برای همان
            مشتری ممکن است.
          </p>
        ) : null}
      </SectionCard>
    </div>
  );
}
