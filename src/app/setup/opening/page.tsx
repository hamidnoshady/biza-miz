"use client";

import { SetupDataSkeleton } from "../ui";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useState } from "react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import {
  api,
  ErrorBox,
  errorMessage,
  InfoBox,
  inputClass,
  PrimaryButton,
  SecondaryButton,
  StepShell,
} from "../ui";
import { useSetupIndustry } from "../industry-context";
import Link from "next/link";
import { catalogueHrefFor } from "@/lib/wizard-steps";

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  children: string | number;
}

interface OpeningResponse {
  accounts: Account[];
  openingEntry: { id: string; entry_date: string; total: string } | null;
  inventoryItems: { id: string; name: string; unit: string; quantity: string }[];
  error?: string;
}

interface InvRow {
  name: string;
  unit: string;
  quantity: string;
  unitCost: string; // Toman input
}

interface BalanceRow {
  accountId: string;
  side: "debit" | "credit";
  amount: string; // Toman input
}

const emptyInvRow: InvRow = { name: "", unit: "kg", quantity: "", unitCost: "" };

export default function OpeningStep() {
  const industry = useSetupIndustry();
  // The inventory-count subsection posts to F&B's inventory_items/
  // stock_movements tables (Phase 6) and requires the costing step's
  // setting, which non-food_service businesses never set (costing isn't in
  // their step list) -- so it's hidden rather than left to fail with
  // "costing_not_set". Jewelry's own stock is entered through
  // /dashboard/jewelry, not here.
  const showInventorySection = industry === "food_service";
  // Non-F&B trades keep their stock in the products workspace / their trade's
  // items page (see catalogueHrefFor), reachable from here so the step still
  // tells the owner where inventory goes instead of silently dropping it.
  const catalogueHref = showInventorySection ? null : catalogueHrefFor(industry);
  const money = useMoney();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [openingEntry, setOpeningEntry] = useState<OpeningResponse["openingEntry"]>(null);
  const [existingInventory, setExistingInventory] = useState<OpeningResponse["inventoryItems"]>([]);

  const [invRows, setInvRows] = useState<InvRow[]>([{ ...emptyInvRow }]);
  const [balRows, setBalRows] = useState<BalanceRow[]>([{ accountId: "", side: "debit", amount: "" }]);
  const [autoOffset, setAutoOffset] = useState(true);

  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(() => {
    api<OpeningResponse>("/api/setup/opening").then(({ data }) => {
      if (data.accounts) setAccounts(data.accounts);
      setOpeningEntry(data.openingEntry ?? null);
      setExistingInventory(data.inventoryItems ?? []);
    }).finally(() => setLoaded(true));
  }, []);
  useEffect(load, [load]);

  // Leaf accounts only — parents are grouping rows, not posting targets.
  const leafAccounts = accounts.filter((a) => Number(a.children) === 0);

  function parseTomanSafe(s: string): number | null {
    if (!s.trim()) return 0;
    try {
      const v = money.parse(s);
      return v >= 0 ? v : null;
    } catch {
      return null;
    }
  }

  async function submitInventory() {
    setError("");
    setNotice("");
    const items = [];
    for (const r of invRows) {
      if (!r.name.trim()) continue;
      const quantity = Number(r.quantity);
      const unitCost = parseTomanSafe(r.unitCost);
      if (!Number.isFinite(quantity) || quantity <= 0 || unitCost === null) {
        return setError(`مقدار یا بهای «${r.name}» معتبر نیست.`);
      }
      items.push({ name: r.name, unit: r.unit, quantity, unitCost });
    }
    if (items.length === 0) return setError("حداقل یک قلم با نام و مقدار وارد کنید.");
    setBusy(true);
    try {
      const { ok, data, status } = await api<{ error?: string; totalValue?: number }>("/api/setup/opening", {
        method: "POST",
        body: JSON.stringify({ inventory: { items } }),
      });
      if (!ok) {
        setError(errorMessage(data.error, undefined, status));
        return;
      }
      setNotice(`شمارش ثبت شد — ارزش کل: ${money.format(data.totalValue ?? 0)}.`);
      setInvRows([{ ...emptyInvRow }]);
      load();
    } finally {
      setBusy(false);
    }
  }

  const balTotals = balRows.reduce(
    (acc, r) => {
      const v = parseTomanSafe(r.amount) ?? 0;
      if (r.side === "debit") acc.debit += v;
      else acc.credit += v;
      return acc;
    },
    { debit: 0, credit: 0 },
  );

  async function submitBalances() {
    setError("");
    setNotice("");
    const lines = [];
    for (const r of balRows) {
      const amount = parseTomanSafe(r.amount);
      if (amount === null) return setError("یکی از مبلغ‌ها معتبر نیست.");
      if (!r.accountId || amount === 0) continue;
      lines.push({
        accountId: r.accountId,
        debit: r.side === "debit" ? amount : 0,
        credit: r.side === "credit" ? amount : 0,
      });
    }
    if (lines.length === 0) return setError("حداقل یک سطر با حساب و مبلغ لازم است.");
    setBusy(true);
    try {
      const { ok, data, status } = await api<{ error?: string; messages?: string[] }>("/api/setup/opening", {
        method: "POST",
        body: JSON.stringify({ balances: { lines, autoOffset } }),
      });
      if (!ok) {
        setError(errorMessage(data.error, data.messages, status));
        return;
      }
      setNotice("سند افتتاحیه با موفقیت ثبت شد (بدهکار = بستانکار).");
      load();
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <SetupDataSkeleton rows={4} />;

  return (
    <StepShell
      step="opening"
      description={
        showInventorySection
          ? "اگر موجودی و مانده‌حساب دارید، این‌جا ثبت کنید تا دفترها از روز اول درست باشند؛ اگر از صفر شروع می‌کنید این مرحله را رد کنید."
          : "اگر مانده‌حساب دارید، این‌جا ثبت کنید تا دفترها از روز اول درست باشند؛ موجودی کالا در پنل کالاهای همین صنف ثبت می‌شود. اگر از صفر شروع می‌کنید این مرحله را رد کنید."
      }
      showSkip
      showNext
    >
      <ErrorBox>{error}</ErrorBox>
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      {catalogueHref ? (
        <InfoBox>
          موجودی کالا این‌جا ثبت نمی‌شود — کالاها و موجودی را از{" "}
          <Link className="font-semibold underline" href={catalogueHref}>
            {industry === "jewelry" || industry === "watch" ? "صفحهٔ کالاهای همین صنف" : "پنل محصولات"}
          </Link>{" "}
          وارد کنید.
        </InfoBox>
      ) : null}

      {showInventorySection ? (
        <section className="mb-8 rounded-xl border border-border p-4">
          <h2 className="mb-1 font-semibold">۱) شمارش اولیهٔ انبار</h2>
          <p className="mb-3 text-sm text-muted-foreground">
            هر قلم با مقدار شمارش‌شده و بهای هر واحد ({money.unitLabel}). با اولین ثبت، روش قیمت‌گذاری قفل می‌شود.
          </p>
          {existingInventory.length > 0 ? (
            <p className="mb-3 text-xs text-muted-foreground">
              اقلام ثبت‌شده: {existingInventory.map((i) => `${i.name} (${toPersianDigits(Number(i.quantity))} ${i.unit})`).join("، ")}
            </p>
          ) : null}
          <div className="space-y-2">
            {invRows.map((r, i) => (
              <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <input
                  className={inputClass}
                  placeholder="نام قلم (مثلاً قهوه)"
                  value={r.name}
                  onChange={(e) => setInvRows((rs) => rs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                />
                <SearchableSelect
                  className={inputClass}
                  value={r.unit}
                  onChange={(value) => setInvRows((rs) => rs.map((x, j) => (j === i ? { ...x, unit: value } : x)))}
                  ariaLabel="واحد"
                  options={[
                    { value: "kg", label: "کیلوگرم" },
                    { value: "g", label: "گرم" },
                    { value: "l", label: "لیتر" },
                    { value: "ml", label: "میلی‌لیتر" },
                    { value: "unit", label: "عدد" },
                  ]}
                />
                <PersianNumberInput
                  className={inputClass}
                  dir="ltr"
                  inputMode="decimal"
                  placeholder="مقدار"
                  value={r.quantity}
                  onChange={(e) => setInvRows((rs) => rs.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))}
                />
                <PersianNumberInput
                  className={inputClass}
                  dir="ltr"
                  inputMode="numeric"
                  placeholder={`بهای واحد (${money.unitLabel})`}
                  value={r.unitCost}
                  onChange={(e) => setInvRows((rs) => rs.map((x, j) => (j === i ? { ...x, unitCost: e.target.value } : x)))}
                />
                <button
                  type="button"
                  className="text-sm text-muted-foreground hover:text-destructive"
                  onClick={() => setInvRows((rs) => rs.filter((_, j) => j !== i))}
                >
                  حذف
                </button>
              </div>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <SecondaryButton onClick={() => setInvRows((rs) => [...rs, { ...emptyInvRow }])}>
              افزودن قلم
            </SecondaryButton>
            <PrimaryButton type="button" onClick={submitInventory} disabled={busy}>
              ثبت شمارش
            </PrimaryButton>
          </div>
        </section>
      ) : null}

      <section className="rounded-xl border border-border p-4">
        <h2 className="mb-1 font-semibold">
          {showInventorySection ? "۲) مانده‌های افتتاحیهٔ دفاتر" : "مانده‌های افتتاحیهٔ دفاتر"}
        </h2>
        <p className="mb-3 text-sm text-muted-foreground">
          مانده‌ها به تومان. سند فقط وقتی ثبت می‌شود که بدهکار و بستانکار برابر باشند.
        </p>

        {openingEntry ? (
          <InfoBox>
            سند افتتاحیه قبلاً ثبت شده است (جمع: {money.format(Number(openingEntry.total))}).
          </InfoBox>
        ) : (
          <>
            <div className="space-y-2">
              {balRows.map((r, i) => (
                <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <SearchableSelect
                    className={inputClass}
                    value={r.accountId}
                    onChange={(value) => setBalRows((rs) => rs.map((x, j) => (j === i ? { ...x, accountId: value } : x)))}
                    ariaLabel="حساب"
                    options={[
                      { value: "", label: "حساب…" },
                      ...leafAccounts.map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` })),
                    ]}
                  />
                  <SearchableSelect
                    className={inputClass}
                    value={r.side}
                    onChange={(value) =>
                      setBalRows((rs) => rs.map((x, j) => (j === i ? { ...x, side: value as "debit" | "credit" } : x)))
                    }
                    ariaLabel="طرف حساب"
                    options={[
                      { value: "debit", label: "بدهکار" },
                      { value: "credit", label: "بستانکار" },
                    ]}
                  />
                  <PersianNumberInput
                    className={inputClass}
                    dir="ltr"
                    inputMode="numeric"
                    placeholder={`مبلغ (${money.unitLabel})`}
                    value={r.amount}
                    onChange={(e) => setBalRows((rs) => rs.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                  />
                  <button
                    type="button"
                    className="text-sm text-muted-foreground hover:text-destructive"
                    onClick={() => setBalRows((rs) => rs.filter((_, j) => j !== i))}
                  >
                    حذف
                  </button>
                </div>
              ))}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
              <span>
                جمع بدهکار: <b>{money.format(balTotals.debit)}</b>
              </span>
              <span>
                جمع بستانکار: <b>{money.format(balTotals.credit)}</b>
              </span>
              <span className={balTotals.debit === balTotals.credit ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}>
                {balTotals.debit === balTotals.credit
                  ? "تراز است ✓"
                  : `اختلاف: ${money.format(Math.abs(balTotals.debit - balTotals.credit))}`}
              </span>
            </div>

            <label className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
              <input type="checkbox" checked={autoOffset} onChange={(e) => setAutoOffset(e.target.checked)} />
              اختلاف به‌طور خودکار به حساب «تراز افتتاحیه» (کد ۳۹۰۰) منظور شود
            </label>

            <div className="mt-4 flex gap-2">
              <SecondaryButton onClick={() => setBalRows((rs) => [...rs, { accountId: "", side: "debit", amount: "" }])}>
                افزودن سطر
              </SecondaryButton>
              <PrimaryButton type="button" onClick={submitBalances} disabled={busy}>
                ثبت سند افتتاحیه
              </PrimaryButton>
            </div>
          </>
        )}
      </section>
    </StepShell>
  );
}
