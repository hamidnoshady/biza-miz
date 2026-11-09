"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { SectionCard, SectionCardSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { ErrorBox, Field, PrimaryButton, SecondaryButton, inputClass } from "@/app/dashboard/ui";
import { useMoney } from "@/components/money/money-context";
import { PETTY_CASH_APPROVER_ROLES, type PettyCashFund, type PettyCashOperation } from "@/lib/petty-cash";
import { financialAccountErrorMessage } from "@/lib/financial-account-errors";
import { todayIsoDate } from "@/lib/jalali";
import { toLatinDigits } from "@/lib/digits";
import { formatMoneyText } from "@/lib/money";
import { fmtJalali } from "./ledger-ui";

const ENDPOINT = "/api/ledger/petty-cash";
type Option = { id: string; name: string };
type Options = {
  funds: PettyCashFund[];
  canManage: boolean;
  categoryAccounts: (Option & { code: string })[];
  custodians: (Option & { locationIds: string[] })[];
  accounts: (Option & { kind: string; locationId: string | null })[];
  locations: Option[];
};
type History = { operations: PettyCashOperation[]; hasMore: boolean };
type Action = PettyCashOperation["kind"] | "approve" | "reject";

const ACTION_LABEL: Record<Action, string> = {
  fund: "تخصیص اولیه", submit: "ارسال هزینه", replenish: "شارژ تنخواه",
  reconcile: "شمارش و تطبیق", close: "بازگشت وجه و بستن", approve: "تأیید و ثبت هزینه", reject: "رد هزینه",
};
const STATUS_LABEL: Record<PettyCashOperation["status"], string> = {
  posted: "ثبت شده", pending: "در انتظار بررسی", approved: "تأیید شده", rejected: "رد شده",
  matched: "بدون مغایرت", discrepancy: "دارای مغایرت",
};
const ROLE_LABEL: Record<string, string> = { owner: "مالک", admin: "مدیر سامانه", manager: "مدیر شعبه", accountant: "حسابدار" };
const ERROR_LABEL: Record<string, string> = {
  forbidden: "اجازه انجام این عملیات را ندارید.",
  invalid_amount: "مبلغ را به صورت عدد معتبر وارد کنید.",
  invalid_expense_date: "تاریخ را انتخاب کنید.",
  expense_date_in_future: "تاریخ نمی‌تواند در آینده باشد.",
  petty_cash_note_required: "شرح عملیات را وارد کنید.",
  petty_cash_account_invalid: "حساب تنخواه فعال این شعبه را انتخاب کنید.",
  petty_cash_funding_account_invalid: "حساب بانکی یا صندوق فعال این شعبه را انتخاب کنید.",
  petty_cash_custodian_invalid: "تنخواه‌گردان فعال این شعبه را انتخاب کنید.",
  petty_cash_policy_invalid: "روش تأمین تنخواه را انتخاب کنید.",
  petty_cash_category_invalid: "سرفصل هزینه مجاز را انتخاب کنید.",
  petty_cash_approval_role_invalid: "حداقل یک نقش برای تأیید انتخاب کنید.",
  petty_cash_already_configured: "برای این حساب تنخواه قبلاً تنظیمات ثبت شده است.",
  petty_cash_account_nonzero: "برای تعریف تنخواه، مانده حساب باید صفر باشد.",
  petty_cash_not_funded: "تخصیص اولیه هنوز ثبت نشده است.",
  petty_cash_already_funded: "تخصیص اولیه قبلاً ثبت شده است.",
  petty_cash_already_closed: "این تنخواه بسته شده است.",
  petty_cash_date_before_movement: "تاریخ ثبت نمی‌تواند پیش از آخرین گردش تنخواه یا تاریخ رسید باشد.",
  petty_cash_pending_expenses: "هزینه‌های در انتظار بررسی را پیش از بستن تنخواه تعیین تکلیف کنید.",
  petty_cash_already_decided: "این هزینه قبلاً بررسی شده است.",
  fixed_float_must_fill: "مبلغ باید مانده تنخواه ثابت را به سقف مجاز برساند.",
  float_ceiling_exceeded: "مبلغ از سقف تنخواه بیشتر است.",
  insufficient_float: "مانده تنخواه برای ثبت این هزینه کافی نیست.",
  float_count_mismatch: "وجه شمارش شده با مانده دفتر برابر نیست.",
  petty_cash_receipt_invalid: "یک تصویر معتبر JPEG، PNG یا WebP انتخاب کنید.",
  petty_cash_receipt_too_large: "حجم تصویر رسید باید کمتر از ۵ مگابایت باشد.",
  receipt_asset_not_found: "تصویر رسید در دسترس نیست.",
  storage_error: "ذخیره‌سازی فایل در دسترس نیست.",
};
function message(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  return ERROR_LABEL[code] ?? financialAccountErrorMessage(code) ?? "عملیات انجام نشد. دوباره تلاش کنید.";
}

