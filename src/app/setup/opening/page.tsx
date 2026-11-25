"use client";

import { SetupDataSkeleton } from "../ui";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { openingAccountLabel, SETUP_OPENING_STATE_MESSAGES, type SetupOpeningState } from "@/lib/setup-opening";
import { FINANCIAL_ACCOUNT_KIND_META, type FinancialAccountKind } from "@/lib/financial-accounts";
import {
  FinancialAccountSheet,
  GlAccountSheet,
  type SetupFinancialAccountLink,
} from "./setup-account-sheets";

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  parentId: string | null;
  parentCode: string | null;
  isActive: boolean;
  hasChildren: boolean;
  financialAccount: { id: string; name: string; kind: string } | null;
}

interface FinancialSummaryRow {
  id: string;
  kind: FinancialAccountKind;
  name: string;
  glAccountId: string;
  glAccountCode: string;
  glAccountName: string;
  balance: string;
  settlementAccountId: string | null;
  settlementAccountName: string | null;
}

interface OpeningResponse {
  state?: SetupOpeningState;
  message?: string;
  accountingEnabled?: boolean;
  chartAccountCount?: number;
  accounts?: Account[];
  eligibleAccounts?: Account[];
  capabilities?: { canManageChart: boolean; canManageFinancialAccounts: boolean; canViewSensitive: boolean };
  openingEntry?: { id: string; entryDate: string; total: string } | null;
  openingSets?: { id: string; fiscalYearLabel: string; effectiveDate: string; status: string; source: string }[];
  inventoryItems?: { id: string; name: string; unit: string; quantity: string }[];
  financialAccounts?: FinancialSummaryRow[];
  financialTotalsByKind?: Record<string, string>;
  financialAccountsUnavailable?: boolean;
  locations?: { id: string; name: string }[];
  baseCurrencyCode?: string;
  enabledCurrencies?: string[];
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

const KIND_ORDER: FinancialAccountKind[] = ["bank", "cash", "petty_cash", "pos_psp"];

const SET_STATUS_LABELS: Record<string, string> = {
  draft: "پیش‌نویس",
  review: "در بررسی",
  approved: "تأییدشده",
  posted: "ثبت‌شده",
  reversed: "برگشت‌خورده",
};

function sumRial(rows: { balance: string }[]): string {
  return rows.reduce((total, row) => total + BigInt(row.balance || "0"), 0n).toString();
}

export default function OpeningStep() {
  const industry = useSetupIndustry();
  // The inventory-count subsection posts to F&B's inventory_items/
  // stock_movements tables (Phase 6) and requires the costing step's
  // setting, which non-food_service businesses never set (costing isn't in
  // their step list) -- so it's hidden rather than left to fail with
  // "costing_not_set". Other trades' stock lives in their catalogue.
  const showInventorySection = industry === "food_service";
  const catalogueHref = showInventorySection ? null : catalogueHrefFor(industry);
  const money = useMoney();
  const [eligibleAccounts, setEligibleAccounts] = useState<Account[]>([]);
  const [openingEntry, setOpeningEntry] = useState<OpeningResponse["openingEntry"]>(null);
  const [openingSets, setOpeningSets] = useState<NonNullable<OpeningResponse["openingSets"]>>([]);
  const [existingInventory, setExistingInventory] = useState<NonNullable<OpeningResponse["inventoryItems"]>>([]);
  const [financialAccounts, setFinancialAccounts] = useState<FinancialSummaryRow[]>([]);
  const [financialTotalsByKind, setFinancialTotalsByKind] = useState<Record<string, string>>({});
  const [financialUnavailable, setFinancialUnavailable] = useState(false);
  const [capabilities, setCapabilities] = useState<NonNullable<OpeningResponse["capabilities"]>>({
    canManageChart: false,
    canManageFinancialAccounts: false,
    canViewSensitive: false,
  });
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const [currencies, setCurrencies] = useState<string[]>(["IRR"]);
  const [baseCurrencyCode, setBaseCurrencyCode] = useState("IRR");
  const [stepState, setStepState] = useState<SetupOpeningState>("ready");
  const [stateMessage, setStateMessage] = useState("");
  const [chartAccountCount, setChartAccountCount] = useState(0);

  const [invRows, setInvRows] = useState<InvRow[]>([{ ...emptyInvRow }]);
  const [balRows, setBalRows] = useState<BalanceRow[]>([{ accountId: "", side: "debit", amount: "" }]);
  const [autoOffset, setAutoOffset] = useState(true);

  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [recovering, setRecovering] = useState(false);
  const [sheet, setSheet] = useState<FinancialAccountKind | null>(null);
  const [glSheet, setGlSheet] = useState(false);
  const [glKind, setGlKind] = useState<FinancialAccountKind>("bank");

  const load = useCallback(async () => {
    setLoadError("");
    const { ok, data, status } = await api<OpeningResponse>("/api/setup/opening");
    if (!ok) {
      // Never render an empty picker for a failed read (issue #1583): the
      // message names what happened and the retry button re-runs this load.
      const state: SetupOpeningState =
        status === 0 || status >= 500
          ? "unavailable"
          : data.error === "forbidden" || status === 403
            ? "permission_denied"
            : (data.state ?? "load_failed");
      setStepState(state);
      setStateMessage(
        data.message ||
          SETUP_OPENING_STATE_MESSAGES[state] ||
          errorMessage(data.error, undefined, status),
      );
      setEligibleAccounts([]);
      setFinancialAccounts([]);
      setLoadError(SETUP_OPENING_STATE_MESSAGES[state] ?? SETUP_OPENING_STATE_MESSAGES.load_failed);
      return;
    }
    setStepState(data.state ?? "ready");
    setStateMessage(data.message ?? "");
    setChartAccountCount(data.chartAccountCount ?? 0);
    setEligibleAccounts(data.eligibleAccounts ?? []);
    setOpeningEntry(data.openingEntry ?? null);
    setOpeningSets(data.openingSets ?? []);
    setExistingInventory(data.inventoryItems ?? []);
    setFinancialAccounts((data.financialAccounts ?? []) as FinancialSummaryRow[]);
    setFinancialTotalsByKind(data.financialTotalsByKind ?? {});
    setFinancialUnavailable(data.financialAccountsUnavailable === true);
    setCapabilities(
      data.capabilities ?? { canManageChart: false, canManageFinancialAccounts: false, canViewSensitive: false },
    );
    setLocations(data.locations ?? []);
    setCurrencies(data.enabledCurrencies?.length ? data.enabledCurrencies : ["IRR"]);
    setBaseCurrencyCode(data.baseCurrencyCode ?? "IRR");
  }, []);

  useEffect(() => {
    load().finally(() => setLoaded(true));
  }, [load]);

  // The server decides eligibility; the client only renders its list.
  const leafAccounts = eligibleAccounts;

  const banks = useMemo<SetupFinancialAccountLink[]>(
    () =>
      financialAccounts
        .filter((account) => account.kind === "bank")
        .map((account) => ({
          id: account.id,
          name: account.name,
          kind: account.kind,
          glAccountId: account.glAccountId,
        })),
    [financialAccounts],
  );

  function parseTomanSafe(s: string): number | null {
    if (!s.trim()) return 0;
    try {
      const v = money.parse(s);
      return v >= 0 ? v : null;
    } catch {
      return null;
    }
  }

  async function recoverChart() {
    setError("");
    setNotice("");
    setRecovering(true);
    try {
      const { ok, data, status } = await api<{ error?: string; created?: number; alreadyPresent?: boolean }>(
        "/api/setup/opening/chart",
        { method: "POST" },
      );
      if (!ok) {
        const map: Record<string, string> = {
          chart_exists: "سرفصل حساب‌ها از قبل وجود دارد و این عملیات آن را بازنویسی نمی‌کند.",
          accounting_not_enabled: "برنامهٔ حسابداری برای این کسب‌وکار فعال نیست.",
          permission_denied: "برای ساخت سرفصل، دسترسی «ویرایش کدینگ حساب‌ها» لازم است.",
        };
        setError(map[data.error ?? ""] ?? errorMessage(data.error, undefined, status));
        return;
      }
      setNotice(
        data.alreadyPresent
          ? "سرفصل حساب‌ها از قبل آماده است."
          : `سرفصل صنف ساخته شد (${toPersianDigits(data.created ?? 0)} حساب).`,
      );
      await load();
    } finally {
      setRecovering(false);
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
      await load();
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
        if (data.error === "opening_set_exists") {
          setError("سند افتتاحیهٔ رسمی این سال قبلاً تأیید یا ثبت شده است؛ از صفحهٔ «مانده‌های افتتاحیه» حسابداری آن را ببینید.");
          return;
        }
        setError(errorMessage(data.error, data.messages, status));
        return;
      }
      setNotice("سند افتتاحیه با موفقیت ثبت شد (بدهکار = بستانکار).");
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <SetupDataSkeleton rows={4} />;

  if (loadError) {
    return (
      <StepShell
        step="opening"
        description="مانده‌های افتتاحیه اختیاری است؛ اگر از صفر شروع می‌کنید می‌توانید این مرحله را رد کنید."
        showSkip
        showNext
      >
        <ErrorBox>{loadError}</ErrorBox>
        <div className="mt-2">
          <SecondaryButton
            onClick={() => {
              setLoaded(false);
              load().finally(() => setLoaded(true));
            }}
          >
            تلاش دوباره
          </SecondaryButton>
        </div>
      </StepShell>
    );
  }

  const accountingReady = stepState !== "accounting_not_enabled" && stepState !== "permission_denied";
  const chartReady = stepState === "ready";

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
      ) : !showInventorySection ? (
        <InfoBox>
          این نوع کسب‌وکار موجودی کالای قابل شمارش ندارد؛ شمارش انبار برای آن معنا ندارد و نمایش داده نمی‌شود.
        </InfoBox>
      ) : null}

