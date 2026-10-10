"use client";

/**
 * «ارز و تسعیر» — the multicurrency workspace (issue #863).
 *
 * One section, five tabs, because these five things are one job done in
 * sequence: configure the currencies and their rates, post a foreign
 * document, settle it later at a different rate, restate what is still open,
 * and read the results. Splitting them across five menu entries would hide
 * the sequence; one screen keeps it visible.
 *
 * The arithmetic on this screen is the SERVER's arithmetic: the document
 * preview and the settlement preview run through the same pure functions the
 * posting service uses (`@/lib/multicurrency`), so what the person confirms
 * is what the ledger books — the preview cannot drift from the posting
 * because they are the same code.
 */

import { LoadingSkeleton, StatusBadge, cardClass } from "@/app/dashboard/page-chrome";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { api, ErrorBox, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useMoney } from "@/components/money/money-context";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali, todayIsoDate } from "@/lib/jalali";
import {
  buildMulticurrencyDocument,
  consumeOpenLots,
  convertToBaseMinor,
  minorToMajorText,
  type ForeignOpenLot,
  type MulticurrencyLineInput,
} from "@/lib/multicurrency";
import { errorMessage } from "./accounting-errors";
import type { AccountRow, Runner } from "./accounting-manager";

type TabKey = "settings" | "documents" | "settlement" | "revaluation" | "reports";

const TABS: { key: TabKey; label: string }[] = [
  { key: "settings", label: "ارزها و نرخ‌ها" },
  { key: "documents", label: "سند ارزی" },
  { key: "settlement", label: "تسویه ارزی" },
  { key: "revaluation", label: "تجدید ارزیابی" },
  { key: "reports", label: "گزارش‌های ارزی" },
];

interface CurrencyRecord {
  code: string;
  name: string;
  symbol: string | null;
  precision: number;
  isActive: boolean;
}

interface BusinessCurrencyConfig {
  baseCurrencyCode: string;
  baseCurrency: CurrencyRecord | null;
  transactionCurrencies: (CurrencyRecord & { allowed: boolean })[];
}

interface RateRecord {
  id: string;
  currencyCode: string;
  rate: string;
  effectiveFrom: string;
  source: string;
  voidedAt: string | null;
}

interface OpenLot {
  lineId: string;
  entryId: string;
  entryDate: string;
  foreignRemaining: string;
  baseRemaining: string;
}

interface RevaluationPreview {
  currencyCode: string;
  asOf: string;
  rate: string;
  totalGain: string;
  totalLoss: string;
  lines: {
    accountId: string;
    foreignBalance: string;
    bookBaseBalance: string;
    newBaseValue: string;
    difference: string;
  }[];
}

const REPORT_KINDS: { key: string; label: string }[] = [
  { key: "trial_balance", label: "تراز آزمایشی ارزی" },
  { key: "statement", label: "صورتحساب حساب" },
  { key: "party_balances", label: "مانده اشخاص ارزی" },
  { key: "gain_loss", label: "سود و زیان تحقق‌یافته تسعیر" },
  { key: "exposure", label: "مواجهه ارزی" },
  { key: "foreign_banks", label: "بانک‌های ارزی" },
];

