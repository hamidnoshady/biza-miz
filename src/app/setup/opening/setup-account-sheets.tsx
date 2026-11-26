"use client";

/**
 * The four in-wizard money-container sheets and the inline GL-account sheet
 * (issue #1583, workstreams A5 + B).
 *
 * They are deliberately thin: the form collects what the canonical service
 * validates, and every write goes through the existing endpoints
 * (`/api/setup/opening/financial-accounts` → `createFinancialAccount`, and
 * `/api/ledger/accounts` → `createAccount`). No second registry, no client-side
 * eligibility guess — the eligible GL list is fetched from the endpoint that
 * applies the server's own policy.
 */
import { useCallback, useEffect, useState } from "react";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import {
  FINANCIAL_ACCOUNT_KIND_META,
  IRANIAN_BANKS,
  type FinancialAccountKind,
} from "@/lib/financial-accounts";
import { financialAccountErrorMessage } from "@/lib/financial-account-errors";
import { api, ErrorBox, Field, InfoBox, inputClass, PrimaryButton, SecondaryButton } from "../ui";

export interface SetupFinancialAccountLink {
  id: string;
  name: string;
  kind: string;
  glAccountId: string;
}

export interface SetupLocationOption {
  id: string;
  name: string;
}

interface GlOption {
  id: string;
  code: string;
  name: string;
}

/** One reusable right-side sheet, RTL and keyboard-accessible via Radix. */
function WizardSheet({
  open,
  title,
  description,
  busy,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  description: string;
  busy: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={(next) => (!next && !busy ? onClose() : undefined)}>
      <SheetContent
        side="right"
        showCloseButton={!busy}
        className="w-full max-w-lg overflow-y-auto p-0"
      >
        <SheetHeader className="border-b border-border">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        <div className="px-4">{children}</div>
      </SheetContent>
    </Sheet>
  );
}

/** The GL leaf a container of this kind normally needs, used to preselect a parent. */
const DEFAULT_PARENT_CODE: Record<FinancialAccountKind, string> = {
  bank: "1110",
  cash: "1100",
  petty_cash: "1130",
  pos_psp: "1120",
};

/**
 * Inline GL account creation: one validated child under an existing parent.
 * It never replaces the chart — `createAccount` adds exactly one row, with the
 * same hierarchy, type, code and audit rules as the chart editor.
 */
export function GlAccountSheet({
  open,
  kind,
  onClose,
  onSaved,
}: {
  open: boolean;
  kind: FinancialAccountKind;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [accounts, setAccounts] = useState<{ id: string; code: string; name: string; type: string; has_children?: boolean; parent_id: string | null }[]>([]);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError("");
    setLoading(true);
    api<{ accounts: typeof accounts }>("/api/ledger/accounts")
      .then(({ ok, data }) => {
        if (!ok) return setError("خواندن سرفصل‌ها ممکن نشد.");
        setAccounts(data.accounts ?? []);
      })
      .finally(() => setLoading(false));
  }, [open]);

  useEffect(() => {
    if (!open || parentId) return;
    const preferred = accounts.find((account) => account.code === DEFAULT_PARENT_CODE[kind]);
    if (preferred) setParentId(preferred.id);
  }, [accounts, kind, open, parentId]);

  const assetParents = accounts.filter((account) => account.type === "asset");

  async function save() {
    setError("");
    if (!code.trim() || !name.trim()) {
      setError("کد و نام حساب را وارد کنید.");
      return;
    }
    setBusy(true);
    try {
      const { ok, data, status } = await api<{ error?: string }>("/api/ledger/accounts", {
        method: "POST",
        body: JSON.stringify({
          code: code.trim(),
          name: name.trim(),
          type: "asset",
          parentId: parentId || null,
        }),
      });
      if (!ok) {
        const message = financialAccountErrorMessage(data.error);
        setError(message ?? (status === 403 ? "برای افزودن سرفصل، دسترسی «ویرایش کدینگ حساب‌ها» لازم است." : "افزودن سرفصل ممکن نشد."));
        return;
      }
      setCode("");
      setName("");
      onSaved();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <WizardSheet
      open={open}
      title="افزودن سرفصل دفتر کل"
      description="یک حساب تفصیلی تازه زیر والد انتخاب‌شده می‌سازد؛ سرفصل‌های موجود دست‌نخورده می‌مانند."
      busy={busy}
      onClose={onClose}
    >
      <ErrorBox>{error}</ErrorBox>
      {loading ? (
        <div
          role="status"
          aria-live="polite"
          aria-busy="true"
          aria-label="در حال خواندن سرفصل‌های حساب"
          className="space-y-2 py-2"
        >
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      ) : null}
      <Field label="حساب والد" hint="حساب جدید زیر این سرفصل قرار می‌گیرد.">
        <SearchableSelect
          className={inputClass}
          value={parentId}
          onChange={setParentId}
          ariaLabel="حساب والد"
          options={[
            { value: "", label: "بدون والد (گروه)" },
            ...assetParents.map((account) => ({ value: account.id, label: `${account.code} — ${account.name}` })),
          ]}
        />
      </Field>
      <Field label="کد حساب" hint="مثلاً ۱۱۱۱؛ ارقام فارسی هم پذیرفته می‌شود.">
        <input className={inputClass} dir="ltr" value={code} onChange={(event) => setCode(event.target.value)} />
      </Field>
      <Field label="نام حساب">
        <input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} placeholder="مثلاً بانک ملت — حساب جاری" />
      </Field>
      <SheetFooter className="px-0">
        <PrimaryButton type="button" onClick={save} disabled={busy}>
          {busy ? "در حال ذخیره…" : "ساخت سرفصل"}
        </PrimaryButton>
        <SecondaryButton onClick={onClose} disabled={busy}>
          انصراف
        </SecondaryButton>
      </SheetFooter>
    </WizardSheet>
  );
}