      {/* ۱) chart readiness / recovery */}
      <section className="mb-6 rounded-xl border border-border p-4">
        <h2 className="mb-1 font-semibold">سرفصل حساب‌ها و آمادگی دفتر کل</h2>
        {chartReady ? (
          <>
            <p className="text-sm text-muted-foreground">
              {toPersianDigits(chartAccountCount)} سرفصل ثبت شده است و{" "}
              {toPersianDigits(leafAccounts.length)} حساب قابل ثبت برای مانده‌های افتتاحیه آماده است.
            </p>
            {capabilities.canManageChart ? (
              <div className="mt-3">
                <SecondaryButton
                  onClick={() => {
                    setGlKind("bank");
                    setGlSheet(true);
                  }}
                >
                  افزودن حساب تفصیلی
                </SecondaryButton>
              </div>
            ) : null}
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{stateMessage || SETUP_OPENING_STATE_MESSAGES[stepState]}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {stepState === "chart_missing" && capabilities.canManageChart ? (
                <PrimaryButton type="button" onClick={recoverChart} disabled={recovering}>
                  {recovering ? "در حال ساخت…" : "ساخت سرفصل پیشنهادی صنف"}
                </PrimaryButton>
              ) : null}
              {stepState === "no_eligible_leaf" && capabilities.canManageChart ? (
                <PrimaryButton
                  type="button"
                  onClick={() => {
                    setGlKind("bank");
                    setGlSheet(true);
                  }}
                >
                  افزودن حساب تفصیلی
                </PrimaryButton>
              ) : null}
              {!capabilities.canManageChart && stepState !== "accounting_not_enabled" ? (
                <p className="text-xs text-muted-foreground">
                  برای ساخت یا اصلاح سرفصل، دسترسی «ویرایش کدینگ حساب‌ها» لازم است.
                </p>
              ) : null}
            </div>
          </>
        )}
      </section>

