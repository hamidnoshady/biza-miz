"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { formatJalali } from "@/lib/jalali";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { api, Field, inputClass } from "../ui";
import { cardClass } from "../page-chrome";
import type { Runner, SerialUnit } from "./watch-manager";

/**
 * Issue #795 Phase 3 — the serialized customer-return workflow:
 * requested → received_for_inspection → dispositioned (or cancelled).
 * Request opens the claim against the sold unit's own invoice; receiving
 * records the physical unit is in hand; disposition is the manager-approved
 * completion — explicit fate of the unit plus the full financial reversal.
 */
export interface SerialReturn {
  id: string;
  orderId: string;
  serialId: string;
  serialNumber: string;
  itemName: string;
  status: string;
  disposition: string | null;
  reason: string;
  inspectionNotes: string | null;
  refundMethod: string | null;
  refundAmount: string | null;
  createdAt: string;
  dispositionedAt: string | null;
}

const RETURN_STATUS_LABELS: Record<string, string> = {
  requested: "درخواست‌شده",
  received_for_inspection: "دریافت‌شده برای بازرسی",
  dispositioned: "تعیین‌تکلیف‌شده",
  cancelled: "لغوشده",
};

const DISPOSITION_LABELS: Record<string, string> = {
  returned_sellable: "بازگشت به فروش",
  returned_service_required: "نیازمند سرویس",
  returned_damaged: "آسیب‌دیده (زیان)",
  supplier_claim: "ادعا از تأمین‌کننده",
  write_off: "ازرده‌خارج (زیان)",
  exchange: "تعویض",
};

const REFUND_METHOD_LABELS: Record<string, string> = {
  cash: "نقدی",
  card: "کارت",
  card_to_card: "کارت‌به‌کارت",
  online: "آنلاین",
  credit: "اعتباری",
};

const STATUS_BADGE_CLASS: Record<string, string> = {
  requested: "bg-amber-100 dark:bg-amber-500/20 text-amber-900 dark:text-amber-200",
  received_for_inspection: "bg-sky-100 dark:bg-sky-500/20 text-sky-900 dark:text-sky-100",
  dispositioned: "bg-emerald-100 dark:bg-emerald-500/20 text-emerald-900 dark:text-emerald-100",
  cancelled: "bg-muted text-muted-foreground",
};