/**
 * One money container (bank / till / petty cash / POS terminal). The POS form
 * requires a settlement bank from the business's *real* bank rows, and each
 * terminal's GL link is a clearing leaf of its own — the service refuses a
 * shared GL or a bank's own GL on a terminal.
 */
export function FinancialAccountSheet({
  open,
  kind,
  locations,
  currencies,
  baseCurrencyCode,
  banks,
  canManageChart,
  onClose,
  onSaved,
  onAddGl,
  onAddBank,
}: {
  open: boolean;
  kind: FinancialAccountKind;
  locations: SetupLocationOption[];
  currencies: string[];
  baseCurrencyCode: string;
  banks: SetupFinancialAccountLink[];
  canManageChart: boolean;
  onClose: () => void;
  onSaved: () => void;
  onAddGl: () => void;
  onAddBank: () => void;
}) {
  const meta = FINANCIAL_ACCOUNT_KIND_META[kind];
  const [glOptions, setGlOptions] = useState<GlOption[] | null>(null);
  const [glError, setGlError] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [glAccountId, setGlAccountId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [currencyCode, setCurrencyCode] = useState(baseCurrencyCode);
  const [bankCode, setBankCode] = useState("");
  const [bankName, setBankName] = useState("");
  const [bankBranchName, setBankBranchName] = useState("");
  const [accountHolder, setAccountHolder] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [cardNumber, setCardNumber] = useState("");
  const [iban, setIban] = useState("");
  const [pspProvider, setPspProvider] = useState("");
  const [terminalNumber, setTerminalNumber] = useState("");
  const [merchantNumber, setMerchantNumber] = useState("");
  const [settlementAccountId, setSettlementAccountId] = useState("");
  const [settlementDelayDays, setSettlementDelayDays] = useState("1");
  const [isDefault, setIsDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadCandidates = useCallback(() => {
    setGlOptions(null);
    setGlError("");
    api<{ accounts: GlOption[]; error?: string }>(`/api/ledger/financial-accounts/eligible?kind=${kind}`).then(
      ({ ok, data }) => {
        if (ok) {
          setGlOptions(data.accounts ?? []);
          setGlAccountId((current) => (current && (data.accounts ?? []).some((a) => a.id === current) ? current : (data.accounts?.[0]?.id ?? "")));
        } else {
          setGlOptions([]);
          setGlError(financialAccountErrorMessage(data.error) ?? "خواندن سرفصل‌های واجد شرایط ممکن نشد.");
        }
      },
    );
  }, [kind]);

  useEffect(() => {
    if (!open) return;
    setError("");
    setCurrencyCode(baseCurrencyCode);
    setSettlementDelayDays("1");
    setLocationId("");
    loadCandidates();
  }, [open, baseCurrencyCode, loadCandidates]);

  async function save() {
    setError("");
    if (!name.trim()) return setError("نام حساب را وارد کنید.");
    if (!glAccountId) return setError("سرفصل دفتر کل این حساب را انتخاب کنید.");
    if (kind === "pos_psp" && !settlementAccountId) {
      return setError("حساب بانکی تسویه را انتخاب کنید.");
    }
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        kind,
        name: name.trim(),
        code: code.trim() || undefined,
        glAccountId,
        locationId: locationId || undefined,
        currencyCode,
        isDefault,
      };
      if (meta.bankMetadata) {
        Object.assign(payload, {
          bankCode: bankCode || undefined,
          bankName: bankCode ? undefined : bankName.trim() || undefined,
          bankBranchName: bankBranchName.trim() || undefined,
          accountHolder: accountHolder.trim() || undefined,
          accountNumber: accountNumber.trim() || undefined,
          cardNumber: cardNumber.trim() || undefined,
          iban: iban.trim() || undefined,
        });
      }
      if (meta.pspMetadata) {
        Object.assign(payload, {
          pspProvider: pspProvider.trim() || undefined,
          terminalNumber: terminalNumber.trim() || undefined,
          merchantNumber: merchantNumber.trim() || undefined,
          settlementAccountId: settlementAccountId || undefined,
          settlementDelayDays: settlementDelayDays.trim() ? Number(settlementDelayDays) : undefined,
        });
      }
      const { ok, data, status } = await api<{ error?: string; account?: { name: string } }>(
        "/api/setup/opening/financial-accounts",
        { method: "POST", body: JSON.stringify(payload) },
      );
      if (!ok) {
        setError(
          financialAccountErrorMessage(data.error) ??
            (status === 403
              ? "برای ثبت حساب مالی، دسترسی «مدیریت حساب‌های مالی» لازم است."
              : status === 409 && data.error === "accounting_not_enabled"
                ? "برنامهٔ حسابداری برای این کسب‌وکار فعال نیست."
                : "ثبت حساب مالی ممکن نشد."),
        );
        return;
      }
      setName("");
      setCode("");
      setAccountNumber("");
      setCardNumber("");
      setIban("");
      setTerminalNumber("");
      setMerchantNumber("");
      onSaved();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  const glEmpty = glOptions !== null && glOptions.length === 0;

  return (
    <WizardSheet open={open} title={`${meta.label} تازه`} description={meta.description} busy={busy} onClose={onClose}>
      <ErrorBox>{error}</ErrorBox>

      {glEmpty ? (
        <InfoBox>
          هیچ سرفصل آزادی برای «{meta.plural}» نمانده است. هر حساب مالی باید سرفصل اختصاصی خودش را داشته باشد
          {canManageChart ? "؛ یک سرفصل تفصیلی بسازید و دوباره همین فرم را باز کنید." : "؛ از مالک یا حسابدار بخواهید سرفصل تازه بسازد."}
        </InfoBox>
      ) : null}
      {glError ? <ErrorBox>{glError}</ErrorBox> : null}

      <Field label="نام حساب">
        <input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} placeholder="مثلاً بانک ملت — حساب جاری" />
      </Field>

      <Field label="سرفصل دفتر کل" hint="هر سرفصل فقط به یک حساب مالی وصل می‌شود.">
        <SearchableSelect
          className={inputClass}
          value={glAccountId}
          onChange={setGlAccountId}
          ariaLabel="سرفصل دفتر کل"
          options={[
            { value: "", label: glOptions === null ? "در حال خواندن سرفصل‌ها…" : "انتخاب سرفصل" },
            ...(glOptions ?? []).map((option) => ({ value: option.id, label: `${option.code} — ${option.name}` })),
          ]}
        />
      </Field>
      {glEmpty && canManageChart ? (
        <div className="-mt-2 mb-4">
          <SecondaryButton onClick={onAddGl} disabled={busy}>
            افزودن سرفصل تفصیلی
          </SecondaryButton>
        </div>
      ) : null}

      <div className="grid gap-x-3 sm:grid-cols-2">
        <Field label="شعبه" hint="خالی یعنی حساب کل کسب‌وکار.">
          <SearchableSelect
            className={inputClass}
            value={locationId}
            onChange={setLocationId}
            ariaLabel="شعبه"
            options={[{ value: "", label: "همهٔ شعبه‌ها" }, ...locations.map((location) => ({ value: location.id, label: location.name }))]}
          />
        </Field>
        <Field label="ارز">
          <SearchableSelect
            className={inputClass}
            value={currencyCode}
            onChange={setCurrencyCode}
            ariaLabel="ارز"
            options={currencies.map((code) => ({ value: code, label: code }))}
          />
        </Field>
      </div>

      {meta.bankMetadata ? (
        <fieldset className="grid gap-x-3 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-medium text-foreground">اطلاعات بانکی</legend>
          <Field label="بانک">
            <SearchableSelect
              className={inputClass}
              value={bankCode}
              onChange={setBankCode}
              ariaLabel="بانک"
              options={[{ value: "", label: "انتخاب بانک" }, ...IRANIAN_BANKS.map((bank) => ({ value: bank.code, label: bank.name }))]}
            />
          </Field>
          {!bankCode ? (
            <Field label="نام بانک" hint="اگر بانک در فهرست نیست، نامش را بنویسید.">
              <input className={inputClass} value={bankName} onChange={(event) => setBankName(event.target.value)} />
            </Field>
          ) : null}
          <Field label="شعبهٔ بانک">
            <input className={inputClass} value={bankBranchName} onChange={(event) => setBankBranchName(event.target.value)} />
          </Field>
          <Field label="صاحب حساب">
            <input className={inputClass} value={accountHolder} onChange={(event) => setAccountHolder(event.target.value)} />
          </Field>
          <Field label="شمارهٔ حساب">
            <input className={inputClass} dir="ltr" value={accountNumber} onChange={(event) => setAccountNumber(event.target.value)} />
          </Field>
          <Field label="شمارهٔ کارت (اختیاری)" hint="۱۶ رقم؛ فقط برای شناسایی، نه رمز.">
            <input className={inputClass} dir="ltr" value={cardNumber} onChange={(event) => setCardNumber(event.target.value)} />
          </Field>
          <Field label="شبا (اختیاری)" hint="با IR و ۲۴ رقم.">
            <input className={inputClass} dir="ltr" value={iban} onChange={(event) => setIban(event.target.value)} />
          </Field>
        </fieldset>
      ) : null}

      {meta.pspMetadata ? (
        <fieldset className="grid gap-x-3 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-medium text-foreground">اطلاعات پایانه</legend>
          <Field label="ارائه‌دهندهٔ خدمات (PSP)">
            <input className={inputClass} value={pspProvider} onChange={(event) => setPspProvider(event.target.value)} placeholder="مثلاً به‌پرداخت" />
          </Field>
          <Field label="شمارهٔ پایانه">
            <input className={inputClass} dir="ltr" value={terminalNumber} onChange={(event) => setTerminalNumber(event.target.value)} />
          </Field>
          <Field label="شمارهٔ پذیرنده">
            <input className={inputClass} dir="ltr" value={merchantNumber} onChange={(event) => setMerchantNumber(event.target.value)} />
          </Field>
          <Field label="مهلت تسویه (روز)" hint="T+N؛ مثلاً ۱ برای روز بعد.">
            <PersianNumberInput
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={settlementDelayDays}
              onChange={(event) => setSettlementDelayDays(event.target.value)}
            />
          </Field>
          <Field label="حساب بانکی تسویه" hint="پایانه‌ها می‌توانند به یک بانک تسویه شوند.">
            {banks.length === 0 ? (
              <div>
                <p className="mb-1 text-sm text-muted-foreground">
                  ابتدا یک حساب بانکی بسازید؛ سپس پایانه را به آن وصل کنید.
                </p>
                <SecondaryButton onClick={onAddBank} disabled={busy}>
                  افزودن حساب بانکی
                </SecondaryButton>
              </div>
            ) : (
              <SearchableSelect
                className={inputClass}
                value={settlementAccountId}
                onChange={setSettlementAccountId}
                ariaLabel="حساب بانکی تسویه"
                options={[{ value: "", label: "انتخاب حساب بانکی" }, ...banks.map((bank) => ({ value: bank.id, label: bank.name }))]}
              />
            )}
          </Field>
        </fieldset>
      ) : null}

      <label className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
        <input type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} />
        حساب پیش‌فرض این نوع
      </label>
      <p className="mb-2 text-xs text-muted-foreground">
        رمز کارت، CVV و گذرواژهٔ بانکی هرگز گرفته نمی‌شود.
      </p>

      <SheetFooter className="px-0">
        <PrimaryButton
          type="button"
          onClick={save}
          disabled={busy || glEmpty || (kind === "pos_psp" && banks.length === 0)}
        >
          {busy ? "در حال ذخیره…" : "ثبت حساب"}
        </PrimaryButton>
        <SecondaryButton onClick={onClose} disabled={busy}>
          انصراف
        </SecondaryButton>
      </SheetFooter>
    </WizardSheet>
  );
}
