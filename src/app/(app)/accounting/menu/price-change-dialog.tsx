"use client";

/**
 * The dedicated price-change dialog — issue #844's audited price workflow.
 *
 * Selling price is not an ordinary field: this dialog is the only place the
 * menu workspace changes an existing item's price, and it posts to
 * `/api/menu/items/:id/price-change`, which runs the one canonical service
 * (lock → validate → update → append immutable history → audit → commit).
 * `old == new` writes no row.
 *
 * The operator sees the canonical summary before confirming —
 * «۴۰٬۰۰۰ → ۴۵٬۰۰۰ تومان (+۱۲٫۵٪)» — an optional reason lands in the history
 * row, and `source` is decided server-side (`manual`): a body field cannot
 * relabel an edit as an import or a migration.
 */
import { useMemo, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ErrorBox, Field, api, inputClass } from "@/app/dashboard/ui";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { StatusBadge } from "@/app/dashboard/page-chrome";
import { useMoney } from "@/components/money/money-context";
import { priceChangeSummary } from "@/lib/menu-price-sources";
import type { RestaurantMenuItem } from "@/lib/restaurant-menu";
import type { Runner } from "./menu-workspace";

export function PriceChangeDialog({
  item,
  run,
  onClose,
  onNotice,
}: {
  item: RestaurantMenuItem;
  run: Runner;
  onClose: () => void;
  onNotice: (message: string) => void;
}) {
  const money = useMoney();
  const [priceInput, setPriceInput] = useState(() => String(money.toInput(item.price)));
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState("");

  // The dialog instance is reused across items by remounting it from the
  // workspace (keyed by item.id at the call site would be ideal; the state
  // below re-derives from the item identity instead).
  const [seenItem, setSeenItem] = useState(item.id);
  if (seenItem !== item.id) {
    setSeenItem(item.id);
    setPriceInput(String(money.toInput(item.price)));
    setReason("");
    setFormError("");
  }

  const newPrice = money.parse(priceInput);
  const priceValid =
    priceInput.trim() !== "" && Number.isFinite(newPrice) && newPrice >= 0;
  const summary = useMemo(
    () =>
      priceValid
        ? priceChangeSummary(item.price, newPrice, (rial) => money.format(rial, { withUnit: true }))
        : null,
    [priceValid, item.price, newPrice, money],
  );
  const unchanged = priceValid && newPrice === item.price;

  async function confirm() {
    if (!priceValid) {
      setFormError("قیمت جدید را درست وارد کنید.");
      return;
    }
    if (unchanged) {
      setFormError("قیمت جدید با قیمت فعلی یکسان است؛ تغییری ثبت نمی‌شود.");
      return;
    }
    const trimmedReason = reason.trim();
    const result = await run(() =>
      api(`/api/menu/items/${item.id}/price-change`, {
        method: "POST",
        body: JSON.stringify(trimmedReason ? { price: newPrice, reason: trimmedReason } : { price: newPrice }),
      }),
    );
    if (result.ok) {
      onNotice("قیمت به‌روزرسانی شد و در تاریخچه ثبت شد.");
      onClose();
    } else {
      setFormError(result.error ?? "");
    }
  }

  const delta = priceValid ? newPrice - item.price : 0;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>تغییر قیمت «{item.name}»</DialogTitle>
          <DialogDescription>
            این تغییر با دلیل و زمان در «تاریخچه قیمت» ثبت می‌شود؛ سفارش‌های قبلی دست‌نخورده
            می‌مانند.
          </DialogDescription>
        </DialogHeader>

        <ErrorBox>{formError}</ErrorBox>

        <div className="flex items-center justify-between gap-3 rounded-xl border border-border/80 bg-muted/40 px-3 py-2.5">
          <span className="text-sm text-muted-foreground">قیمت فعلی</span>
          <span className="text-sm font-semibold tabular-nums">
            {money.format(item.price, { withUnit: true })}
          </span>
        </div>

        <Field label={`قیمت جدید (${money.unitLabel})`}>
          <PersianNumberInput
            value={priceInput}
            onChange={(event) => setPriceInput(event.target.value)}
            grouping
            inputMode="numeric"
            className={inputClass}
          />
        </Field>

        {summary ? (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-200/70 bg-amber-50/70 px-3 py-2.5 text-sm text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
            <span className="font-semibold tabular-nums">{summary.text}</span>
            {delta !== 0 ? (
              <span
                className={`inline-flex items-center gap-1 text-xs font-medium ${
                  delta > 0 ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"
                }`}
              >
                {delta > 0 ? <ArrowUpIcon className="size-3.5" /> : <ArrowDownIcon className="size-3.5" />}
                {money.format(Math.abs(delta), { withUnit: true })}
              </span>
            ) : (
              <StatusBadge tone="neutral">بدون تغییر</StatusBadge>
            )}
          </div>
        ) : null}

        <Field label="دلیل تغییر (اختیاری)" hint="در ردیف تاریخچهٔ قیمت برای حسابرسی ثبت می‌شود.">
          <input
            className={inputClass}
            value={reason}
            maxLength={300}
            onChange={(event) => setReason(event.target.value)}
            placeholder="مثلاً «گران شدن شیر»"
          />
        </Field>

        <p className="text-xs text-muted-foreground">
          اعمال: هم‌اکنون · ثبت با دسترسی «مدیریت منو»
        </p>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            انصراف
          </Button>
          <Button disabled={!priceValid || unchanged} onClick={() => void confirm()}>
            ثبت تغییر قیمت
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