export function ReturnsSection({
  returns,
  units,
  busy,
  run,
}: {
  returns: SerialReturn[];
  units: SerialUnit[];
  busy: boolean;
  run: Runner;
}) {
  const { format } = useMoney();
  const [serialId, setSerialId] = useState("");
  const [reason, setReason] = useState("");
  const [notesById, setNotesById] = useState<Record<string, string>>({});
  const [dispositionById, setDispositionById] = useState<Record<string, string>>({});
  const [refundMethodById, setRefundMethodById] = useState<Record<string, string>>({});

  const soldUnits = units.filter((u) => u.status === "sold");

  async function submitRequest() {
    if (!serialId || !reason.trim()) return;
    const ok = await run(() =>
      api("/api/watch/returns", {
        method: "POST",
        body: JSON.stringify({ serialId, reason }),
      }),
    );
    if (ok) {
      setSerialId("");
      setReason("");
    }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    await run(() =>
      api(`/api/watch/returns/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    );
  }

  return (
    <div className="space-y-4">
      <section aria-labelledby="watch-return-request-heading" className={`${cardClass} p-4 sm:p-5`}>
        <h2 id="watch-return-request-heading" className="font-semibold text-foreground">
          ثبت درخواست مرجوعی
        </h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          دستگاه فروخته‌شده را انتخاب کنید؛ فاکتور فروش همان دستگاه به‌صورت خودکار پیدا می‌شود. فروش اصلی
          دست‌نخورده می‌ماند تا بازرسی و تأیید مدیر، تکلیف دستگاه و برگشت مالی را یک‌جا تعیین کند.
        </p>
        <div className="mt-3 grid gap-2">
          <Field label="دستگاه فروخته‌شده">
            <SearchableSelect
              value={serialId}
              onChange={setSerialId}
              options={[
                { value: "", label: "انتخاب کنید…" },
                ...soldUnits.map((u) => ({
                  value: u.id,
                  label: `${u.itemName} — ${u.serialNumber}`,
                  searchString: `${u.itemName} ${u.serialNumber}`,
                })),
              ]}
              placeholder="انتخاب کنید…"
              searchPlaceholder="جستجوی سریال…"
              ariaLabel="انتخاب دستگاه برای مرجوعی"
            />
          </Field>
          <Field label="دلیل مرجوعی">
            <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Button type="button" disabled={busy} onClick={() => void submitRequest()} className="min-h-11 w-full">
            ثبت درخواست
          </Button>
        </div>
      </section>

      <section aria-labelledby="watch-returns-heading" className={`min-w-0 overflow-hidden ${cardClass}`}>
        <div className="border-b border-border/80 px-4 py-4 sm:px-5">
          <h2 id="watch-returns-heading" className="font-semibold text-foreground">
            مرجوعی‌های سریالی
          </h2>
        </div>
        {returns.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground sm:px-5">مرجوعی ثبت نشده است.</p>
        ) : (
          <ul className="divide-y divide-border/80">
            {returns.map((ret) => (
              <li key={ret.id} className="space-y-3 px-4 py-4 sm:px-5">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                  <h3 className="min-w-0 break-words font-semibold text-foreground">{ret.itemName}</h3>
                  <span className="text-xs text-muted-foreground" dir="ltr">
                    {ret.serialNumber}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASS[ret.status] ?? "bg-muted text-muted-foreground"}`}
                  >
                    {RETURN_STATUS_LABELS[ret.status] ?? ret.status}
                  </span>
                  {ret.disposition ? (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      {DISPOSITION_LABELS[ret.disposition] ?? ret.disposition}
                    </span>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  دلیل: {ret.reason}
                  {" · "}
                  {toPersianDigits(formatJalali(ret.createdAt.slice(0, 10), { withMonthName: true }))}
                  {ret.refundAmount ? <> {" · "} بازپرداخت: {format(Number(ret.refundAmount))}</> : null}
                </p>
                {ret.inspectionNotes ? (
                  <p className="text-xs text-muted-foreground">بازرسی: {ret.inspectionNotes}</p>
                ) : null}

                {ret.status === "requested" ? (
                  <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
                    <input
                      className={inputClass}
                      placeholder="یادداشت بازرسی…"
                      value={notesById[ret.id] ?? ""}
                      onChange={(e) => setNotesById((m) => ({ ...m, [ret.id]: e.target.value }))}
                    />
                    <Button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void patch(ret.id, { action: "receive", inspectionNotes: notesById[ret.id] ?? null })
                      }
                      className="min-h-11"
                    >
                      دریافت برای بازرسی
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void patch(ret.id, { action: "cancel" })}
                      className="min-h-11"
                    >
                      لغو
                    </Button>
                  </div>
                ) : null}

                {ret.status === "received_for_inspection" ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Field label="تعیین‌تکلیف">
                      <select
                        className={inputClass}
                        value={dispositionById[ret.id] ?? ""}
                        onChange={(e) => setDispositionById((m) => ({ ...m, [ret.id]: e.target.value }))}
                      >
                        <option value="">انتخاب کنید…</option>
                        {Object.entries(DISPOSITION_LABELS).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="روش بازپرداخت">
                      <select
                        className={inputClass}
                        value={refundMethodById[ret.id] ?? "cash"}
                        onChange={(e) => setRefundMethodById((m) => ({ ...m, [ret.id]: e.target.value }))}
                      >
                        {Object.entries(REFUND_METHOD_LABELS).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Button
                      type="button"
                      disabled={busy || !dispositionById[ret.id]}
                      onClick={() =>
                        void patch(ret.id, {
                          action: "disposition",
                          disposition: dispositionById[ret.id],
                          refundMethod: refundMethodById[ret.id] ?? "cash",
                        })
                      }
                      className="min-h-11 sm:col-span-2"
                    >
                      تأیید مدیر و تکمیل مرجوعی
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