function exactAmount(rial: string, money: ReturnType<typeof useMoney>): string {
  // A remainder of one to nine Rial cannot be shown as a whole Toman.
  return money.unit === "toman" && BigInt(rial) % 10n !== 0n
    ? formatMoneyText(rial, "rial", { withUnit: true })
    : money.formatText(rial, { withUnit: true });
}

function parseAmount(input: string, money: ReturnType<typeof useMoney>): string {
  if (money.unit === "toman") {
    const fraction = /^(\d+)[.٫](\d)$/.exec(toLatinDigits(input.trim()).replace(/[٬,\s]/g, ""));
    if (fraction) return (BigInt(fraction[1]) * 10n + BigInt(fraction[2])).toString();
  }
  return money.parseText(input);
}
async function read<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result as T;
}

export function PettyCashSection() {
  const money = useMoney();
  const [data, setData] = useState<Options | null>(null);
  const [fundId, setFundId] = useState("");
  const [history, setHistory] = useState<History>({ operations: [], hasMore: false });
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [configure, setConfigure] = useState(false);
  const [action, setAction] = useState<{ kind: Action; operationId?: string; date?: string } | null>(null);
  const retry = useRef<{ signature: string; key: string } | null>(null);
  const fund = data?.funds.find((item) => item.id === fundId);

  const load = useCallback(async (signal?: AbortSignal) => {
    const result = await read<Options>(ENDPOINT, { signal });
    setData(result);
    setFundId((id) => result.funds.some((item) => item.id === id) ? id : result.funds[0]?.id ?? "");
  }, []);
  const loadHistory = useCallback(async (id: string, start: number, signal?: AbortSignal) => {
    const result = await read<History>(`${ENDPOINT}?fundId=${id}&offset=${start}`, { signal });
    setHistory(result);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch((err) => { if (!controller.signal.aborted) setError(message(err)); });
    return () => controller.abort();
  }, [load]);
  useEffect(() => {
    if (!fundId) return;
    const controller = new AbortController();
    void loadHistory(fundId, offset, controller.signal).catch((err) => { if (!controller.signal.aborted) setError(message(err)); });
    return () => controller.abort();
  }, [fundId, offset, loadHistory]);

  async function save(values: Record<string, unknown>) {
    setBusy(true);
    setError("");
    setNotice("");
    const signature = JSON.stringify(values);
    if (retry.current?.signature !== signature) retry.current = { signature, key: crypto.randomUUID() };
    try {
      const result = await read<{ fund?: PettyCashFund }>(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": retry.current.key },
        body: signature,
      });
      retry.current = null;
      setConfigure(false);
      setAction(null);
      setNotice("عملیات ثبت شد.");
      await load();
      if (result.fund) {
        setHistory({ operations: [], hasMore: false });
        setOffset(0);
        setFundId(result.fund.id);
      }
      if (fundId && !result.fund) await loadHistory(fundId, offset);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  if (!data) return error ? <ErrorBox>{error}</ErrorBox> : <SectionCardSkeleton />;
  const actions: Action[] = [];
  if (fund && !fund.closedAt) {
    if (!fund.fundedAt && data.canManage) actions.push("fund");
    if (fund.fundedAt) {
      if (fund.canSubmit) actions.push("submit");
      if (data.canManage) actions.push("replenish", "close");
      if (fund.canSubmit || data.canManage) actions.push("reconcile");
    }
  }

  return (
    <div className="space-y-4">
      <SectionCard title="تنخواه‌گردان" description="سقف، متصدی، هزینه‌ها و شمارش وجه هر تنخواه را مدیریت کنید."
        actions={data.canManage && <SecondaryButton onClick={() => { setConfigure(!configure); setAction(null); }}>تعریف تنخواه</SecondaryButton>}>
        {error && <ErrorBox>{error}</ErrorBox>}
        {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
        {configure && <ConfigurationForm data={data} busy={busy} save={save} />}
        {!data.funds.length && !configure && <p className="text-sm text-muted-foreground">تنخواهی برای نمایش وجود ندارد.</p>}
        {data.funds.length > 0 && <Field label="حساب تنخواه">
          <select className={inputClass} value={fundId} onChange={(e) => {
            setHistory({ operations: [], hasMore: false }); setFundId(e.target.value); setOffset(0); setAction(null);
          }}>
            {data.funds.map((item) => <option key={item.id} value={item.id}>{item.accountName} · {item.locationName}</option>)}
          </select>
        </Field>}
        {fund && <>
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div><dt>مانده دفتر</dt><dd>{exactAmount(fund.balance, money)}</dd></div>
            <div><dt>سقف مجاز</dt><dd>{exactAmount(fund.ceiling, money)}</dd></div>
            <div><dt>تنخواه‌گردان</dt><dd>{fund.custodianName}</dd></div>
            <div><dt>حساب تأمین وجه</dt><dd>{fund.fundingAccountName}</dd></div>
            <div><dt>سیاست</dt><dd>{fund.policy === "fixed" ? "مانده ثابت" : "مانده متغیر"}</dd></div>
            <div><dt>وضعیت</dt><dd><StatusBadge>{fund.closedAt ? "بسته" : fund.fundedAt ? "فعال" : "در انتظار تخصیص"}</StatusBadge></dd></div>
          </dl>
          <div className="mt-4 flex flex-wrap gap-2">
            {actions.map((kind) => <SecondaryButton key={kind} disabled={busy} onClick={() => {
              setConfigure(false); setAction({ kind }); setError(""); setNotice("");
            }}>{ACTION_LABEL[kind]}</SecondaryButton>)}
          </div>
          {action && <MovementForm key={`${fund.id}:${action.kind}:${action.operationId ?? ""}`} fund={fund}
            action={action} categories={data.categoryAccounts} busy={busy} save={save} cancel={() => setAction(null)} />}
        </>}
      </SectionCard>
      {fund && <SectionCard title="گردش و رسیدها">
        {history.operations.length === 0 && <p className="text-sm text-muted-foreground">گردشی برای نمایش وجود ندارد.</p>}
        <ul className="divide-y divide-border">
          {history.operations.map((operation) => <li key={operation.id} className="space-y-2 py-3 text-sm">
            <div className="flex flex-wrap items-center gap-3">
              <strong>{ACTION_LABEL[operation.kind]}</strong>
              <StatusBadge tone={operation.status === "pending" ? "active" :
                operation.status === "rejected" || operation.status === "discrepancy" ? "danger" : "positive"}>{STATUS_LABEL[operation.status]}</StatusBadge>
              <span>{exactAmount(operation.amount, money)}</span>
              <span>{fmtJalali(operation.businessDate)}</span>
              {operation.actorName && <span>{operation.actorName}</span>}
            </div>
            <p>{operation.note}{operation.categoryName && ` · ${operation.categoryName}`}</p>
            {operation.ledgerBalance !== null && <p>مانده دفتر در تاریخ شمارش: {exactAmount(operation.ledgerBalance, money)}</p>}
            {operation.status === "discrepancy" && operation.ledgerBalance !== null &&
              <p>اختلاف شمارش: {exactAmount((BigInt(operation.amount) - BigInt(operation.ledgerBalance)).toString(), money)}</p>}
            {operation.decisionNote && <p>علت رد: {operation.decisionNote}</p>}
            <div className="flex flex-wrap items-center gap-2">
              {operation.receiptAssetId && <a className="text-primary underline" target="_blank" rel="noreferrer"
                href={`${ENDPOINT}?fundId=${fund.id}&receipt=${operation.receiptAssetId}`}>{operation.receiptFileName || "مشاهده رسید"}</a>}
              {operation.status === "pending" && fund.canDecide && !fund.closedAt && (["approve", "reject"] as const).map((kind) =>
                <SecondaryButton key={kind} disabled={busy} onClick={() => {
                  setConfigure(false); setAction({ kind, operationId: operation.id, date: operation.businessDate }); setError(""); setNotice("");
                }}>{ACTION_LABEL[kind]}</SecondaryButton>)}
            </div>
          </li>)}
        </ul>
        <div className="flex gap-2">
          {offset > 0 && <SecondaryButton onClick={() => setOffset(Math.max(0, offset - 100))}>قبلی</SecondaryButton>}
          {history.hasMore && <SecondaryButton onClick={() => setOffset(offset + 100)}>بعدی</SecondaryButton>}
        </div>
      </SectionCard>}
    </div>
  );
}

type Save = (values: Record<string, unknown>) => Promise<void>;

function ConfigurationForm({ data, busy, save }: { data: Options; busy: boolean; save: Save }) {
  const money = useMoney();
  const [locationId, setLocationId] = useState("");
  const [error, setError] = useState("");
  const existing = new Set(data.funds.map((fund) => fund.accountId));
  const petty = data.accounts.filter((account) => account.kind === "petty_cash" && account.locationId === locationId && !existing.has(account.id));
  const funding = data.accounts.filter((account) => account.kind !== "petty_cash" && (account.locationId === locationId || account.locationId === null));
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    let ceiling: string;
    try { ceiling = parseAmount(String(form.get("ceiling") ?? ""), money); } catch { setError(ERROR_LABEL.invalid_amount); return; }
    setError("");
    await save({
      action: "configure", locationId, ceiling,
      accountId: form.get("accountId"), fundingAccountId: form.get("fundingAccountId"),
      custodianId: form.get("custodianId"), policy: form.get("policy"),
      categoryAccountIds: form.getAll("categoryAccountIds"), approvalRoles: form.getAll("approvalRoles"),
    });
  }
  return <form className="mb-4 rounded-lg border border-border p-4" onSubmit={submit}>
    {error && <ErrorBox>{error}</ErrorBox>}
    <div className="grid gap-x-4 md:grid-cols-2">
      <Field label="شعبه">
        <select className={inputClass} value={locationId} onChange={(e) => setLocationId(e.target.value)} required>
          <option value="">انتخاب شعبه</option>
          {data.locations.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
        </select>
      </Field>
      <Field label="حساب تنخواه شعبه" hint="در صورت نیاز، ابتدا حساب تنخواه این شعبه را در فهرست حساب‌های مالی ثبت کنید.">
        <OptionSelect key={`petty:${locationId}`} name="accountId" options={petty} />
      </Field>
      <Field label="حساب تأمین و برگشت وجه"><OptionSelect key={`funding:${locationId}`} name="fundingAccountId" options={funding} /></Field>
      <Field label="تنخواه‌گردان"><OptionSelect key={`custodian:${locationId}`} name="custodianId"
        options={data.custodians.filter((employee) => employee.locationIds.includes(locationId))} /></Field>
      <Field label={`سقف مجاز (${money.unitLabel})`}><input name="ceiling" className={inputClass} inputMode="decimal" required /></Field>
      <Field label="سیاست تأمین" hint="تنخواه ثابت تا سقف شارژ می‌شود. تنخواه متغیر می‌تواند کمتر از سقف شارژ شود.">
        <select name="policy" className={inputClass}><option value="fixed">مانده ثابت</option><option value="variable">مانده متغیر</option></select>
      </Field>
    </div>
    <fieldset className="mb-4">
      <legend className="mb-1 text-sm font-medium">سرفصل‌های هزینه مجاز</legend>
      <div className="flex max-h-40 flex-wrap gap-3 overflow-auto">
        {data.categoryAccounts.map((category) => <label key={category.id} className="flex items-center gap-1 text-sm">
          <input type="checkbox" name="categoryAccountIds" value={category.id} />{category.name}
        </label>)}
      </div>
    </fieldset>
    <fieldset className="mb-4">
      <legend className="mb-1 text-sm font-medium">نقش‌های مجاز برای تأیید هزینه</legend>
      <div className="flex flex-wrap gap-3">
        {PETTY_CASH_APPROVER_ROLES.map((role) => <label key={role} className="flex items-center gap-1 text-sm">
          <input type="checkbox" name="approvalRoles" value={role} defaultChecked={role === "accountant"} />{ROLE_LABEL[role]}
        </label>)}
      </div>
    </fieldset>
    <PrimaryButton disabled={busy}>ثبت تنظیمات</PrimaryButton>
  </form>;
}

function OptionSelect({ name, options }: { name: string; options: Option[] }) {
  return <select name={name} className={inputClass} defaultValue="" required>
    <option value="">انتخاب کنید</option>
    {options.map(({ id, name: label }) => <option key={id} value={id}>{label}</option>)}
  </select>;
}

function MovementForm({
  fund, action, categories, busy, save, cancel,
}: {
  fund: PettyCashFund; action: { kind: Action; operationId?: string; date?: string };
  categories: Option[]; busy: boolean; save: Save; cancel: () => void;
}) {
  const money = useMoney();
  const [date, setDate] = useState(action.kind === "approve" ? todayIsoDate() : action.date ?? todayIsoDate());
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const receipt = useRef<string | null>(null);
  const kind = action.kind;
  const decision = kind === "approve" || kind === "reject";
  const fixed = fund.policy === "fixed" && (kind === "fund" || kind === "replenish");
  const fixedAmount = BigInt(fund.ceiling) - BigInt(fund.balance);
  const defaultAmount = !fixed || fixedAmount < 0n ? "" : money.unit === "toman" && fixedAmount % 10n !== 0n
    ? `${fixedAmount / 10n}.${fixedAmount % 10n}` : money.toInputText(fixedAmount.toString());

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const values: Record<string, unknown> = { fundId: fund.id, action: kind, operationId: action.operationId, businessDate: date, note: form.get("note") };
    setError("");
    if (!decision) {
      try { values.amount = parseAmount(String(form.get("amount") ?? ""), money); } catch { setError(ERROR_LABEL.invalid_amount); return; }
    }
    if (kind === "submit") {
      const file = form.get("receipt");
      if (!(file instanceof File) || !file.size) { setError(ERROR_LABEL.petty_cash_receipt_invalid); return; }
      values.categoryAccountId = form.get("categoryAccountId");
      if (!receipt.current) {
        setUploading(true);
        try {
          const result = await read<{ asset: { id: string } }>(
            `${ENDPOINT}?uploadReceipt=${fund.id}&fileName=${encodeURIComponent(file.name)}`,
            { method: "POST", headers: { "Content-Type": file.type }, body: file },
          );
          receipt.current = result.asset.id;
        } catch (err) {
          setError(message(err));
          return;
        } finally {
          setUploading(false);
        }
      }
      values.receiptAssetId = receipt.current;
    }
    await save(values);
  }

  return <form className="mt-4 rounded-lg border border-border p-4" onSubmit={submit}>
    <h3 className="mb-3 text-sm font-semibold">{ACTION_LABEL[kind]}</h3>
    {error && <ErrorBox>{error}</ErrorBox>}
    <div className="grid gap-x-4 md:grid-cols-2">
      {kind !== "reject" && <Field label="تاریخ" as="div"><JalaliDatePicker ariaLabel="تاریخ عملیات" value={date} onChange={setDate} /></Field>}
      {!decision && <Field label={`${kind === "reconcile" || kind === "close" ? "وجه شمارش شده" : "مبلغ"} (${money.unitLabel})`}>
        <input name="amount" className={inputClass} inputMode="decimal" required defaultValue={defaultAmount} />
      </Field>}
      {kind === "submit" && <>
        <Field label="سرفصل هزینه"><OptionSelect name="categoryAccountId" options={categories.filter((category) => fund.categoryAccountIds.includes(category.id))} /></Field>
        <Field label="تصویر رسید"><input type="file" name="receipt" className={inputClass} accept="image/jpeg,image/png,image/webp" required
          onChange={() => { receipt.current = null; }} /></Field>
      </>}
      {kind !== "approve" && <Field label={kind === "reject" ? "علت رد" : "شرح"}>
        <input name="note" className={inputClass} maxLength={500} required />
      </Field>}
    </div>
    <div className="flex items-center gap-2">
      <PrimaryButton disabled={busy || uploading || (kind !== "reject" && !date)}>{uploading ? "در حال ارسال رسید…" : ACTION_LABEL[kind]}</PrimaryButton>
      <SecondaryButton disabled={busy || uploading} onClick={cancel}>انصراف</SecondaryButton>
    </div>
  </form>;
}
