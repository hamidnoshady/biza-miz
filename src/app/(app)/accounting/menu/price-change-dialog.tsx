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
 *
 * The cost-plus suggestion lives here too (it used to sit in the retired
 * manager): the breakdown is read through GET (which needs `menu.edit` AND
 * `ledger.view` — the section simply does not render for a role that lacks
 * either), the per-item target margin can be set in place, and «اعمال قیمت
 * پیشنهادی» posts to the dedicated route so the server recomputes the value
 * and records `source = suggested` — the browser never picks the number that
 * gets written.
 */
import { useEffect, useMemo, useState } from "react";
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
import { ErrorBox, Field, SecondaryButton, api, inputClass } from "@/app/dashboard/ui";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { LoadingSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import { priceChangeSummary } from "@/lib/menu-price-sources";
import type { RestaurantMenuItem } from "@/lib/restaurant-menu";
import type { SuggestedPriceBreakdown } from "@/lib/pricing-service";
import type { Runner } from "./menu-workspace";

/** The wire shape GET /api/menu/items/:id/suggested-price returns. */
type SuggestedBreakdown = SuggestedPriceBreakdown;

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
  const [suggestion, setSuggestion] = useState<SuggestedBreakdown | null>(null);
  const [suggestionState, setSuggestionState] = useState<"loading" | "ready" | "hidden">(
    "loading",
  );
  const [marginInput, setMarginInput] = useState(
    item.targetMarginPercent != null ? String(item.targetMarginPercent) : "",
  );
  const [marginError, setMarginError] = useState("");

  // The dialog instance is reused across items by remounting it from the
  // workspace (keyed by item.id at the call site would be ideal; the state
  // below re-derives from the item identity instead).
  const [seenItem, setSeenItem] = useState(item.id);
  if (seenItem !== item.id) {
    setSeenItem(item.id);
    setPriceInput(String(money.toInput(item.price)));
    setReason("");
    setFormError("");
    setMarginError("");
    setMarginInput(item.targetMarginPercent != null ? String(item.targetMarginPercent) : "");
  }

  // The breakdown is financial (recipe cost, overhead, margin), so a missing
  // ledger permission just hides the section instead of erroring at the user.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setSuggestionState("loading");
    void (async () => {
      try {
        const result = await api<{ suggestion?: SuggestedBreakdown }>(
          `/api/menu/items/${item.id}/suggested-price`,
          { signal: controller.signal },
        );
        if (cancelled || result.aborted) return;
        if (result.ok && result.data.suggestion) {
          setSuggestion(result.data.suggestion);
          setSuggestionState("ready");
        } else {
          setSuggestionState("hidden");
        }
      } catch {
        if (!cancelled) setSuggestionState("hidden");
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [item.id, item.price, item.targetMarginPercent]);

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

  /** The per-item target margin feeds the suggestion; save it in place. */
  async function saveMargin() {
    const trimmed = marginInput.trim();
    const value = trimmed === "" ? null : Number(trimmed);
    if (value !== null && (!Number.isFinite(value) || value < 0 || value >= 100)) {
      setMarginError("حاشیه سود باید عددی بین ۰ تا ۱۰۰ باشد.");
      return;
    }
    setMarginError("");
    const result = await run(() =>
      api(`/api/menu/items/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ targetMarginPercent: value }),
      }),
    );
    // The reload refreshes `item`, which re-runs the breakdown effect above.
    if (!result.ok) setFormError(result.error ?? "");
  }

  /**
   * Server-computed apply: the POST recomputes the suggestion and writes it
   * through the canonical service with `source = suggested`.
   */
  async function applySuggested() {
    const result = await run(() =>
      api(`/api/menu/items/${item.id}/suggested-price`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    if (result.ok) {
      onNotice("قیمت پیشنهادی اعمال شد و در تاریخچهٔ قیمت ثبت شد.");
      onClose();
    } else {
      setFormError(result.error ?? "");
    }
  }

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

        {suggestionState === "loading" ? (
          <LoadingSkeleton rows={2} compact label="در حال محاسبهٔ قیمت پیشنهادی" />
        ) : null}
        {suggestionState === "ready" && suggestion ? (
          <section
            aria-label="قیمت پیشنهادی"
            className="space-y-2 rounded-xl border border-border/80 bg-muted/40 p-3"
          >
            <h3 className="text-sm font-semibold text-foreground">قیمت پیشنهادی</h3>
            {!suggestion.hasRecipe ? (
              <p className="text-xs text-muted-foreground">
                دستورالعمل مصرف (رسپی) این آیتم ثبت نشده؛ بهای مواد قابل محاسبه نیست.
              </p>
            ) : (
              <>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
                  <div>
                    <dt className="text-muted-foreground">بهای مواد</dt>
                    <dd className="font-medium tabular-nums">
                      {money.format(suggestion.materialCost)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">سربار</dt>
                    <dd className="font-medium tabular-nums">
                      {suggestion.overheadRatePercent != null
                        ? `${toPersianDigits(Math.round(suggestion.overheadRatePercent))}٪ (${
                            suggestion.overheadSource === "ledger"
                              ? "بر اساس دفتر"
                              : "برآورد دستی"
                          })`
                        : "بدون داده"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">بهای تمام‌شده</dt>
                    <dd className="font-medium tabular-nums">
                      {money.format(suggestion.loadedCost)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">حاشیهٔ سود</dt>
                    <dd className="font-medium tabular-nums">
                      {suggestion.marginPercent != null
                        ? `${toPersianDigits(suggestion.marginPercent)}٪ (${
                            suggestion.marginSource === "item" ? "اختصاصی" : "پیش‌فرض"
                          })`
                        : "تعیین‌نشده"}
                    </dd>
                  </div>
                </dl>

                {suggestion.suggestedPrice != null ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-card px-2.5 py-2">
                    <span className="text-sm font-medium tabular-nums">
                      پیشنهاد: {money.format(suggestion.suggestedPrice, { withUnit: true })}
                    </span>
                    <SecondaryButton
                      onClick={() => void applySuggested()}
                      disabled={suggestion.suggestedPrice === newPrice}
                    >
                      اعمال قیمت پیشنهادی
                    </SecondaryButton>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    برای پیشنهاد قیمت، ابتدا هدف حاشیهٔ سود را برای همین آیتم تعیین کنید.
                  </p>
                )}
              </>
            )}

            <div className="flex items-end gap-2 border-t border-border/60 pt-2">
              <div className="min-w-0 flex-1">
                <Field label="حاشیهٔ سود هدف این آیتم (٪)" hint="خالی یعنی بدون هدف اختصاصی.">
                  <PersianNumberInput
                    value={marginInput}
                    onChange={(event) => setMarginInput(event.target.value)}
                    allowDecimal
                    grouping={false}
                    inputMode="decimal"
                    className={inputClass}
                    placeholder="مثلاً ۶۵"
                  />
                </Field>
              </div>
              <SecondaryButton
                className="mb-4 shrink-0"
                onClick={() => void saveMargin()}
                disabled={
                  marginInput.trim() ===
                  (item.targetMarginPercent != null ? String(item.targetMarginPercent) : "")
                }
              >
                ذخیرهٔ حاشیه
              </SecondaryButton>
            </div>
            {marginError ? <p className="text-xs text-destructive">{marginError}</p> : null}
          </section>
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
