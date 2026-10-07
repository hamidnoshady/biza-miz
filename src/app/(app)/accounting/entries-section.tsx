"use client";

import { SectionCardSkeleton } from "@/app/dashboard/page-chrome";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { ledgerSourceLabel } from "@/lib/ledger-source-labels";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { api, ErrorBox, inputClass, SecondaryButton } from "@/app/dashboard/ui";
import type { Runner } from "./accounting-manager";
import { cardClass } from "@/app/dashboard/page-chrome";

interface JournalLineRow {
  entry_id: string;
  account_id: string;
  account_code: string;
  account_name: string;
  debit: string | number;
  credit: string | number;
}
interface JournalEntryRow {
  id: string;
  entry_date: string;
  memo: string | null;
  source_type: string | null;
  posted_at: string;
  created_by_name: string | null;
  reverses_entry_id: string | null;
  reversed_at: string | null;
  lines: JournalLineRow[];
}

/**
 * «دفتر روزنامه» — every posted entry, its lines, and the reversal action for
 * the manual ones.
 *
 * Two things this screen used to get wrong, both now fixed here rather than
 * papered over: it printed the raw English `source_type` for any code its own
 * eight-entry map missed (`ledgerSourceLabel` is the complete table, shared
 * with reconciliation and the reports drill-down), and it silently showed the
 * newest hundred documents with no filter and no hint that a hundred-and-first
 * existed. The filters are the API's — a Jalali date range that stores ISO, one
 * source, and a search over the memo, the poster and the accounts touched.
 */
