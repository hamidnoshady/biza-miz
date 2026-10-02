"use client";

/**
 * The Growth app's gift-card section (Phase 36b) — the issue/redeem counter
 * moved out of the old campaigns page into its own screen, because it is its
 * own liability: issuing a card takes the customer's cash and credits «کارت
 * هدیه» (۲۴۲۰); redeeming it debits that liability. Neither rule touches a
 * revenue account — the goods the card later buys are posted by the ordinary
 * sale path, so revenue can never be booked twice.
 */

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useMoney } from "@/components/money/money-context";
import { CardTitle, EmptyState, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import type { GiftCardHistoryEntry } from "@/lib/promotions-service";
import { api, ErrorBox, errorMessageOrRaw, Field, InfoBox, inputClass } from "@/app/dashboard/ui";
import type { GrowthAbilities } from "@/lib/growth-access";

/**
 * Parse a money field the user typed, without letting a malformed string throw
 * out of an async handler (which would leave `busy` stuck true and the buttons
 * disabled forever). Returns `null` when the value cannot be read as a
 * positive integer amount, so the caller can show a clear message instead.
 */
function parsePositiveAmount(money: ReturnType<typeof useMoney>, raw: string): number | null {
  try {
    const rial = money.parse(raw);
    if (!Number.isFinite(rial) || rial <= 0) return null;
    return rial;
  } catch {
    return null;
  }
}

/**
 * Three separate permissions (issue #764): a balance lookup is
 * `gift_cards.view`, issuing creates a liability (`gift_cards.issue`), and
 * spending one is `gift_cards.redeem`. A control is drawn only when its
 * endpoint would accept the click.
 */
export function GiftCardsSection({
  abilities,
}: {
  abilities: Pick<GrowthAbilities, "issueGiftCards" | "redeemGiftCards">;
}) {
  const money = useMoney();
  const [code, setCode] = useState("");
  const [issueValue, setIssueValue] = useState("");
  const [redeemCode, setRedeemCode] = useState("");
  const [redeemValue, setRedeemValue] = useState("");
  // The balance is always paired with the code it was fetched for, so editing
  // the code afterwards can clear a now-stale figure rather than leaving the
  // previous card's balance attached to a different code.
  const [balance, setBalance] = useState<{ code: string; value: number } | null>(null);
  /** The looked-up card's movements, paired with its code like the balance is. */
  const [history, setHistory] = useState<{ code: string; entries: GiftCardHistoryEntry[] } | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [busy, setBusy] = useState(false);

  const canIssue = code.trim().length > 0 && issueValue.trim().length > 0;
  const canRedeem = redeemCode.trim().length > 0 && redeemValue.trim().length > 0;

  async function issue() {
    if (!canIssue || busy) return;
    const initialValue = parsePositiveAmount(money, issueValue);
    if (initialValue == null) {
      setDone("");
      setError("ارزش کارت باید یک عدد مثبت باشد.");
      return;
    }
    setBusy(true);
    setError("");
    setDone("");
    const { ok, data } = await api<{ error?: string; message?: string }>("/api/promotions/gift-cards", {
      method: "POST",
      body: JSON.stringify({ code: code.trim(), initialValue }),
    });
    setBusy(false);
    if (!ok) setError(data.message ?? (errorMessageOrRaw(data.error) || "صدور کارت هدیه ناموفق بود."));
    else {
      setCode("");
      setIssueValue("");
      setDone("کارت هدیه صادر شد (بدهی ۲۴۲۰).");
    }
  }

  async function check() {
    const trimmed = redeemCode.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError("");
    setDone("");
    const { ok, status, data } = await api<{
      error?: string;
      balance?: number;
      isActive?: boolean;
      history?: GiftCardHistoryEntry[];
    }>(
      `/api/promotions/gift-cards?code=${encodeURIComponent(trimmed)}`,
    );
    setBusy(false);
    if (ok && typeof data.balance === "number") {
      setBalance({ code: trimmed, value: data.balance });
      setHistory({ code: trimmed, entries: data.history ?? [] });
      if (data.isActive === false) setDone("این کارت غیرفعال است.");
    } else {
      setBalance(null);
      setHistory(null);
      setError(
        status === 404
          ? "کارت هدیه‌ای با این کد پیدا نشد."
          : errorMessageOrRaw(data.error) || "استعلام ماندهٔ کارت ناموفق بود.",
      );
    }
  }

  async function redeem() {
    if (!canRedeem || busy) return;
    const amount = parsePositiveAmount(money, redeemValue);
    if (amount == null) {
      setDone("");
      setError("مبلغ مصرف باید یک عدد مثبت باشد.");
      return;
    }
    const trimmed = redeemCode.trim();
    setBusy(true);
    setError("");
    setDone("");
    const { ok, data } = await api<{ error?: string; message?: string; balance?: number }>(
      "/api/promotions/gift-cards/redeem",
      {
        method: "POST",
        body: JSON.stringify({ code: trimmed, amount }),
      },
    );
    setBusy(false);
    if (!ok) setError(data.message ?? (errorMessageOrRaw(data.error) || "مصرف کارت هدیه ناموفق بود."));
    else {
      setBalance(typeof data.balance === "number" ? { code: trimmed, value: data.balance } : null);
      // The history shown is now one movement short; re-read it (without the
      // lookup's busy guard or message reset, which would hide «مصرف شد»).
      void api<{ history?: GiftCardHistoryEntry[] }>(`/api/promotions/gift-cards?code=${encodeURIComponent(trimmed)}`).then(
        ({ ok: read, data: card }) => {
          if (read && card.history) setHistory({ code: trimmed, entries: card.history });
        },
      );
      setRedeemValue("");
      setDone("کارت هدیه مصرف شد.");
    }
  }

  return (
    <div className="space-y-4 sm:space-y-5">
      <ErrorBox>{error}</ErrorBox>
      {done ? <InfoBox>{done}</InfoBox> : null}

      <div className={abilities.issueGiftCards ? "grid gap-4 lg:grid-cols-2" : "grid gap-4"}>
        {abilities.issueGiftCards ? (
        <SectionCard
          title={<CardTitle eyebrow="اعتبار هدیه" title="صدور کارت هدیه" />}
          bodyClassName="space-y-3 p-4 sm:p-5"
        >
          <form
            className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_1fr_auto] sm:gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void issue();
            }}
          >
            <Field label="کد کارت جدید">
              <input
                className={inputClass}
                dir="ltr"
                value={code}
                autoComplete="off"
                onChange={(e) => setCode(e.target.value)}
              />
            </Field>
            <Field label={`ارزش (${money.unitLabel})`}>
              <PersianNumberInput
                inputMode="numeric"
                allowNegative={false}
                className={inputClass}
                dir="ltr"
                value={issueValue}
                onChange={(e) => setIssueValue(e.target.value)}
              />
            </Field>
            <Button type="submit" disabled={busy || !canIssue} className="min-h-11 w-full sm:w-auto">
              صدور
            </Button>
          </form>
          <p className="text-xs leading-5 text-muted-foreground">
            پول نقد بابت کارت وارد صندوق می‌شود و حساب ۲۴۲۰ بستانکار می‌گردد؛ درآمد همان‌جا ثبت می‌شود که مشتری با
            کارت خرید می‌کند — نه این‌جا.
          </p>
        </SectionCard>
        ) : null}

        <SectionCard
          title={
            <CardTitle
              eyebrow="استعلام و استفاده"
              title={abilities.redeemGiftCards ? "مصرف و مانده" : "استعلام ماندهٔ کارت"}
            />
          }
          bodyClassName="space-y-3 p-4 sm:p-5"
        >
          <div
            className={
              abilities.redeemGiftCards
                ? "grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_1fr_auto] sm:gap-2"
                : "grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_auto] sm:gap-2"
            }
          >
            <Field label="کد کارت">
              <input
                className={inputClass}
                dir="ltr"
                value={redeemCode}
                autoComplete="off"
                onChange={(e) => {
                  setRedeemCode(e.target.value);
                  // A shown balance belongs to the code it was fetched for;
                  // once that code changes, drop it so it can't mislead.
                  setBalance((prev) => (prev && prev.code === e.target.value.trim() ? prev : null));
                  setHistory((prev) => (prev && prev.code === e.target.value.trim() ? prev : null));
                }}
              />
            </Field>
            {abilities.redeemGiftCards ? (
              <Field label={`مبلغ مصرف (${money.unitLabel})`}>
                <PersianNumberInput
                  inputMode="numeric"
                  allowNegative={false}
                  className={inputClass}
                  dir="ltr"
                  value={redeemValue}
                  onChange={(e) => setRedeemValue(e.target.value)}
                />
              </Field>
            ) : null}
            <Button
              type="button"
              variant="outline"
              disabled={busy || !redeemCode.trim()}
              onClick={() => void check()}
              className="min-h-11 w-full sm:w-auto"
            >
              مانده
            </Button>
          </div>
          {abilities.redeemGiftCards ? (
            <Button
              type="button"
              disabled={busy || !canRedeem}
              onClick={() => void redeem()}
              className="min-h-11 w-full"
            >
              مصرف کارت
            </Button>
          ) : null}
          {balance && balance.code === redeemCode.trim() ? (
            <p aria-live="polite" className="rounded-lg bg-muted/50 px-3 py-2 text-sm text-foreground">
              ماندهٔ کارت <span dir="ltr" className="font-medium">{balance.code}</span>:{" "}
              <span className="font-semibold">{money.format(balance.value)}</span>
            </p>
          ) : null}
          {history && history.code === redeemCode.trim() ? (
            history.entries.length === 0 ? (
              <EmptyState>برای این کارت گردشی ثبت نشده است.</EmptyState>
            ) : (
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">گردش کارت</p>
                <ul className="divide-y divide-border/80 rounded-lg border border-border/80 text-sm">
                  {history.entries.map((entry, index) => (
                    <li key={`${entry.at}-${index}`} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                      <div className="min-w-0">
                        <StatusBadge tone={entry.kind === "issued" ? "positive" : "neutral"}>
                          {entry.kind === "issued" ? "صدور" : "مصرف"}
                        </StatusBadge>
                        <span className="ms-2 text-xs text-muted-foreground">
                          {toPersianDigits(formatJalali(entry.at))}
                          {entry.byName ? ` · ${entry.byName}` : ""}
                        </span>
                      </div>
                      <span className="shrink-0 font-semibold">
                        {entry.kind === "issued" ? "+" : "−"}
                        {money.format(entry.amountRial)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )
          ) : null}
          <p className="text-xs leading-5 text-muted-foreground">
            کارت هدیه یک بدهی واقعی است؛ صدور آن را بستانکار و مصرف آن را بدهکار می‌کند و هرگز درآمد را دوباره ثبت
            نمی‌کند. ماندهٔ کل کارت‌ها در میز کار رشد، از دفتر کل بازسازی می‌شود.
          </p>
        </SectionCard>
      </div>
    </div>
  );
}
