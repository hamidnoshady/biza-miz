"use client";

import Link from "next/link";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useEffect, useMemo, useState } from "react";
import { SearchIcon, UsersIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ACCOUNTING_WORKSPACE_HREFS } from "@/lib/app-routes";
import { toPersianDigits } from "@/lib/digits";
import { listSelectableTables, type PosTable } from "@/lib/pos-selection";
import { inputClass } from "../ui";

/**
 * The one place a table is chosen, on every device.
 *
 * It is reached two ways, and `intent` is which: `"select"` when the cashier
 * opens it from the cart to seat the order up front, and `"order"`/`"payment"`
 * when they pressed one of the two close-the-sale buttons with no table picked
 * and are answering the question here instead of being sent back with an error.
 * Confirming hands the chosen table (and the guest count, which is only ever
 * asked alongside it) back to the POS, which carries on into whatever it was
 * headed for.
 *
 * The cart panel and the mobile sheet used to draw their own flat grids of every
 * table instead — no search, no capacity, no occupied state, and two more places
 * for the three to drift apart.
 *
 * An already-seated table is offered, not greyed out: friends at one table who
 * want separate bills are one party and several invoices, so the second order is
 * the point rather than a mistake to block. Only a table the server itself would
 * refuse — being cleaned, out of service — is unselectable here.
 */
