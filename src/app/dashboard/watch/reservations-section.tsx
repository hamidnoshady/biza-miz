"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatJalali } from "@/lib/jalali";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { api, Field, inputClass } from "../ui";
import { cardClass } from "../page-chrome";
import { CustomerPicker, type PickerCustomer } from "../customer-picker";
import { JalaliDatePicker } from "../jalali-date-picker";
import type { Runner, SerialUnit } from "./watch-manager";

/**
 * Issue #795 item 20 — reservations (holds): one exact unit promised to one
 * exact customer. The hold converts by itself when that customer's invoice
 * sells the unit; an expired hold stops blocking anyone; releasing by hand
 * records the reason.
 */
export interface SerialReservation {
  id: string;
  serialId: string;
  serialNumber: string;
  itemName: string;
  customerId: string;
  customerName: string | null;
  status: string;
  expiresAt: string | null;
  note: string | null;
  releaseReason: string | null;
  createdAt: string;
}

const RESERVATION_STATUS_LABELS: Record<string, string> = {
  active: "فعال",
  converted: "تبدیل به فروش",
  released: "آزادشده",
  expired: "منقضی",
};

const STATUS_BADGE_CLASS: Record<string, string> = {
  active: "bg-amber-100 dark:bg-amber-500/20 text-amber-900 dark:text-amber-200",
  converted: "bg-emerald-100 dark:bg-emerald-500/20 text-emerald-900 dark:text-emerald-100",
  released: "bg-muted text-muted-foreground",
  expired: "bg-muted text-muted-foreground",
};

export function ReservationsSection({
  reservations,
  units,
  busy,
  run,
}: {
  reservations: SerialReservation[];
  units: SerialUnit[];
  busy: boolean;
  run: Runner;
}) {
  const [serialId, setSerialId] = useState("");
  const [customer, setCustomer] = useState<PickerCustomer | null>(null);
  const [expiresAt, setExpiresAt] = useState("");
  const [note, setNote] = useState("");
  const [releaseReasonById, setReleaseReasonById] = useState<Record<string, string>>({});

  const availableUnits = units.filter((u) => u.status === "in_stock");

  async function submit() {
    if (!serialId || !customer) return;
    const ok = await run(() =>
      api("/api/watch/reservations", {
        method: "POST",
        body: JSON.stringify({
          serialId,
          customerId: customer.id,
          expiresAt: expiresAt || null,
          note: note || null,
        }),
      }),
    );
    if (ok) {
      setSerialId("");
      setCustomer(null);
      setExpiresAt("");
      setNote("");
    }
  }

  async function release(id: string) {
    const reason = (releaseReasonById[id] ?? "").trim();
    if (!reason) return;
    const ok = await run(() =>
      api(`/api/watch/reservations/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ reason }),
      }),
    );
    if (ok) setReleaseReasonById((m) => ({ ...m, [id]: "" }));
  }

  return (
    <div className="space-y-4">
      <section aria-labelledby="watch-reserve-heading" className={`${cardClass} p-4 sm:p-5`}>
        <h2 id="watch-reserve-heading" className="font-semibold text-foreground">
          رزرو دستگاه برای مشتری
        </h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          دستگاه رزروشده فقط به نام همان مشتری قابل فروش است و با صدور فاکتور او، رزرو خودبه‌خود
          «تبدیل به فروش» می‌شود. رزرو منقضی‌شده مانع فروش به دیگران نیست.
        </p>
        <div className="mt-3 grid gap-2">
          <Field label="دستگاه موجود در انبار">
            <SearchableSelect
              value={serialId}
              onChange={setSerialId}
              options={[
                { value: "", label: "انتخاب کنید…" },
                ...availableUnits.map((u) => ({
                  value: u.id,
                  label: `${u.itemName} — ${u.serialNumber}`,
                  searchString: `${u.itemName} ${u.serialNumber}`,
                })),
              ]}
              placeholder="انتخاب کنید…"
              searchPlaceholder="جستجوی سریال…"
              ariaLabel="انتخاب دستگاه برای رزرو"
            />
          </Field>
          <Field label="مشتری">
            <CustomerPicker
              customer={customer}
              onChange={setCustomer}
              disabled={busy}
              idPrefix="watch-reservation-customer"
            />
          </Field>
          <Field label="تاریخ انقضای رزرو (اختیاری)">
            <JalaliDatePicker value={expiresAt} onChange={setExpiresAt} />
          </Field>
          <Field label="یادداشت (اختیاری)">
            <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Button
            type="button"
            disabled={busy || !serialId || !customer}
            onClick={() => void submit()}
            className="min-h-11 w-full"
          >
            ثبت رزرو
          </Button>
        </div>
      </section>

      <section aria-labelledby="watch-reservations-heading" className={`min-w-0 overflow-hidden ${cardClass}`}>
        <div className="border-b border-border/80 px-4 py-4 sm:px-5">
          <h2 id="watch-reservations-heading" className="font-semibold text-foreground">
            رزروها
          </h2>
        </div>
        {reservations.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground sm:px-5">رزروی ثبت نشده است.</p>
        ) : (
          <ul className="divide-y divide-border/80">
            {reservations.map((res) => (
              <li key={res.id} className="space-y-3 px-4 py-4 sm:px-5">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                  <h3 className="min-w-0 break-words font-semibold text-foreground">{res.itemName}</h3>
                  <span className="text-xs text-muted-foreground" dir="ltr">
                    {res.serialNumber}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASS[res.status] ?? "bg-muted text-muted-foreground"}`}
                  >
                    {RESERVATION_STATUS_LABELS[res.status] ?? res.status}
                  </span>
                </div>
                <dl className="grid min-w-0 gap-x-5 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2 xl:grid-cols-4">
                  <div>
                    <dt className="inline font-medium">مشتری: </dt>
                    <dd className="inline">{res.customerName ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium">ثبت: </dt>
                    <dd className="inline">{formatJalali(res.createdAt, { withMonthName: true })}</dd>
                  </div>
                  {res.expiresAt ? (
                    <div>
                      <dt className="inline font-medium">انقضا: </dt>
                      <dd className="inline">{formatJalali(res.expiresAt, { withMonthName: true })}</dd>
                    </div>
                  ) : null}
                  {res.note ? (
                    <div>
                      <dt className="inline font-medium">یادداشت: </dt>
                      <dd className="inline">{res.note}</dd>
                    </div>
                  ) : null}
                  {res.releaseReason ? (
                    <div>
                      <dt className="inline font-medium">دلیل آزادسازی: </dt>
                      <dd className="inline">{res.releaseReason}</dd>
                    </div>
                  ) : null}
                </dl>
                {res.status === "active" ? (
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <input
                      className={`${inputClass} sm:max-w-xs`}
                      placeholder="دلیل آزادسازی رزرو"
                      value={releaseReasonById[res.id] ?? ""}
                      onChange={(e) =>
                        setReleaseReasonById((m) => ({ ...m, [res.id]: e.target.value }))
                      }
                    />
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy || !(releaseReasonById[res.id] ?? "").trim()}
                      onClick={() => void release(res.id)}
                      className="min-h-11"
                    >
                      آزادسازی رزرو
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