      {/* ۲) money containers */}
      {accountingReady && chartReady ? (
        <section className="mb-6 rounded-xl border border-border p-4">
          <h2 className="mb-1 font-semibold">حساب‌های مالی کسب‌وکار</h2>
          <p className="mb-3 text-sm text-muted-foreground">
            بانک، صندوق، تنخواه و پایانه‌ها همین‌جا ثبت می‌شوند؛ هر حساب یک سرفصل اختصاصی در دفتر کل دارد.
          </p>
          {financialUnavailable ? (
            <InfoBox>
              فهرست حساب‌های مالی خوانده نشد. با «تلاش دوباره» بالا دوباره بارگذاری کنید؛ ثبت حساب تازه همچنان ممکن است.
            </InfoBox>
          ) : null}
          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {KIND_ORDER.map((kind) => {
              const rows = financialAccounts.filter((account) => account.kind === kind);
              return (
                <div key={kind} className="rounded-lg border border-border px-3 py-2">
                  <p className="text-xs text-muted-foreground">{FINANCIAL_ACCOUNT_KIND_META[kind].plural}</p>
                  <p className="mt-1 text-sm font-semibold text-foreground">
                    {toPersianDigits(rows.length)} مورد
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {money.formatText(financialTotalsByKind[kind] ?? sumRial(rows), { withUnit: true })}
                  </p>
                </div>
              );
            })}
          </div>
          {capabilities.canManageFinancialAccounts ? (
            <div className="flex flex-wrap gap-2">
              <SecondaryButton onClick={() => setSheet("bank")}>افزودن حساب بانکی</SecondaryButton>
              <SecondaryButton onClick={() => setSheet("cash")}>افزودن صندوق</SecondaryButton>
              <SecondaryButton onClick={() => setSheet("petty_cash")}>افزودن تنخواه</SecondaryButton>
              <SecondaryButton onClick={() => setSheet("pos_psp")}>افزودن دستگاه کارتخوان</SecondaryButton>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              برای ثبت حساب مالی، دسترسی «مدیریت حساب‌های مالی» لازم است.
            </p>
          )}
          {financialAccounts.length > 0 ? (
            <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
              {financialAccounts.map((account) => (
                <li key={account.id}>
                  <span className="font-medium text-foreground">{account.name}</span> —{" "}
                  {FINANCIAL_ACCOUNT_KIND_META[account.kind]?.label ?? account.kind} — سرفصل{" "}
                  {account.glAccountCode} — {account.glAccountName}
                  {account.settlementAccountName ? ` — تسویه به ${account.settlementAccountName}` : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {/* ۳) opening inventory (F&B) */}
      {showInventorySection && accountingReady && chartReady ? (
        <section className="mb-8 rounded-xl border border-border p-4">
          <h2 className="mb-1 font-semibold">شمارش اولیهٔ انبار</h2>
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

      {/* ۴) opening ledger balances */}
      <section className="rounded-xl border border-border p-4">
        <h2 className="mb-1 font-semibold">مانده‌های افتتاحیهٔ دفاتر</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          مانده‌ها به {money.unitLabel}. سند فقط وقتی ثبت می‌شود که بدهکار و بستانکار برابر باشند.
        </p>

        {!accountingReady ? (
          <p className="text-sm text-muted-foreground">{stateMessage || SETUP_OPENING_STATE_MESSAGES[stepState]}</p>
        ) : openingEntry ? (
          <InfoBox>
            سند افتتاحیه قبلاً ثبت شده است (جمع: {money.formatText(openingEntry.total, { withUnit: true })}).
          </InfoBox>
        ) : !chartReady ? (
          <p className="text-sm text-muted-foreground">
            تا سرفصل حساب‌ها آماده نشود، انتخاب حساب ممکن نیست. ابتدا بخش «سرفصل حساب‌ها» را کامل کنید.
          </p>
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
                      ...leafAccounts.map((a) => ({
                        value: a.id,
                        label: openingAccountLabel(a, a.financialAccount?.name),
                      })),
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

            <div className="mt-4 flex flex-wrap gap-2">
              <SecondaryButton onClick={() => setBalRows((rs) => [...rs, { accountId: "", side: "debit", amount: "" }])}>
                افزودن سطر
              </SecondaryButton>
              <PrimaryButton type="button" onClick={submitBalances} disabled={busy}>
                ثبت سند افتتاحیه
              </PrimaryButton>
            </div>
          </>
        )}

        {openingSets.length > 0 ? (
          <div className="mt-4 border-t border-border pt-3">
            <p className="mb-1 text-xs font-medium text-foreground">مانده‌های افتتاحیهٔ رسمی</p>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {openingSets.map((set) => (
                <li key={set.id}>
                  سال {toPersianDigits(Number(set.fiscalYearLabel))} — {SET_STATUS_LABELS[set.status] ?? set.status}
                  {set.source === "carry_forward" ? " (انتقال از سال قبل)" : ""}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <FinancialAccountSheet
        key={sheet ?? "closed"}
        open={sheet !== null}
        kind={sheet ?? "bank"}
        locations={locations}
        currencies={currencies}
        baseCurrencyCode={baseCurrencyCode}
        banks={banks}
        canManageChart={capabilities.canManageChart}
        onClose={() => setSheet(null)}
        onSaved={() => {
          void load();
        }}
        onAddGl={() => {
          setGlKind(sheet ?? "bank");
          setSheet(null);
          setGlSheet(true);
        }}
        onAddBank={() => setSheet("bank")}
      />
      <GlAccountSheet
        open={glSheet}
        kind={glKind}
        onClose={() => setGlSheet(false)}
        onSaved={() => {
          void load();
        }}
      />
    </StepShell>
  );
}