export function TablePickerDialog({
  open,
  tables,
  selectedTableId,
  guestCount,
  intent,
  onCancel,
  onConfirm,
  onSelectExistingOrder,
}: {
  open: boolean;
  tables: PosTable[];
  selectedTableId: string;
  guestCount: string;
  intent: "order" | "payment" | "select";
  onCancel: () => void;
  onConfirm: (
    tableId: string,
    guestCount: string,
    options?: { mode: "new" },
  ) => void;
  onSelectExistingOrder?: (orderId: string, tableId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [draftTableId, setDraftTableId] = useState(selectedTableId);
  const [draftGuestCount, setDraftGuestCount] = useState(guestCount);

  // Each time the prompt comes up it starts from what the POS holds right now,
  // so an abandoned attempt never leaves a stale table pre-selected.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setDraftTableId(selectedTableId);
    setDraftGuestCount(guestCount);
  }, [open, selectedTableId, guestCount]);

  const choices = useMemo(
    () => listSelectableTables({ tables, query }),
    [tables, query],
  );
  const chosen = choices.find((table) => table.id === draftTableId);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>انتخاب میز</DialogTitle>
          <DialogDescription>
            {intent === "payment"
              ? "برای سفارش حضوری پیش از دریافت وجه، میز را انتخاب کنید."
              : intent === "order"
                ? "برای ثبت سفارش حضوری، میز را انتخاب کنید."
                : "میز این سفارش را انتخاب کنید."}
          </DialogDescription>
        </DialogHeader>

        {tables.length > 8 ? (
          <label className="relative block" htmlFor="pos-table-search">
            <span className="sr-only">جستجوی میز</span>
            <SearchIcon
              className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              id="pos-table-search"
              className={inputClass + " min-h-11 border-border/80 bg-muted"}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="نام میز"
            />
          </label>
        ) : null}

        {tables.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/80 bg-muted p-4 text-center text-sm text-muted-foreground">
            هنوز میزی ثبت نشده است. از بخش میزها میز اضافه کنید یا نوع سفارش را
            به بیرون‌بر تغییر دهید.
          </p>
        ) : choices.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/80 bg-muted p-4 text-center text-sm text-muted-foreground">
            میزی با این نام پیدا نشد.
          </p>
        ) : (
          <>
            {/*
              Auto-fit: two columns on a phone, three to four as the pane
              widens, never a fixed grid a small dialog has to scroll
              horizontally. Tiles stay compact — name plus one quiet line — and
              every target clears 44px. An occupied table is marked with a dot
              and stays pickable (separate bills are a feature, not an error).
            */}
            <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4">
              {choices.map((table) => (
                <li key={table.id}>
                  <button
                    type="button"
                    disabled={table.unavailable}
                    aria-pressed={draftTableId === table.id}
                    aria-label={
                      table.name +
                      (table.unavailable
                        ? "، در دسترس نیست"
                        : table.occupied
                          ? "، اشغال — صورت‌حساب جداگانه"
                          : "")
                    }
                    onClick={() => setDraftTableId(table.id)}
                    className={
                      "flex min-h-14 w-full flex-col items-center justify-center gap-0.5 rounded-xl border px-2 py-1.5 text-sm font-bold transition duration-200 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 disabled:cursor-not-allowed motion-reduce:transition-none " +
                      (draftTableId === table.id
                        ? "border-amber-500 dark:border-amber-500/60 bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300"
                        : table.unavailable
                          ? "border-border/80 bg-muted text-muted-foreground"
                          : "border-border/80 text-muted-foreground hover:border-amber-500/60 dark:hover:border-amber-500/60 hover:bg-muted")
                    }
                  >
                    <span className="flex items-center gap-1.5">
                      {table.occupied && !table.unavailable ? (
                        <span
                          className="inline-block size-2 shrink-0 rounded-full bg-amber-500 dark:bg-amber-400"
                          aria-hidden="true"
                        />
                      ) : null}
                      <span className="truncate">{table.name}</span>
                    </span>
                    <span className="flex items-center gap-1 text-[11px] font-normal leading-4">
                      {table.unavailable ? (
                        "در دسترس نیست"
                      ) : table.occupied ? (
                        table.active_order_count && table.active_order_count > 0 ? (
                          `اشغال (${toPersianDigits(table.active_order_count)} سفارش)`
                        ) : (
                          "اشغال"
                        )
                      ) : table.active_order_count && table.active_order_count > 0 ? (
                        `${toPersianDigits(table.active_order_count)} سفارش فعال`
                      ) : (
                        <>
                          <UsersIcon className="size-3" aria-hidden="true" />
                          {toPersianDigits(table.capacity)} نفر
                        </>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {chosen &&
            (chosen.occupied ||
              (chosen.active_order_count ?? 0) > 0 ||
              (chosen.open_orders?.length ?? 0) > 0) ? (
              <div className="space-y-2 rounded-xl border border-amber-400/50 bg-amber-50/70 dark:bg-amber-500/10 p-3 text-xs">
                <p className="font-semibold text-foreground">
                  این میز سفارش فعال دارد — عملیات مورد نظر را مشخص کنید:
                </p>
                <p className="text-muted-foreground">
                  ثبت سفارش جدید هرگز به آخرین سفارش باز اضافه نمی‌شود و صورت‌حساب مستقل خودش را می‌گیرد.
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    aria-pressed="true"
                    onClick={() =>
                      onConfirm(draftTableId, draftGuestCount, { mode: "new" })
                    }
                    className="rounded-lg border border-amber-500 dark:border-amber-400 bg-amber-500 dark:bg-amber-400 px-3 py-1.5 text-xs font-bold text-amber-950"
                  >
                    + ثبت سفارش جدید مستقل
                  </button>
                  {(chosen.open_orders ?? []).map((ord) =>
                    onSelectExistingOrder ? (
                      <button
                        key={ord.id}
                        type="button"
                        onClick={() => onSelectExistingOrder(ord.id, chosen.id)}
                        className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-semibold text-foreground hover:bg-muted"
                      >
                        انتخاب سفارش موجود #{toPersianDigits(ord.order_number)}
                        {ord.customer_name ? ` · ${ord.customer_name}` : ""}
                      </button>
                    ) : (
                      <Link
                        key={ord.id}
                        href={`${ACCOUNTING_WORKSPACE_HREFS.orders}?order=${ord.id}`}
                        className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-semibold text-foreground hover:bg-muted"
                      >
                        انتخاب سفارش موجود #{toPersianDigits(ord.order_number)}
                        {ord.customer_name ? ` · ${ord.customer_name}` : ""}
                      </Link>
                    ),
                  )}
                </div>
              </div>
            ) : null}
            <label
              className="block text-xs font-semibold text-muted-foreground"
              htmlFor="pos-table-guest-count"
            >
              تعداد مهمان{" "}
              <span className="font-normal text-muted-foreground">(اختیاری)</span>
              <PersianNumberInput
                id="pos-table-guest-count"
                className={
                  inputClass + " mt-1 min-h-11 border-border/80 bg-muted"
                }
                dir="ltr"
                inputMode="numeric"
                value={draftGuestCount}
                onChange={(event) => setDraftGuestCount(event.target.value)}
                placeholder="اختیاری"
              />
            </label>
          </>
        )}

        <DialogFooter>
          <button
            type="button"
            onClick={onCancel}
            className="min-h-11 rounded-lg border border-input px-4 text-sm font-medium"
          >
            انصراف
          </button>
          <button
            type="button"
            disabled={!draftTableId || chosen?.unavailable === true}
            onClick={() =>
              onConfirm(draftTableId, draftGuestCount, { mode: "new" })
            }
            className="min-h-12 rounded-xl bg-amber-500 dark:bg-amber-400 px-4 text-sm font-bold text-amber-950 transition duration-200 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 disabled:opacity-55 motion-reduce:transition-none"
          >
            {intent === "payment"
              ? "ادامه و دریافت وجه"
              : intent === "order"
                ? "ادامه و ثبت سفارش"
                : "ثبت میز"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