/** Foreign major-unit text (`120.50`, Persian digits tolerated) → minor text, or null. */
function majorToMinorText(input: string, precision: number): string | null {
  const trimmed = input.trim().replace(/,/g, "").replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
  if (!new RegExp(`^(0|[1-9]\\d*)(\\.\\d{1,${Math.max(precision, 1)}})?$`).test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  return (whole + frac.padEnd(precision, "0").slice(0, precision)) || "0";
}

/** One shared loader: the catalogue + this business's currency configuration. */
function useCurrencyCatalogue() {
  const [currencies, setCurrencies] = useState<CurrencyRecord[]>([]);
  const [config, setConfig] = useState<BusinessCurrencyConfig | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    api<{ currencies: CurrencyRecord[]; config: BusinessCurrencyConfig }>("/api/currencies")
      .then((res) => {
        if (!alive) return;
        if (!res.ok) {
          setFailed(true);
          return;
        }
        setCurrencies(res.data.currencies);
        setConfig(res.data.config);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);
  return { currencies, config, failed };
}

/** The latest live rate for one currency, as state (null until loaded). */
function useLatestRate(currencyCode: string | null): { rate: string | null; loading: boolean } {
  const [rate, setRate] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setRate(null);
    if (!currencyCode) return;
    let alive = true;
    setLoading(true);
    api<{ rates: RateRecord[] }>(`/api/currencies/rates?currency=${currencyCode}&limit=5`)
      .then((res) => {
        if (!alive) return;
        const live = res.data.rates?.find((r) => !r.voidedAt);
        setRate(live ? live.rate : null);
      })
      .catch(() => alive && setRate(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [currencyCode]);
  return { rate, loading };
}

export function MulticurrencySection({
  accounts,
  busy,
  run,
}: {
  accounts: AccountRow[];
  busy: boolean;
  run: Runner;
}) {
  const [tab, setTab] = useState<TabKey>("settings");
  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="بخش‌های ارز و تسعیر" className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              tab === t.key
                ? "bg-teal-600 text-white"
                : "bg-black/5 text-stone-700 hover:bg-black/10 dark:bg-white/10 dark:text-stone-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "settings" ? <SettingsTab busy={busy} run={run} /> : null}
      {tab === "documents" ? <DocumentsTab accounts={accounts} busy={busy} run={run} /> : null}
      {tab === "settlement" ? <SettlementTab accounts={accounts} busy={busy} run={run} /> : null}
      {tab === "revaluation" ? <RevaluationTab busy={busy} run={run} /> : null}
      {tab === "reports" ? <ReportsTab accounts={accounts} /> : null}
    </div>
  );
}

/**
 * Reversal for an FX document/settlement this screen just produced: the API
 * endpoint exists (`POST /entries/[id]/reverse`) but no surface called it, so
 * a mistaken posting or settlement was only correctable from raw API calls.
 * Succeeding replaces the control with the reversal's own entry id.
 */
function ReverseEntryButton({
  entryId,
  busy,
  label,
  onReversed,
}: {
  entryId: string;
  busy: boolean;
  label: string;
  onReversed: (reversalEntryId: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const reverse = () => {
    setError(null);
    void (async () => {
      const res = await api<{ entryId: string; error?: string }>(`/api/ledger/multicurrency/entries/${entryId}/reverse`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (res.ok) onReversed(res.data.entryId);
      else setError(errorMessage((res.data as { error?: string }).error));
    })();
  };
  return (
    <span className="inline-flex flex-col gap-1">
      <SecondaryButton onClick={reverse} disabled={busy}>
        {label}
      </SecondaryButton>
      {error ? (
        <span role="alert" className="text-xs text-red-700 dark:text-red-300">
          {error}
        </span>
      ) : null}
    </span>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200"
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings & rates
// ---------------------------------------------------------------------------

function SettingsTab({ busy, run }: { busy: boolean; run: Runner }) {
  const { config, failed } = useCurrencyCatalogue();
  const [ratesCurrency, setRatesCurrency] = useState("");
  const [rates, setRates] = useState<RateRecord[]>([]);
  const [newRate, setNewRate] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!ratesCurrency && config) {
      setRatesCurrency(config.transactionCurrencies.find((c) => c.allowed)?.code ?? "");
    }
  }, [config, ratesCurrency]);

  const loadRates = useCallback(async (code: string) => {
    if (!code) return;
    const res = await api<{ rates: RateRecord[] }>(`/api/currencies/rates?currency=${code}&limit=50`);
    if (res.ok) setRates(res.data.rates);
  }, []);

  useEffect(() => {
    loadRates(ratesCurrency).catch(() => setRates([]));
  }, [ratesCurrency, loadRates]);

  if (failed) return <ErrorBox>تنظیمات ارز بارگیری نشد.</ErrorBox>;
  if (!config) return <LoadingSkeleton rows={4} />;

  const toggleCurrency = (code: string, allowed: boolean) => {
    const next = config.transactionCurrencies
      .filter((c) => (c.code === code ? allowed : c.allowed))
      .map((c) => c.code);
    setNotice(null);
    return run(async () => {
      const res = await api<{ config: BusinessCurrencyConfig; error?: string }>("/api/currencies/settings", {
        method: "PUT",
        body: JSON.stringify({ baseCurrencyCode: config.baseCurrencyCode, transactionCurrencyCodes: next }),
      });
      if (res.ok) {
        setNotice(allowed ? `${code} فعال شد.` : `${code} خاموش شد؛ سابقهٔ اسناد آن باقی می‌ماند.`);
      }
      return res;
    });
  };

  const recordRate = () => {
    if (!ratesCurrency || !newRate.trim()) return;
    setNotice(null);
    return run(async () => {
      const res = await api<{ rate: RateRecord; error?: string }>("/api/currencies/rates", {
        method: "POST",
        body: JSON.stringify({ currencyCode: ratesCurrency, rate: newRate.trim() }),
      });
      if (res.ok) {
        setNewRate("");
        setNotice("نرخ ثبت شد و از این لحظه برای اسناد جدید به کار می‌رود.");
        await loadRates(ratesCurrency);
      }
      return res;
    });
  };

  const voidRate = (id: string) => {
    setNotice(null);
    return run(async () => {
      const res = await api<{ rate: RateRecord; error?: string }>(`/api/currencies/rates/${id}/void`, {
        method: "POST",
        body: JSON.stringify({ reason: "ابطال دستی" }),
      });
      if (res.ok) {
        setNotice("نرخ باطل شد؛ اسناد ثبت‌شده با همان نرخ باقی می‌مانند.");
        await loadRates(ratesCurrency);
      }
      return res;
    });
  };

  return (
    <div className="space-y-4">
      {notice ? <Notice>{notice}</Notice> : null}

      <section className={cardClass}>
        <h3 className="mb-1 text-sm font-semibold">ارز پایه</h3>
        <p className="text-sm text-stone-600 dark:text-stone-300">
          همهٔ دفاتر به <strong>{config.baseCurrency?.name ?? config.baseCurrencyCode}</strong> («
          {config.baseCurrencyCode}») نگه‌داری می‌شوند. با سابقهٔ اسناد ارزی، تغییر ارز پایه قفل است و تاریخ
          بازنویسی نمی‌شود.
        </p>
      </section>

      <section className={cardClass}>
        <h3 className="mb-2 text-sm font-semibold">ارزهای معامله</h3>
        <ul className="divide-y divide-black/5 dark:divide-white/10">
          {config.transactionCurrencies.map((c) => (
            <li key={c.code} className="flex items-center justify-between gap-3 py-2">
              <span className="text-sm">
                <strong>{c.code}</strong> — {c.name}
                <span className="ms-2 text-xs text-muted-foreground">دقت: {toPersianDigits(c.precision)} رقم اعشار</span>
              </span>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={c.allowed}
                  disabled={busy}
                  onChange={(e) => void toggleCurrency(c.code, e.target.checked)}
                  aria-label={`فعال بودن ${c.code}`}
                />
                {c.allowed ? "فعال" : "خاموش"}
              </label>
            </li>
          ))}
        </ul>
      </section>

      <section className={cardClass}>
        <h3 className="mb-2 text-sm font-semibold">نرخ‌های تسعیر</h3>
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <label className="text-sm">
            <span className="mb-1 block">ارز</span>
            <select
              className={inputClass}
              value={ratesCurrency}
              onChange={(e) => setRatesCurrency(e.target.value)}
              aria-label="ارز نرخ"
            >
              {config.transactionCurrencies
                .filter((c) => c.allowed)
                .map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code} — {c.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block">نرخ جدید (ریال به ازای هر واحد ارز)</span>
            <input
              className={`${inputClass} w-40`}
              dir="ltr"
              inputMode="decimal"
              value={newRate}
              onChange={(e) => setNewRate(e.target.value)}
              placeholder="مثلاً 600000"
              aria-label="نرخ جدید"
            />
          </label>
          <PrimaryButton onClick={recordRate} disabled={busy || !newRate.trim()}>
            ثبت نرخ
          </PrimaryButton>
        </div>
        <DataTable caption="نرخ‌های تسعیر ثبت‌شده">
          <DataTableHead>
            <Th>نرخ (ریال)</Th>
            <Th>از لحظه</Th>
            <Th>منبع</Th>
            <Th>وضعیت</Th>
            <Th>
              <span className="sr-only">کنش</span>
            </Th>
          </DataTableHead>
          <DataTableBody>
            {rates.map((r) => (
              <DataTableRow key={r.id}>
                <Td numeric>
                  <span dir="ltr">{toPersianDigits(r.rate)}</span>
                </Td>
                <Td>{formatJalali(r.effectiveFrom.slice(0, 10))}</Td>
                <Td>{r.source === "manual" ? "دستی" : r.source}</Td>
                <Td>
                  <StatusBadge tone={r.voidedAt ? "danger" : "positive"}>{r.voidedAt ? "باطل‌شده" : "معتبر"}</StatusBadge>
                </Td>
                <Td>
                  {!r.voidedAt ? (
                    <SecondaryButton onClick={() => void voidRate(r.id)} disabled={busy}>
                      ابطال
                    </SecondaryButton>
                  ) : null}
                </Td>
              </DataTableRow>
            ))}
            {rates.length === 0 ? (
              <DataTableRow>
                <Td>هنوز نرخی برای این ارز ثبت نشده است.</Td>
              </DataTableRow>
            ) : null}
          </DataTableBody>
        </DataTable>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Foreign documents
// ---------------------------------------------------------------------------

interface DocLineDraft {
  accountId: string;
  side: "debit" | "credit";
  amount: string;
}

const EMPTY_LINES: DocLineDraft[] = [
  { accountId: "", side: "debit", amount: "" },
  { accountId: "", side: "credit", amount: "" },
];

function DocumentsTab({
  accounts,
  busy,
  run,
}: {
  accounts: AccountRow[];
  busy: boolean;
  run: Runner;
}) {
  const money = useMoney();
  const { currencies, config } = useCurrencyCatalogue();
  const [currencyCode, setCurrencyCode] = useState("");
  const [entryDate, setEntryDate] = useState(todayIsoDate());
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<DocLineDraft[]>(EMPTY_LINES);
  const [posted, setPosted] = useState<{ entryId: string; foreignTotal: string; baseTotal: string } | null>(null);
  // The invoice's party — the settlement screen resolves open items through
  // the party attribution on the A/R (or A/P) line, so a document posted
  // without one can never be settled. The field stamps every CONTROL line
  // (the 1200/2100 legs); revenue/expense legs stay unattributed.
  const [partyId, setPartyId] = useState("");

  useEffect(() => {
    if (!currencyCode && config) {
      setCurrencyCode(config.transactionCurrencies.find((c) => c.allowed)?.code ?? "");
    }
  }, [config, currencyCode]);

  const { rate, loading: rateLoading } = useLatestRate(currencyCode || null);
  const currency = currencies.find((c) => c.code === currencyCode);
  const precision = currency?.precision ?? 2;

  /** The live preview — the server's own builder over the typed lines. */
  const preview = useMemo(() => {
    if (!currency) return { state: "waiting" as const };
    if (!rate) return { state: rateLoading ? ("waiting" as const) : ("no_rate" as const) };
    const inputs: MulticurrencyLineInput[] = [];
    for (const line of lines) {
      if (!line.accountId && !line.amount) continue;
      const minor = majorToMinorText(line.amount, precision);
      if (minor === null) return { state: "amount" as const };
      if (!line.accountId) return { state: "account" as const };
      inputs.push({ accountId: line.accountId, side: line.side, foreignMinor: BigInt(minor) });
    }
    if (inputs.length === 0) return { state: "waiting" as const };
    const built = buildMulticurrencyDocument(inputs, rate, precision);
    if (!built.ok) return { state: "problem" as const, problem: built.problem };
    return { state: "ok" as const, value: built.value, rate };
  }, [lines, currency, rate, rateLoading, precision]);

  const post = () => {
    if (preview.state !== "ok") return;
    setPosted(null);
    return run(async () => {
      const res = await api<{ entryId: string; foreignTotal: string; baseTotal: string; error?: string }>(
        "/api/ledger/multicurrency/entries",
        {
          method: "POST",
          body: JSON.stringify({
            currencyCode,
            rateId: null,
            entryDate,
            memo,
            lines: postLines(),
          }),
        },
      );
      if (res.ok) {
        setPosted({ entryId: res.data.entryId, foreignTotal: res.data.foreignTotal, baseTotal: res.data.baseTotal });
        setLines(EMPTY_LINES);
        setMemo("");
        setPartyId("");
      }
      return res;
    });
  };

  const postable = accounts.filter((a) => a.is_postable !== false);
  // Control accounts are the ones whose balance IS somebody's open item.
  const CONTROL_CODES = new Set(["1200", "2100"]);
  const postLines = () =>
    lines
      .filter((l) => l.accountId && l.amount)
      .map((l) => ({
        accountId: l.accountId,
        side: l.side,
        foreignAmount: majorToMinorText(l.amount, precision),
        // `code` rides only for the attribution decision below.
        ...(CONTROL_CODES.has(accounts.find((a) => a.id === l.accountId)?.code ?? "") && partyId
          ? { partyId }
          : {}),
      }));

  return (
    <div className="space-y-4">
      {posted ? (
        <Notice>
          سند ثبت شد — ارزی {toPersianDigits(minorToMajorText(BigInt(posted.foreignTotal), precision))}{" "}
          {currencyCode}، معادل {money.formatText(posted.baseTotal, { withUnit: true })}.{" "}
          <ReverseEntryButton
            entryId={posted.entryId}
            busy={busy}
            label="برگشت سند"
            onReversed={(reversalId) =>
              setPosted({
                entryId: reversalId,
                foreignTotal: posted.foreignTotal,
                baseTotal: posted.baseTotal,
              })
            }
          />
        </Notice>
      ) : null}

      <section className={cardClass}>
        <div className="mb-3 flex flex-wrap gap-3">
          <label className="text-sm">
            <span className="mb-1 block">ارز سند</span>
            <select className={inputClass} value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value)}>
              {currencies.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} — {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block">تاریخ سند</span>
            <JalaliDatePicker value={entryDate} onChange={setEntryDate} />
          </label>
          <div className="text-sm">
            <span className="mb-1 block">طرف حساب (اختیاری — برای اقلام باز)</span>
            <PartyPicker onPick={setPartyId} direction="receivable" />
          </div>
          <label className="grow text-sm">
            <span className="mb-1 block">شرح</span>
            <input
              className={inputClass}
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="مثلاً: فروش ارزی به شرکت آلفا"
            />
          </label>
        </div>

        <table className="w-full text-sm">
          <caption className="sr-only">سطرهای سند ارزی</caption>
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th scope="col" className="p-1 text-start">حساب</th>
              <th scope="col" className="p-1 text-start">بدهکار / بستانکار</th>
              <th scope="col" className="p-1 text-start">مبلغ ({currencyCode || "ارز"})</th>
              <th scope="col">
                <span className="sr-only">حذف</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => (
              <tr key={i}>
                <td className="p-1">
                  <SearchableSelect
                    value={line.accountId}
                    onChange={(v) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, accountId: v } : l)))}
                    options={postable.map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` }))}
                    placeholder="انتخاب حساب"
                    ariaLabel={`حساب سطر ${toPersianDigits(i + 1)}`}
                  />
                </td>
                <td className="p-1">
                  <select
                    className={inputClass}
                    value={line.side}
                    onChange={(e) =>
                      setLines((ls) =>
                        ls.map((l, j) => (j === i ? { ...l, side: e.target.value as "debit" | "credit" } : l)),
                      )
                    }
                    aria-label={`سمت سطر ${toPersianDigits(i + 1)}`}
                  >
                    <option value="debit">بدهکار</option>
                    <option value="credit">بستانکار</option>
                  </select>
                </td>
                <td className="p-1">
                  <input
                    className={`${inputClass} w-36`}
                    dir="ltr"
                    inputMode="decimal"
                    value={line.amount}
                    onChange={(e) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, amount: e.target.value } : l)))}
                    aria-label={`مبلغ سطر ${toPersianDigits(i + 1)}`}
                  />
                </td>
                <td className="p-1">
                  {lines.length > 2 ? (
                    <button
                      type="button"
                      className="text-red-600 dark:text-red-400"
                      onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                      aria-label={`حذف سطر ${toPersianDigits(i + 1)}`}
                    >
                      حذف
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button
          type="button"
          className="mt-2 text-sm text-teal-700 underline dark:text-teal-300"
          onClick={() => setLines((ls) => [...ls, { accountId: "", side: "credit", amount: "" }])}
        >
          افزودن سطر
        </button>

        <div className="mt-3 rounded-lg bg-black/5 p-3 text-sm dark:bg-white/10" aria-live="polite">
          {preview.state === "waiting" ? (
            <span className="text-muted-foreground">ارز، نرخ و سطرها را کامل کنید تا پیش‌نمایش محاسبه شود.</span>
          ) : preview.state === "no_rate" ? (
            <span className="text-amber-700 dark:text-amber-300">
              برای این ارز نرخ فعالی ثبت نشده است — نخست در «ارزها و نرخ‌ها» نرخ ثبت کنید.
            </span>
          ) : preview.state === "amount" ? (
            <span className="text-amber-700 dark:text-amber-300">مبلغ سطرها معتبر نیست.</span>
          ) : preview.state === "account" ? (
            <span className="text-amber-700 dark:text-amber-300">حساب سطرها را انتخاب کنید.</span>
          ) : preview.state === "ok" && preview.value ? (
            <span>
              جمع ارزی {toPersianDigits(minorToMajorText(preview.value.foreignTotal, precision))} {currencyCode} ·
              معادل {money.formatText(preview.value.baseTotal.toString(), { withUnit: true })} · نرخ{" "}
              <span dir="ltr">{toPersianDigits(preview.rate)}</span>
              {preview.value.roundingDelta !== 0n
                ? ` · اختلاف گرد کردن ${money.formatText(preview.value.roundingDelta.toString())}`
                : ""}
            </span>
          ) : null}
        </div>

        <div className="mt-3">
          <PrimaryButton onClick={post} disabled={busy || preview.state !== "ok"}>
            ثبت سند ارزی
          </PrimaryButton>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

function SettlementTab({
  accounts,
  busy,
  run,
}: {
  accounts: AccountRow[];
  busy: boolean;
  run: Runner;
}) {
  const money = useMoney();
  const { currencies, config } = useCurrencyCatalogue();
  const [direction, setDirection] = useState<"receivable" | "payable">("receivable");
  const [partyId, setPartyId] = useState("");
  const [currencyCode, setCurrencyCode] = useState("");
  const [lots, setLots] = useState<OpenLot[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [amount, setAmount] = useState("");
  const [bankAccountId, setBankAccountId] = useState("");
  const [memo, setMemo] = useState("");
  const [done, setDone] = useState<{ entryId: string; difference: string } | null>(null);
  const [loadingLots, setLoadingLots] = useState(false);

  useEffect(() => {
    if (!currencyCode && config) {
      setCurrencyCode(config.transactionCurrencies.find((c) => c.allowed)?.code ?? "");
    }
  }, [config, currencyCode]);

  const { rate, loading: rateLoading } = useLatestRate(currencyCode || null);
  const precision = currencies.find((c) => c.code === currencyCode)?.precision ?? 2;
  const postable = accounts.filter((a) => a.is_postable !== false);

  const loadLots = useCallback(async () => {
    if (!partyId || !currencyCode) {
      setLots([]);
      return;
    }
    setLoadingLots(true);
    try {
      const res = await api<{ lots: OpenLot[] }>(
        `/api/ledger/multicurrency/settlements/lots?direction=${direction}&currency=${currencyCode}&partyId=${partyId}`,
      );
      setLots(res.ok ? res.data.lots : []);
      setSelected(new Set());
    } catch {
      setLots([]);
    } finally {
      setLoadingLots(false);
    }
  }, [direction, currencyCode, partyId]);

  useEffect(() => {
    loadLots();
  }, [loadLots]);

  /** The exact settlement preview — the server's own lot consumer. */
  const preview = useMemo(() => {
    if (!rate) return { state: rateLoading ? ("waiting" as const) : ("no_rate" as const) };
    if (lots.length === 0) return { state: "waiting" as const };
    const chosen =
      amount.trim() !== ""
        ? majorToMinorText(amount, precision)
        : [...selected].reduce(
            (sum, id) => sum + BigInt(lots.find((l) => l.lineId === id)?.foreignRemaining ?? "0"),
            0n,
          );
    if (chosen === null) return { state: "amount" as const };
    const chosenMinor = typeof chosen === "string" ? BigInt(chosen) : chosen;
    const lotInputs: ForeignOpenLot[] = lots
      .filter((l) => selected.size === 0 || selected.has(l.lineId))
      .map((l) => ({
        lineId: l.lineId,
        entryId: l.entryId,
        entryDate: l.entryDate,
        foreignRemaining: BigInt(l.foreignRemaining),
        baseRemaining: BigInt(l.baseRemaining),
      }));
    const consumed = consumeOpenLots(lotInputs, chosenMinor);
    if (!consumed.ok) return { state: "problem" as const, problem: consumed.problem };
    const foreignApplied = consumed.value.reduce((s, a) => s + a.foreignApplied, 0n);
    const booked = consumed.value.reduce((s, a) => s + a.baseApplied, 0n);
    const settled = convertToBaseMinor(foreignApplied, rate, precision);
    // The obligation view — the same sign the server books.
    const difference = direction === "receivable" ? settled - booked : booked - settled;
    return {
      state: "ok" as const,
      foreignApplied: foreignApplied.toString(),
      booked: booked.toString(),
      settled: settled.toString(),
      difference: difference.toString(),
    };
  }, [amount, selected, lots, rate, rateLoading, precision, direction]);

  const submit = () => {
    if (preview.state !== "ok" || !bankAccountId) return;
            setDone(null);
    return run(async () => {
      /* Two submission modes, matching the API's XOR: an explicit amount goes
         as `autoAmount` (FIFO across the selection); an empty amount settles
         each selected lot IN FULL, which the wire expresses as per-lot
         `items` — sending both empty used to be a guaranteed 400, so the
         «empty = whole selection» mode advertised by the field could never
         actually submit. */
      const settleItems =
        amount.trim() !== ""
          ? []
          : [...selected].map((lineId) => {
              const lot = lots.find((l) => l.lineId === lineId);
              return { entryId: lot?.entryId ?? lineId, amount: lot?.foreignRemaining ?? "0" };
            });
      const res = await api<{ entryId: string; realizedDifference: string; error?: string }>(
        "/api/ledger/multicurrency/settlements", {
        method: "POST",
        body: JSON.stringify({
          direction,
          partyId,
          currencyCode,
          rateId: null,
          settlementAccountId: bankAccountId,
          autoAmount: amount.trim() !== "" ? majorToMinorText(amount, precision) : null,
          items: settleItems,
          entryDate: null,
          memo,
        }),
      });
      if (res.ok) {
        setDone({ entryId: res.data.entryId, difference: res.data.realizedDifference });
        setAmount("");
        setMemo("");
        await loadLots();
      }
      return res;
    });
  };

  return (
    <div className="space-y-4">
      {done ? (
        <Notice>
          تسویه ثبت شد —{" "}
          {done.difference.startsWith("-")
            ? `زیان تسعیر ${money.formatText(done.difference.slice(1), { withUnit: true })}`
            : done.difference !== "0"
              ? `سود تسعیر ${money.formatText(done.difference, { withUnit: true })}`
              : "بدون اثر تسعیر"}
          .{" "}
          <ReverseEntryButton
            entryId={done.entryId}
            busy={busy}
            label="برگشت تسویه"
            onReversed={(reversalId) => {
              setDone({ entryId: reversalId, difference: "0" });
              // The reversal re-opens the settled lot server-side; reload so
              // the open-items table shows it instead of the stale settled view.
              void loadLots();
            }}
          />
        </Notice>
      ) : null}

      <section className={cardClass}>
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block">جهت</span>
            <select
              className={inputClass}
              value={direction}
              onChange={(e) => setDirection(e.target.value as "receivable" | "payable")}
            >
              <option value="receivable">دریافت از مشتری</option>
              <option value="payable">پرداخت به تأمین‌کننده</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block">ارز</span>
            <select className={inputClass} value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value)}>
              {currencies.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code}
                </option>
              ))}
            </select>
          </label>
          <div className="text-sm">
            <span className="mb-1 block">طرف حساب</span>
            <PartyPicker onPick={setPartyId} direction={direction} />
          </div>
          <div className="text-sm">
            <span className="mb-1 block">حساب تسویه (بانک / صندوق)</span>
            <SearchableSelect
              value={bankAccountId}
              onChange={setBankAccountId}
              options={postable.map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` }))}
              placeholder="انتخاب حساب"
              ariaLabel="حساب تسویه"
            />
          </div>
        </div>

        {partyId && currencyCode ? (
          loadingLots ? (
            <LoadingSkeleton rows={2} />
          ) : lots.length === 0 ? (
            <p className="text-sm text-muted-foreground">قلم باز ارزی برای این طرف حساب در این ارز وجود ندارد.</p>
          ) : (
            <>
              <DataTable caption="اقلام باز ارزی">
                <DataTableHead>
                  <Th>انتخاب</Th>
                  <Th>سند</Th>
                  <Th>تاریخ</Th>
                  <Th>باقیمانده ارزی</Th>
                  <Th>مانده به نرخ ثبت</Th>
                </DataTableHead>
                <DataTableBody>
                  {lots.map((l) => (
                    <DataTableRow key={l.lineId}>
                      <Td>
                        <input
                          type="checkbox"
                          checked={selected.has(l.lineId)}
                          onChange={(e) =>
                            setSelected((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(l.lineId);
                              else next.delete(l.lineId);
                              return next;
                            })
                          }
                          aria-label={`انتخاب سند ${l.entryId.slice(0, 8)}`}
                        />
                      </Td>
                      <Td nowrap>
                        <span dir="ltr">{l.entryId.slice(0, 8)}</span>
                      </Td>
                      <Td>{formatJalali(l.entryDate)}</Td>
                      <Td numeric>
                        <span dir="ltr">{toPersianDigits(minorToMajorText(BigInt(l.foreignRemaining), precision))}</span>
                      </Td>
                      <Td numeric>{money.formatText(l.baseRemaining)}</Td>
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>
              <label className="mt-2 block text-sm">
                <span className="mb-1 block">مبلغ تسویه (خالی = کل انتخاب‌شده‌ها)</span>
                <input
                  className={`${inputClass} w-40`}
                  dir="ltr"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  aria-label="مبلغ تسویه"
                />
              </label>
              <label className="mt-2 block text-sm">
                <span className="mb-1 block">شرح</span>
                <input
                  className={inputClass}
                  value={memo}
                  onChange={(e) => setMemo(e.target.value)}
                  aria-label="شرح تسویه"
                />
              </label>
              <div className="mt-3 rounded-lg bg-black/5 p-3 text-sm dark:bg-white/10" aria-live="polite">
                {preview.state === "waiting" ? (
                  <span className="text-muted-foreground">انتخاب یا مبلغ را مشخص کنید.</span>
                ) : preview.state === "no_rate" ? (
                  <span className="text-amber-700 dark:text-amber-300">برای این ارز نرخ فعالی ثبت نشده است.</span>
                ) : preview.state === "amount" ? (
                  <span className="text-amber-700 dark:text-amber-300">مبلغ معتبر نیست.</span>
                ) : preview.state === "ok" && preview.foreignApplied ? (
                  <span>
                    تسویهٔ ارزی {toPersianDigits(minorToMajorText(BigInt(preview.foreignApplied), precision))}{" "}
                    {currencyCode} · به نرخ ثبت: {money.formatText(preview.booked)} · به نرخ امروز:{" "}
                    {money.formatText(preview.settled)} ·{" "}
                    {preview.difference.startsWith("-")
                      ? `زیان ${money.formatText(preview.difference.slice(1))}`
                      : preview.difference !== "0"
                        ? `سود ${money.formatText(preview.difference)}`
                        : "بدون اثر"}
                  </span>
                ) : null}
              </div>
              <div className="mt-3">
                <PrimaryButton onClick={submit} disabled={busy || preview.state !== "ok" || !bankAccountId}>
                  ثبت تسویه
                </PrimaryButton>
              </div>
            </>
          )
        ) : (
          <p className="text-sm text-muted-foreground">طرف حساب و ارز را انتخاب کنید تا اقلام باز بیاید.</p>
        )}
      </section>
    </div>
  );
}

function PartyPicker({
  onPick,
  direction,
}: {
  onPick: (id: string) => void;
  direction: "receivable" | "payable";
}) {
  const [options, setOptions] = useState<{ value: string; label: string }[]>([]);
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const t = setTimeout(() => {
      let alive = true;
      setLoading(true);
      api<{ parties?: { id: string; name: string }[]; items?: { id: string; name: string }[] }>(
        `/api/parties?q=${encodeURIComponent(query)}`,
      )
        .then((res) => {
          if (!alive) return;
          const rows = res.data.parties ?? res.data.items ?? [];
          setOptions(rows.map((p) => ({ value: p.id, label: p.name })));
        })
        .catch(() => alive && setOptions([]))
        .finally(() => alive && setLoading(false));
      return () => {
        alive = false;
      };
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  // The direction only names the screen the picker sits on; the server
  // resolves the party's open lots per direction.
  void direction;
  return (
    <SearchableSelect
      value={value}
      onChange={(v) => {
        setValue(v);
        onPick(v);
      }}
      onQueryChange={setQuery}
      options={options}
      loading={loading}
      placeholder="انتخاب طرف حساب"
      searchPlaceholder="نام طرف حساب…"
      emptyText="یافت نشد"
      ariaLabel="طرف حساب تسویه"
    />
  );
}

// ---------------------------------------------------------------------------
// Revaluation
// ---------------------------------------------------------------------------

function RevaluationTab({ busy, run }: { busy: boolean; run: Runner }) {
  const money = useMoney();
  const { config } = useCurrencyCatalogue();
  const [currencyCode, setCurrencyCode] = useState("");
  const [asOf, setAsOf] = useState(todayIsoDate());
  const [preview, setPreview] = useState<RevaluationPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!currencyCode && config) {
      setCurrencyCode(config.transactionCurrencies.find((c) => c.allowed)?.code ?? "");
    }
  }, [config, currencyCode]);

  const loadPreview = useCallback(async () => {
    if (!currencyCode || !asOf) return;
    setLoading(true);
    setError(null);
    setPreview(null);
    try {
      const res = await api<RevaluationPreview & { error?: string }>(
        `/api/ledger/multicurrency/revaluations/preview?currency=${currencyCode}&asOf=${asOf}`,
      );
      if (res.ok) setPreview(res.data);
      else setError(errorMessage((res.data as { error?: string }).error));
    } catch {
      setError(errorMessage("network_error"));
    } finally {
      setLoading(false);
    }
  }, [currencyCode, asOf]);

  const confirm = () => {
    if (!preview) return;
    setDone(null);
    return run(async () => {
      const res = await api<{ entryId: string | null; totalGain: string; totalLoss: string; error?: string }>(
        "/api/ledger/multicurrency/revaluations",
        {
          method: "POST",
          body: JSON.stringify({
            currencyCode,
            asOf,
            idempotencyKey: `reval-${currencyCode}-${asOf}-${Date.now()}`,
          }),
        },
      );
      if (res.ok) {
        setDone(
          res.data.entryId
            ? `تجدید ارزیابی ثبت شد — سود ${money.formatText(res.data.totalGain, { withUnit: true })}، زیان ${money.formatText(res.data.totalLoss, { withUnit: true })}.`
            : "در این تاریخ چیزی برای بازارزش‌گذاری نبود؛ سندی ثبت نشد.",
        );
        setPreview(null);
      }
      return res;
    });
  };

  return (
    <div className="space-y-4">
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {done ? <Notice>{done}</Notice> : null}
      <section className={cardClass}>
        <p className="mb-3 text-sm text-stone-600 dark:text-stone-300">
          ماندهٔ حساب‌های ارزی تا پایان تاریخ انتخاب‌شده به نرخ همان روز بازارزش‌گذاری می‌شود؛ تفاوت از طریق سود
          (۴۹۳۵) و زیان (۵۸۷۵) تسعیر تحقق‌نیافته ثبت می‌گردد. اسناد قبلی هرگز بازنویسی نمی‌شوند.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block">ارز</span>
            <select className={inputClass} value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value)}>
              {(config?.transactionCurrencies.filter((c) => c.allowed) ?? []).map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} — {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block">تا تاریخ</span>
            <JalaliDatePicker value={asOf} onChange={setAsOf} />
          </label>
          <SecondaryButton onClick={() => void loadPreview()} disabled={loading || !currencyCode}>
            پیش‌نمایش
          </SecondaryButton>
        </div>

        {loading ? <LoadingSkeleton rows={3} /> : null}
        {preview ? (
          preview.lines.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">در این تاریخ چیزی برای بازارزش‌گذاری نیست.</p>
          ) : (
            <>
              <DataTable caption="پیش‌نمایش تجدید ارزیابی">
                <DataTableHead>
                  <Th>حساب</Th>
                  <Th>مانده ارزی</Th>
                  <Th>ارزش دفتری</Th>
                  <Th>ارزش جدید</Th>
                  <Th>اثر</Th>
                </DataTableHead>
                <DataTableBody>
                  {preview.lines.map((l) => (
                    <DataTableRow key={l.accountId}>
                      <Td nowrap>
                        <span dir="ltr">{l.accountId.slice(0, 8)}</span>
                      </Td>
                      <Td numeric>
                        <span dir="ltr">{toPersianDigits(l.foreignBalance)}</span>
                      </Td>
                      <Td numeric>{money.formatText(l.bookBaseBalance)}</Td>
                      <Td numeric>{money.formatText(l.newBaseValue)}</Td>
                      <Td numeric>
                        {l.difference.startsWith("-") ? (
                          <span className="text-red-700 dark:text-red-300">
                            زیان {money.formatText(l.difference.slice(1))}
                          </span>
                        ) : (
                          <span className="text-emerald-700 dark:text-emerald-300">
                            سود {money.formatText(l.difference)}
                          </span>
                        )}
                      </Td>
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>
              <div className="mt-3">
                <PrimaryButton onClick={confirm} disabled={busy}>
                  ثبت تجدید ارزیابی
                </PrimaryButton>
              </div>
            </>
          )
        ) : null}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

function ReportsTab({ accounts }: { accounts: AccountRow[] }) {
  const money = useMoney();
  const [kind, setKind] = useState("trial_balance");
  const [accountId, setAccountId] = useState("");
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [columns, setColumns] = useState<{ key: string; label: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (kind === "statement" && !accountId) {
      setRows([]);
      setColumns([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ kind });
      if (kind === "statement" && accountId) params.set("accountId", accountId);
      const res = await api<Record<string, unknown> & { error?: string }>(`/api/ledger/multicurrency/reports?${params}`);
      if (!res.ok) {
        setError(errorMessage((res.data as { error?: string }).error));
        setRows([]);
        setColumns([]);
        return;
      }
      const shaped = shapeReport(kind, res.data);
      setColumns(shaped.columns);
      setRows(shaped.rows);
    } catch {
      setError(errorMessage("network_error"));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [kind, accountId]);

  useEffect(() => {
    load();
  }, [load]);

  const exportCsv = () => {
    const header = columns.map((c) => c.label).join(",");
    const body = rows
      .map((r) => columns.map((c) => `"${String(r[c.key] ?? "").replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([`\uFEFF${header}\n${body}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `multicurrency-${kind}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      <section className={cardClass}>
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block">گزارش</span>
            <select className={inputClass} value={kind} onChange={(e) => setKind(e.target.value)}>
              {REPORT_KINDS.map((k) => (
                <option key={k.key} value={k.key}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          {kind === "statement" ? (
            <div className="text-sm">
              <span className="mb-1 block">حساب</span>
              <SearchableSelect
                value={accountId}
                onChange={setAccountId}
                options={accounts.map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` }))}
                placeholder="انتخاب حساب"
                ariaLabel="حساب صورت‌حساب"
              />
            </div>
          ) : null}
          <SecondaryButton onClick={exportCsv} disabled={rows.length === 0}>
            دریافت CSV
          </SecondaryButton>
        </div>
        {loading ? (
          <LoadingSkeleton rows={4} />
        ) : columns.length > 0 ? (
          <div className="overflow-x-auto">
            <DataTable caption="گزارش ارزی">
              <DataTableHead>
                {columns.map((c) => (
                  <Th key={c.key}>{c.label}</Th>
                ))}
              </DataTableHead>
              <DataTableBody>
                {rows.map((r, i) => (
                  <DataTableRow key={i}>
                    {columns.map((c) => (
                      <Td key={c.key} numeric={isMoneyKey(c.key)}>
                        {formatCell(r[c.key], c.key, money)}
                      </Td>
                    ))}
                  </DataTableRow>
                ))}
                {rows.length === 0 ? (
                  <DataTableRow>
                    <Td>داده‌ای برای این گزارش نیست.</Td>
                  </DataTableRow>
                ) : null}
              </DataTableBody>
            </DataTable>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {kind === "statement" ? "برای صورت‌حساب، نخست حساب را انتخاب کنید." : "گزارش را انتخاب کنید."}
          </p>
        )}
      </section>
    </div>
  );
}

function isMoneyKey(key: string): boolean {
  return /base|difference|gain|loss|debit|credit|open|booked|restated|net|applied|settle|foreign/i.test(key);
}

/** Report JSON → {columns, rows} per kind. The response shapes are the service's own. */
function shapeReport(
  kind: string,
  res: Record<string, unknown>,
): { columns: { key: string; label: string }[]; rows: Record<string, unknown>[] } {
  if (kind === "trial_balance") {
    const report = res as { rows?: Record<string, unknown>[] };
    return {
      columns: [
        { key: "code", label: "کد" },
        { key: "name", label: "حساب" },
        { key: "currencyCode", label: "ارز" },
        { key: "foreignDebit", label: "بدهکار ارزی" },
        { key: "foreignCredit", label: "بستانکار ارزی" },
        { key: "baseDebit", label: "بدهکار (پایه)" },
        { key: "baseCredit", label: "بستانکار (پایه)" },
      ],
      rows: report.rows ?? [],
    };
  }
  if (kind === "statement") {
    const report = res as { lines?: Record<string, unknown>[] };
    return {
      columns: [
        { key: "entryDate", label: "تاریخ" },
        { key: "memo", label: "شرح" },
        { key: "foreignAmount", label: "ارزی" },
        { key: "exchangeRate", label: "نرخ" },
        { key: "baseAmount", label: "پایه" },
        { key: "baseRunning", label: "مانده (پایه)" },
      ],
      rows: report.lines ?? [],
    };
  }
  if (kind === "party_balances") {
    const report = res as { balances?: Record<string, unknown>[] };
    return {
      columns: [
        { key: "partyName", label: "طرف حساب" },
        { key: "direction", label: "نوع" },
        { key: "currencyCode", label: "ارز" },
        { key: "foreignOpen", label: "مانده ارزی" },
        { key: "baseBooked", label: "مانده دفتری" },
        { key: "baseRestated", label: "مانده به نرخ روز" },
      ],
      rows: report.balances ?? [],
    };
  }
  if (kind === "gain_loss") {
    const report = res as { realized?: Record<string, unknown>[] };
    return {
      columns: [
        { key: "entryDate", label: "تاریخ" },
        { key: "direction", label: "نوع" },
        { key: "currencyCode", label: "ارز" },
        { key: "foreignApplied", label: "ارز تسویه‌شده" },
        { key: "baseAtBooking", label: "به نرخ ثبت" },
        { key: "baseAtSettlement", label: "به نرخ تسویه" },
        { key: "difference", label: "سود / (زیان)" },
      ],
      rows: report.realized ?? [],
    };
  }
  if (kind === "exposure") {
    const report = res as { currencies?: Record<string, unknown>[] };
    return {
      columns: [
        { key: "currencyCode", label: "ارز" },
        { key: "currentRate", label: "نرخ روز" },
        { key: "netForeign", label: "موضع خالص ارزی" },
        { key: "baseRestated", label: "به نرخ روز" },
        { key: "unrealizedDifference", label: "سود/زیان تحقق‌نیافته" },
      ],
      rows: report.currencies ?? [],
    };
  }
  const report = res as { accounts?: Record<string, unknown>[] };
  return {
    columns: [
      { key: "code", label: "کد" },
      { key: "name", label: "حساب" },
      { key: "currencyCode", label: "ارز" },
      { key: "foreignBalance", label: "مانده ارزی" },
      { key: "bookBase", label: "دفتری" },
      { key: "restatedBase", label: "به نرخ روز" },
      { key: "unrealizedDifference", label: "سود/زیان تحقق‌نیافته" },
    ],
    rows: report.accounts ?? [],
  };
}

function formatCell(value: unknown, key: string, money: ReturnType<typeof useMoney>): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string" && /^-?\d+$/.test(value) && isMoneyKey(key) && !/rate/i.test(key)) {
    if (key === "difference" || key === "unrealizedDifference") {
      return value.startsWith("-") ? `(${money.formatText(value.slice(1))})` : money.formatText(value);
    }
    return money.formatText(value);
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return formatJalali(value.slice(0, 10));
  if (value === "receivable") return "دریافتنی";
  if (value === "payable") return "پرداختنی";
  if (typeof value === "string" && /^\d+$/.test(value)) return toPersianDigits(value);
  return String(value);
}
