"use client";

/**
 * Growth → loyalty and store credit. The panel is deliberately split between
 * programme configuration (owner/manager) and customer lookup (also cashier):
 * a cashier can never be offered a button that the API will only reject.
 */

import { CheckIcon, PencilIcon, RotateCcwIcon } from "lucide-react";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { formatJalali } from "@/lib/jalali";
import {
  CardTitle,
  EmptyState,
  LoadingSkeleton,
  SectionCard,
  SectionCardSkeleton,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import { api, ErrorBox, errorMessage, Field, InfoBox, inputClass } from "@/app/dashboard/ui";
import type { GrowthAbilities } from "@/lib/growth-access";

interface Program {
  id: string;
  name: string;
  earnPointsPer100000: number;
  pointValueRial: number;
  pointsExpiryDays: number | null;
  isActive: boolean;
  isDefault: boolean;
}

interface Customer {
  id: string;
  name: string;
  phone: string | null;
}

interface RepurchaseRow {
  customerId: string;
  customerName: string;
  productId: string;
  productName: string;
  predictedDate: string;
  avgIntervalDays: number;
}

const CUSTOMER_SEARCH_DELAY_MS = 180;

/**
 * Four acts, four permissions (issue #764): configuring a program
 * (`loyalty.manage`), spending points (`loyalty.redeem`), creating store
 * credit (`store_credit.issue`) and paying it out (`store_credit.payout`).
 * Each control is drawn only for the member its endpoint would accept.
 */
export function LoyaltySection({
  abilities,
}: {
  abilities: Pick<GrowthAbilities, "manageLoyaltyPrograms" | "redeemPoints" | "issueStoreCredit" | "payOutStoreCredit">;
}) {
  const canManage = abilities.manageLoyaltyPrograms;
  const [programs, setPrograms] = useState<Program[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | undefined>();
  const selectedCustomerRef = useRef<Customer | undefined>(undefined);
  const [customersLoading, setCustomersLoading] = useState(false);
  const customerSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const customerSearchAbort = useRef<AbortController | null>(null);
  const customerSearchVersion = useRef(0);
  const [balance, setBalance] = useState<{ points: number; storeCredit: number } | null>(null);
  const [balanceLoaded, setBalanceLoaded] = useState(true);
  const [balanceError, setBalanceError] = useState("");
  const [due, setDue] = useState<RepurchaseRow[]>([]);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    selectedCustomerRef.current = selectedCustomer;
  }, [selectedCustomer]);

  const load = useCallback(async () => {
    const [programResult, customerResult, repurchaseResult] = await Promise.all([
      api<{ programs?: Program[] }>("/api/loyalty/programs"),
      // Do not load a silent, arbitrary first 500 customers. The combobox uses
      // this small recent seed then asks the server as the operator types.
      api<{ customers?: Customer[] }>("/api/parties?roles=Customer&limit=20"),
      api<{ customers?: RepurchaseRow[] }>("/api/loyalty/repurchase"),
    ]);
    const failures: string[] = [];
    if (programResult.ok) setPrograms(programResult.data.programs ?? []);
    else failures.push("برنامه‌های وفاداری");
    if (customerResult.ok) setCustomers(customerResult.data.customers ?? []);
    else failures.push("فهرست مشتریان");
    if (repurchaseResult.ok) setDue(repurchaseResult.data.customers ?? []);
    else failures.push("فهرست خرید مجدد");
    if (failures.length > 0) {
      setError(`بارگذاری ${failures.join("، ")} ناموفق بود. دوباره تلاش کنید.`);
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () => () => {
      if (customerSearchTimer.current) clearTimeout(customerSearchTimer.current);
      customerSearchAbort.current?.abort();
    },
    [],
  );

  const searchCustomers = useCallback((term: string) => {
    if (customerSearchTimer.current) clearTimeout(customerSearchTimer.current);
    customerSearchAbort.current?.abort();
    const version = ++customerSearchVersion.current;
    customerSearchTimer.current = setTimeout(() => {
      const controller = new AbortController();
      customerSearchAbort.current = controller;
      setCustomersLoading(true);
      void api<{ customers?: Customer[] }>(
        `/api/parties?roles=Customer&limit=50&q=${encodeURIComponent(term.trim())}`,
        { signal: controller.signal },
      ).then(({ ok, data, aborted }) => {
        if (version !== customerSearchVersion.current || aborted) return;
        if (!ok) {
          setError("جست‌وجوی مشتریان ناموفق بود. دوباره تلاش کنید.");
          return;
        }
        const selected = selectedCustomerRef.current;
        const results = data.customers ?? [];
        setCustomers(selected && !results.some((customer) => customer.id === selected.id) ? [selected, ...results] : results);
      }).finally(() => {
        if (version === customerSearchVersion.current) setCustomersLoading(false);
      });
    }, CUSTOMER_SEARCH_DELAY_MS);
  }, []);

  useEffect(() => {
    setBalance(null);
    setBalanceError("");
    if (!customerId) {
      setBalanceLoaded(true);
      return;
    }
    let cancelled = false;
    setBalanceLoaded(false);
    void api<{ points: number; storeCredit: number; error?: string }>(`/api/loyalty/customers/${customerId}`)
      .then(({ ok, data, aborted }) => {
        if (cancelled || aborted) return;
        if (ok) setBalance(data);
        else setBalanceError(errorMessage(data.error));
      })
      .finally(() => {
        if (!cancelled) setBalanceLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [customerId]);

  function selectCustomer(id: string) {
    setCustomerId(id);
    setSelectedCustomer(id ? customers.find((customer) => customer.id === id) : undefined);
  }

  if (!loaded) {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCardSkeleton rows={4} />
        <SectionCardSkeleton rows={4} />
      </div>
    );
  }

  const activeProgram = programs.find((program) => program.isActive && program.isDefault) ?? null;

  return (
    <div className="space-y-4 sm:space-y-5">
      <ErrorBox>{error}</ErrorBox>
      {done ? <InfoBox>{done}</InfoBox> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <ProgramsPanel
          programs={programs}
          canManage={canManage}
          onSaved={(message) => {
            setDone(message);
            void load();
          }}
          onError={setError}
        />
        <CustomerPanel
          customers={customers}
          customer={selectedCustomer}
          customerId={customerId}
          onSelectCustomer={selectCustomer}
          onCustomerQuery={searchCustomers}
          customersLoading={customersLoading}
          balance={balance}
          balanceLoaded={balanceLoaded}
          balanceError={balanceError}
          abilities={abilities}
          canRedeem={Boolean(activeProgram)}
          onChanged={(message) => {
            setDone(message);
            setCustomerId("");
            setSelectedCustomer(undefined);
            void load();
          }}
          onError={setError}
        />
      </div>

      <SectionCard
        title={<CardTitle eyebrow="بازگشت مشتری" title="مشتریان آمادهٔ خرید مجدد" />}
        description="پیش‌بینی از تاریخچهٔ خرید همان مشتری در شعبهٔ فعال؛ موعد گذشته یعنی زمان تماس یا پیام"
      >
        {due.length === 0 ? (
          <EmptyState>هنوز مشتری‌ای در موعد خرید مجدد نیست.</EmptyState>
        ) : (
          <ul className="divide-y divide-border/80 text-sm">
            {due.map((row) => (
              <li key={`${row.customerId}-${row.productId}`} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <div className="min-w-0">
                  <span className="font-medium text-foreground">{row.customerName}</span>
                  <span className="me-2 text-xs text-muted-foreground">{row.productName}</span>
                  <span className="me-2 text-xs text-muted-foreground">
                    چرخهٔ میانگین {formatPersianNumber(row.avgIntervalDays)} روز
                  </span>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  موعد {toPersianDigits(formatJalali(row.predictedDate))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

function ProgramsPanel({
  programs,
  canManage,
  onSaved,
  onError,
}: {
  programs: Program[];
  canManage: boolean;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}) {
  const money = useMoney();
  const [editing, setEditing] = useState<Program | null>(null);
  const [name, setName] = useState("");
  const [earn, setEarn] = useState("1");
  const [value, setValue] = useState(() => String(money.toInput(1000)));
  const [expiry, setExpiry] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [isDefault, setIsDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const spendUnit = money.format(100_000);

  function resetForm() {
    setEditing(null);
    setName("");
    setEarn("1");
    setValue(String(money.toInput(1000)));
    setExpiry("");
    setIsActive(true);
    setIsDefault(false);
  }

  function startEdit(program: Program) {
    setEditing(program);
    setName(program.name);
    setEarn(String(program.earnPointsPer100000));
    setValue(String(money.toInput(program.pointValueRial)));
    setExpiry(program.pointsExpiryDays === null ? "" : String(program.pointsExpiryDays));
    setIsActive(program.isActive);
    setIsDefault(program.isDefault);
  }

  async function save(input: Record<string, unknown>, successMessage: string) {
    setBusy(true);
    onError("");
    const { ok, data } = await api<{ error?: string; message?: string }>("/api/loyalty/programs", {
      method: "POST",
      body: JSON.stringify(input),
    });
    setBusy(false);
    if (!ok) {
      onError(data.message ?? errorMessage(data.error) ?? "ذخیرهٔ برنامه ناموفق بود.");
      return false;
    }
    onSaved(successMessage);
    return true;
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const earnPointsPer100000 = Number(earn);
    const inputValue = Number(value);
    let pointValueRial: number;
    try {
      pointValueRial = money.fromInput(inputValue);
    } catch {
      onError("ارزش هر امتیاز معتبر نیست.");
      return;
    }
    const pointsExpiryDays = expiry.trim() ? Number(expiry) : null;
    if (!name.trim() || !Number.isSafeInteger(earnPointsPer100000) || earnPointsPer100000 < 0) {
      onError("نرخ کسب امتیاز باید عدد صحیح نامنفی باشد.");
      return;
    }
    if (!Number.isSafeInteger(pointValueRial) || pointValueRial <= 0) {
      onError("ارزش هر امتیاز باید مبلغ صحیح و مثبت باشد.");
      return;
    }
    if (pointsExpiryDays !== null && (!Number.isSafeInteger(pointsExpiryDays) || pointsExpiryDays <= 0)) {
      onError("انقضای امتیاز باید عدد صحیح مثبت باشد یا خالی بماند.");
      return;
    }
    if (isDefault && !isActive) {
      onError("برنامهٔ پیش‌فرض باید فعال باشد.");
      return;
    }
    const saved = await save(
      {
        name: name.trim(),
        earnPointsPer100000,
        pointValueRial,
        pointsExpiryDays,
        isActive,
        // First active programme is selected automatically as a safety net.
        isDefault: isDefault || (!editing && isActive && !programs.some((program) => program.isActive && program.isDefault)),
      },
      editing ? "تغییرات برنامهٔ وفاداری ذخیره شد." : "برنامهٔ وفاداری ذخیره شد.",
    );
    if (saved) resetForm();
  }

  return (
    <SectionCard
      title={<CardTitle eyebrow="طرح‌های امتیازدهی" title="برنامهٔ وفاداری" />}
      description={canManage ? "نرخ کسب، ارزش بازخرید و انقضای امتیازها را اینجا مدیریت کنید." : "تنظیم برنامه‌ها فقط برای مدیر و مالک مجاز است."}
      bodyClassName="space-y-4 p-4 sm:p-5"
    >
      {programs.length === 0 ? (
        <EmptyState>هنوز برنامه‌ای تعریف نشده است.</EmptyState>
      ) : (
        <ul className="divide-y divide-border/80 text-sm">
          {programs.map((program) => (
            <li key={program.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium text-foreground">{program.name}</span>
                  {program.isDefault ? <StatusBadge tone="active">پیش‌فرض</StatusBadge> : null}
                  {!program.isActive ? <StatusBadge tone="neutral">غیرفعال</StatusBadge> : null}
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {formatPersianNumber(program.earnPointsPer100000)} امتیاز به‌ازای هر {spendUnit} · هر امتیاز {money.format(program.pointValueRial)}
                  {program.pointsExpiryDays === null ? " · بدون انقضا" : ` · انقضا پس از ${formatPersianNumber(program.pointsExpiryDays)} روز`}
                </p>
              </div>
              {canManage ? (
                <div className="flex shrink-0 flex-wrap gap-2">
                  {!program.isDefault && program.isActive ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={busy}
                      onClick={() => void save({ ...program, isDefault: true }, `«${program.name}» برنامهٔ پیش‌فرض شد.`)}
                    >
                      <CheckIcon aria-hidden="true" className="size-3.5" />
                      پیش‌فرض
                    </Button>
                  ) : null}
                  <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => startEdit(program)}>
                    <PencilIcon aria-hidden="true" className="size-3.5" />
                    ویرایش
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canManage ? (
        <form onSubmit={submit} className="border-t border-border/80 pt-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">{editing ? `ویرایش «${editing.name}»` : "افزودن برنامه"}</h3>
            {editing ? (
              <Button type="button" variant="ghost" size="xs" onClick={resetForm} disabled={busy}>
                <RotateCcwIcon aria-hidden="true" className="size-3.5" />
                انصراف
              </Button>
            ) : null}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="sm:col-span-3">
              <Field label="نام برنامه">
                <input className={inputClass} value={name} maxLength={120} onChange={(event) => setName(event.target.value)} required />
              </Field>
            </div>
            <Field label={`امتیاز به‌ازای هر ${spendUnit}`}>
              <PersianNumberInput
                inputMode="numeric"
                allowDecimal={false}
                allowNegative={false}
                className={inputClass}
                dir="ltr"
                value={earn}
                onChange={(event) => setEarn(event.target.value)}
              />
            </Field>
            <Field label={`ارزش هر امتیاز (${money.unitLabel})`}>
              <PersianNumberInput
                inputMode="numeric"
                allowDecimal={false}
                allowNegative={false}
                className={inputClass}
                dir="ltr"
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            </Field>
            <Field label="انقضای امتیاز (روز)">
              <PersianNumberInput
                inputMode="numeric"
                allowDecimal={false}
                allowNegative={false}
                className={inputClass}
                dir="ltr"
                value={expiry}
                onChange={(event) => setExpiry(event.target.value)}
                placeholder="خالی = بدون انقضا"
              />
            </Field>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">
            <label className="flex min-h-11 items-center gap-2 text-foreground">
              <input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} />
              برنامه فعال است
            </label>
            <label className="flex min-h-11 items-center gap-2 text-foreground">
              <input type="checkbox" checked={isDefault} disabled={!isActive} onChange={(event) => setIsDefault(event.target.checked)} />
              برنامهٔ پیش‌فرض
            </label>
          </div>
          <Button type="submit" disabled={busy} className="mt-3 min-h-11 w-full">
            {busy ? "در حال ذخیره…" : editing ? "ذخیرهٔ تغییرات" : "ذخیرهٔ برنامه"}
          </Button>
        </form>
      ) : null}
    </SectionCard>
  );
}

function CustomerPanel({
  customers,
  customer,
  customerId,
  onSelectCustomer,
  onCustomerQuery,
  customersLoading,
  balance,
  balanceLoaded,
  balanceError,
  abilities,
  canRedeem,
  onChanged,
  onError,
}: {
  customers: Customer[];
  customer: Customer | undefined;
  customerId: string;
  onSelectCustomer: (value: string) => void;
  onCustomerQuery: (value: string) => void;
  customersLoading: boolean;
  balance: { points: number; storeCredit: number } | null;
  balanceLoaded: boolean;
  balanceError: string;
  abilities: Pick<GrowthAbilities, "redeemPoints" | "issueStoreCredit" | "payOutStoreCredit">;
  canRedeem: boolean;
  onChanged: (message: string) => void;
  onError: (message: string) => void;
}) {
  const money = useMoney();
  const [points, setPoints] = useState("");
  const [credit, setCredit] = useState("");
  const [reason, setReason] = useState("");
  const creditActions = (["issue", "payout"] as const).filter((action) =>
    action === "issue" ? abilities.issueStoreCredit : abilities.payOutStoreCredit,
  );
  const [chosenCreditAction, setCreditAction] = useState<"issue" | "payout">("issue");
  // Never hold an action this member cannot take — fall back to the one they can.
  const creditAction = creditActions.includes(chosenCreditAction) ? chosenCreditAction : (creditActions[0] ?? "issue");
  const canDoAnything = abilities.redeemPoints || creditActions.length > 0;
  const [payoutMethod, setPayoutMethod] = useState<"cash" | "bank">("cash");
  const [busy, setBusy] = useState(false);

  async function redeem() {
    const count = Number(points);
    if (!customerId || !Number.isSafeInteger(count) || count <= 0) {
      onError("تعداد امتیاز باید عدد صحیح مثبت باشد.");
      return;
    }
    setBusy(true);
    onError("");
    const { ok, data } = await api<{ error?: string; message?: string }>(`/api/loyalty/customers/${customerId}/redeem`, {
      method: "POST",
      body: JSON.stringify({ points: count }),
    });
    setBusy(false);
    if (!ok) onError(data.message ?? errorMessage(data.error) ?? "تبدیل امتیاز ناموفق بود.");
    else {
      setPoints("");
      onChanged("امتیاز به اعتبار فروشگاهی تبدیل شد.");
    }
  }

  async function storeCredit() {
    if (!customerId) return;
    let amount: number;
    try {
      amount = money.parse(credit);
    } catch {
      onError(`مبلغ اعتبار را به ${money.unitLabel} و به‌صورت عدد صحیح وارد کنید.`);
      return;
    }
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      onError("مبلغ اعتبار باید مثبت باشد.");
      return;
    }
    if (creditAction === "issue" && reason.trim().length > 500) {
      onError("دلیل صدور اعتبار نباید بیش از ۵۰۰ نویسه باشد.");
      return;
    }
    setBusy(true);
    onError("");
    const { ok, data } = await api<{ error?: string; message?: string }>(`/api/loyalty/customers/${customerId}/store-credit`, {
      method: "POST",
      body: JSON.stringify({
        action: creditAction === "payout" ? "use" : "issue",
        amount,
        reason: creditAction === "issue" ? reason.trim() || null : undefined,
        paymentMethod: creditAction === "payout" ? payoutMethod : undefined,
      }),
    });
    setBusy(false);
    if (!ok) onError(data.message ?? errorMessage(data.error) ?? "عملیات اعتبار ناموفق بود.");
    else {
      setCredit("");
      setReason("");
      onChanged(creditAction === "issue" ? "اعتبار فروشگاهی صادر شد." : "بازپرداخت اعتبار فروشگاهی ثبت شد.");
    }
  }

  return (
    <SectionCard
      title={<CardTitle eyebrow="امور مالی مشتریان" title="مشتری و اعتبار" />}
      description="مانده‌ها از دفتر امتیاز و رویدادهای حسابداری خوانده می‌شوند، نه از یک ستون قابل ویرایش."
      bodyClassName="space-y-4 p-4 sm:p-5"
    >
      <Field label="مشتری">
        <SearchableSelect
          value={customerId}
          onChange={onSelectCustomer}
          onQueryChange={onCustomerQuery}
          loading={customersLoading}
          options={customers.map((candidate) => ({
            value: candidate.id,
            label: candidate.phone ? `${candidate.name} — ${candidate.phone}` : candidate.name,
          }))}
          placeholder="نام یا شمارهٔ مشتری را جست‌وجو کنید"
          searchPlaceholder="نام یا شمارهٔ مشتری…"
          emptyText="مشتری فعالی یافت نشد."
          ariaLabel="انتخاب مشتری"
        />
      </Field>

      {customer && !balanceLoaded ? <LoadingSkeleton rows={1} compact label="در حال بارگذاری ماندهٔ مشتری" /> : null}
      {balanceError ? <ErrorBox>{balanceError}</ErrorBox> : null}
      {customer && balance && balanceLoaded ? (
        <div className="grid gap-2 rounded-xl border border-border/80 p-3 text-sm sm:grid-cols-2">
          <div>
            <span className="text-muted-foreground">امتیاز قابل استفاده:</span> <b>{formatPersianNumber(balance.points)}</b>
          </div>
          <div>
            <span className="text-muted-foreground">اعتبار فروشگاهی:</span> <b>{money.format(balance.storeCredit)}</b>
          </div>
        </div>
      ) : null}

      {!canDoAnything ? (
        <InfoBox>برای مشاهدهٔ مانده، مشتری را انتخاب کنید. تبدیل امتیاز و صدور یا بازپرداخت اعتبار هرکدام مجوز جداگانه‌ای دارند.</InfoBox>
      ) : (
        <>
          {abilities.redeemPoints && !canRedeem ? <InfoBox>برای تبدیل امتیاز، ابتدا یک برنامهٔ فعال و پیش‌فرض وفاداری تعریف کنید.</InfoBox> : null}
          {abilities.redeemPoints ? (
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <Field label="تبدیل امتیاز به اعتبار">
              <PersianNumberInput
                inputMode="numeric"
                allowDecimal={false}
                allowNegative={false}
                className={inputClass}
                dir="ltr"
                value={points}
                onChange={(event) => setPoints(event.target.value)}
                placeholder="تعداد امتیاز"
              />
            </Field>
            <Button type="button" disabled={busy || !customerId || !points.trim() || !canRedeem} onClick={() => void redeem()} className="min-h-11">
              تبدیل به اعتبار
            </Button>
          </div>
          ) : null}

          {creditActions.length > 0 ? (
          <div className="rounded-xl border border-border/80 p-3">
            {creditActions.length > 1 ? (
            <div className="mb-3 grid gap-2 sm:grid-cols-2">
              <Button
                type="button"
                variant="outline"
                className={`min-h-11 ${creditAction === "issue" ? "border-amber-200 bg-amber-100 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/20 dark:text-amber-200" : ""}`}
                aria-pressed={creditAction === "issue"}
                disabled={busy}
                onClick={() => setCreditAction("issue")}
              >
                صدور اعتبار
              </Button>
              <Button
                type="button"
                variant="outline"
                className={`min-h-11 ${creditAction === "payout" ? "border-amber-200 bg-amber-100 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/20 dark:text-amber-200" : ""}`}
                aria-pressed={creditAction === "payout"}
                disabled={busy}
                onClick={() => setCreditAction("payout")}
              >
                بازپرداخت اعتبار
              </Button>
            </div>
            ) : (
              <p className="mb-3 text-sm font-medium text-foreground">
                {creditAction === "issue" ? "صدور اعتبار" : "بازپرداخت اعتبار"}
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_11rem] sm:items-end">
              <Field label={`مبلغ (${money.unitLabel})`}>
                <PersianNumberInput
                  inputMode="numeric"
                  allowDecimal={false}
                  allowNegative={false}
                  className={inputClass}
                  dir="ltr"
                  value={credit}
                  onChange={(event) => setCredit(event.target.value)}
                />
              </Field>
              {creditAction === "payout" ? (
                <Field label="روش بازپرداخت">
                  <select className={inputClass} value={payoutMethod} onChange={(event) => setPayoutMethod(event.target.value as "cash" | "bank")}>
                    <option value="cash">نقدی</option>
                    <option value="bank">بانکی</option>
                  </select>
                </Field>
              ) : (
                <Field label="دلیل صدور">
                  <input
                    className={inputClass}
                    value={reason}
                    maxLength={500}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="مثلاً اصلاح یا بازگشت فروش"
                  />
                </Field>
              )}
            </div>
            <Button type="button" disabled={busy || !customerId || !credit.trim()} onClick={() => void storeCredit()} className="mt-3 min-h-11 w-full">
              {creditAction === "issue" ? "ثبت صدور اعتبار" : "ثبت بازپرداخت اعتبار"}
            </Button>
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              {creditAction === "issue"
                ? "صدور اعتبار، بدهی «اعتبار فروشگاهی» را ثبت می‌کند؛ دلیل آن در سند حسابداری نگهداری می‌شود."
                : "بازپرداخت، ماندهٔ اعتبار را کم و وجه را نقدی یا بانکی به مشتری پرداخت می‌کند."}
            </p>
          </div>
          ) : null}
        </>
      )}
    </SectionCard>
  );
}