export function EntriesSection({ refreshKey, busy, run }: { refreshKey: number; busy: boolean; run: Runner }) {
  const money = useMoney();
  const searchParams = useSearchParams();
  const entryId = searchParams.get("entryId")?.trim() ?? "";
  const [entries, setEntries] = useState<JournalEntryRow[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(0);

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [sourceType, setSourceType] = useState("");
  const [q, setQ] = useState("");
  const [sourceTypes, setSourceTypes] = useState<string[]>([]);

  useEffect(() => {
    api<{ sourceTypes: string[] }>("/api/ledger/entries/source-types").then(({ ok, data }) => {
      if (ok) setSourceTypes(data.sourceTypes);
    });
  }, [refreshKey]);

  const load = useCallback(
    async (offset = 0, append = false) => {
      const params = new URLSearchParams();
      if (entryId) params.set("entryId", entryId);
      else {
        if (dateFrom) params.set("dateFrom", dateFrom);
        if (dateTo) params.set("dateTo", dateTo);
        if (sourceType) params.set("sourceType", sourceType);
        if (q.trim()) params.set("q", q.trim());
      }
      if (offset) params.set("offset", String(offset));
      const currentRequest = ++requestId.current;
      setError("");
      if (append) setLoadingMore(true);
      const { ok, data } = await api<{ entries: JournalEntryRow[]; hasMore: boolean; error?: string }>(
        `/api/ledger/entries?${params}`,
      );
      if (currentRequest !== requestId.current) return;
      if (ok) {
        setEntries((previous) => (append && previous ? [...previous, ...data.entries] : data.entries));
        setHasMore(!!data.hasMore);
      } else {
        setError(
          data.error === "invalid_date_range"
            ? "بازهٔ تاریخ نامعتبر است؛ تاریخ شروع باید قبل از تاریخ پایان باشد."
            : data.error === "invalid_date"
              ? "یکی از تاریخ‌ها معتبر نیست."
              : "بارگذاری دفتر روزنامه ناموفق بود. دوباره تلاش کنید.",
        );
      }
      if (append) setLoadingMore(false);
    },
    [dateFrom, dateTo, sourceType, q, entryId],
  );

  useEffect(() => {
    // Invalidate an in-flight request immediately when a filter changes; the
    // search debounce must not let results for the previous query flash into
    // the new filter's empty state.
    requestId.current += 1;
    setEntries(null);
    setHasMore(false);
    setLoadingMore(false);
    const timer = setTimeout(() => void load(), q ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, q, refreshKey]);

  async function reverse(id: string) {
    await run(() => api(`/api/ledger/entries/${id}/reverse`, { method: "POST", body: JSON.stringify({}) }));
  }

  const filtered = !!(dateFrom || dateTo || sourceType || q.trim() || entryId);

  return (
    <div className="space-y-4">
      <section className={cardClass}>
        <header className="border-b border-border/80 px-4 py-4 sm:px-5">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">دفاتر مالی</p>
          <h2 className="mt-1 text-base font-semibold text-foreground">دفتر روزنامه</h2>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
            اسناد خودکار و دستیِ ثبت‌شده، با امکان برگشت فقط برای اسناد دستی مجاز.
          </p>
        </header>

        <div className="border-b border-border/80 p-4 sm:p-5">
          <div className="grid gap-3 rounded-xl border border-border/80 bg-muted/60 p-3 lg:grid-cols-4 lg:items-end">
            <label className="block">
              <span className="mb-1.5 block text-xs text-muted-foreground">از تاریخ</span>
              <JalaliDatePicker value={dateFrom} onChange={setDateFrom} placeholder="از ابتدا" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs text-muted-foreground">تا تاریخ</span>
              <JalaliDatePicker value={dateTo} onChange={setDateTo} placeholder="تا امروز" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs text-muted-foreground">منبع سند</span>
              <SearchableSelect
                value={sourceType}
                onChange={setSourceType}
                ariaLabel="منبع سند"
                options={[
                  { value: "", label: "همهٔ منابع" },
                  ...sourceTypes.map((code) => ({ value: code, label: ledgerSourceLabel(code) })),
                ]}
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs text-muted-foreground">جست‌وجو</span>
              <input
                className={inputClass}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="شرح، ثبت‌کننده یا نام/کد حساب…"
              />
            </label>
          </div>
          {entryId ? (
            <p className="mt-3 text-xs text-muted-foreground">
              سند پیوندشده: {toPersianDigits(entryId.slice(0, 8))} — <Link href="/accounting/entries" className="font-medium text-amber-800 underline underline-offset-2 dark:text-amber-300">نمایش همهٔ اسناد</Link>
            </p>
          ) : null}
          {filtered ? (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <SecondaryButton
                onClick={() => {
                  setDateFrom("");
                  setDateTo("");
                  setSourceType("");
                  setQ("");
                }}
              >
                پاک کردن فیلترها
              </SecondaryButton>
              <span className="text-xs text-muted-foreground">
                {entries ? `${toPersianDigits(entries.length)} سند در این فیلتر` : ""}
              </span>
            </div>
          ) : null}
        </div>

        <div className="p-4 sm:p-5">
          <ErrorBox>{error}</ErrorBox>
          {!entries ? (
            error ? null : <SectionCardSkeleton rows={4} label="در حال بارگذاری دفتر روزنامه" />
          ) : entries.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
              {filtered ? "سندی با این فیلترها پیدا نشد." : "هنوز سندی ثبت نشده است."}
            </p>
          ) : (
            <div className="space-y-3">
              {entries.map((e) => {
                const isReversal = !!e.reverses_entry_id;
                const isReversed = !!e.reversed_at;
                const canReverse = e.source_type === "manual" && !isReversal && !isReversed;
                const total = e.lines.reduce((sum, l) => sum + Number(l.debit), 0);
                return (
                  <article key={e.id} className={cardClass}>
                    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/80 px-4 py-4 sm:px-5">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="truncate text-base font-semibold text-foreground">{e.memo || "سند بدون شرح"}</h3>
                          {isReversal ? (
                            <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-950 dark:bg-amber-500/20 dark:text-amber-200">
                              سند برگشتی
                            </span>
                          ) : null}
                          {isReversed ? (
                            <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-semibold text-muted-foreground">
                              برگشت‌خورده
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {ledgerSourceLabel(e.source_type)} — {toPersianDigits(formatJalali(e.entry_date))}
                          {e.created_by_name ? ` — ${e.created_by_name}` : ""}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="whitespace-nowrap text-sm font-bold text-foreground">{money.format(total)}</span>
                        {canReverse ? (
                          <SecondaryButton onClick={() => reverse(e.id)} disabled={busy}>
                            برگشت سند
                          </SecondaryButton>
                        ) : null}
                      </div>
                    </div>

                    <div className="p-4 sm:p-5">
                      <DataTable caption="ردیف‌های این سند حسابداری" className="hidden lg:block">
                        <DataTableHead>
                          <Th>حساب</Th>
                          <Th numeric>بدهکار</Th>
                          <Th numeric>بستانکار</Th>
                        </DataTableHead>
                        <DataTableBody>
                          {e.lines.map((l, i) => (
                            <DataTableRow key={i}>
                              <Td muted>
                                {l.account_code} {l.account_name}
                              </Td>
                              <Td numeric nowrap>
                                {Number(l.debit) !== 0 ? money.format(Number(l.debit)) : "—"}
                              </Td>
                              <Td numeric nowrap>
                                {Number(l.credit) !== 0 ? money.format(Number(l.credit)) : "—"}
                              </Td>
                            </DataTableRow>
                          ))}
                        </DataTableBody>
                      </DataTable>

                      <div className="space-y-2 lg:hidden">
                        {e.lines.map((l, i) => (
                          <div key={i} className="rounded-xl border border-border/80 bg-muted/60 p-3">
                            <p className="text-sm font-medium text-foreground">
                              {l.account_code} {l.account_name}
                            </p>
                            <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
                              <div>
                                <dt className="text-xs text-muted-foreground">بدهکار</dt>
                                <dd className="mt-1 font-semibold tabular-nums text-foreground">
                                  {Number(l.debit) !== 0 ? money.format(Number(l.debit)) : "—"}
                                </dd>
                              </div>
                              <div>
                                <dt className="text-xs text-muted-foreground">بستانکار</dt>
                                <dd className="mt-1 font-semibold tabular-nums text-foreground">
                                  {Number(l.credit) !== 0 ? money.format(Number(l.credit)) : "—"}
                                </dd>
                              </div>
                            </dl>
                          </div>
                        ))}
                      </div>
                    </div>
                  </article>
                );
              })}

              {hasMore ? (
                <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-3 py-4 text-center">
                  <p className="text-xs leading-6 text-muted-foreground">
                    {toPersianDigits(entries.length)} سند نمایش داده شده و سند قدیمی‌تری هم وجود دارد.
                  </p>
                  <SecondaryButton
                    onClick={() => void load(entries.length, true)}
                    disabled={loadingMore || busy}
                  >
                    {loadingMore ? "در حال بارگذاری…" : "نمایش اسناد قدیمی‌تر"}
                  </SecondaryButton>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
