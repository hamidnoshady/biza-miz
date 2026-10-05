"use client";

/**
 * Tab «تاریخچه قیمت» — issue #844.
 *
 * Every price change of every writer lands here (one table, one service),
 * read through `GET /api/menu/price-history` with the screen's filters:
 * item search, category, source, changing user and a date range. Money is
 * shown in the business's canonical unit with Persian digits; the source
 * column uses the shared `PRICE_SOURCE_LABELS` (دستی، قیمت پیشنهادی، ورود
 * اطلاعات، هوش مصنوعی، اتصال خارجی، همگام‌سازی، مهاجرت).
 *
 * The user filter is permission-aware in the plainest way: it appears only
 * when `/api/team` is readable (team.view/team.manage); everyone else just
 * loses that one control and keeps the rest of the screen.
 */
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  DataTable,
  DataTableBody,
  DataTableHead,
  DataTableRow,
  Td,
  Th,
} from "@/app/dashboard/data-table";
import { EmptyState, LoadingSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { SearchField } from "@/app/dashboard/filters";
import { ErrorBox, api, inputClass } from "@/app/dashboard/ui";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { PRICE_CHANGE_SOURCES, PRICE_SOURCE_LABELS } from "@/lib/menu-price-sources";
import type { PriceChangeSource } from "@/lib/menu-price-sources";
import type { PriceHistoryRow } from "@/lib/menu-price-service";
import type { RestaurantMenuData } from "@/lib/restaurant-menu";

interface MemberOption {
  id: string;
  fullName: string;
}

export function PriceHistoryPanel({ data }: { data: RestaurantMenuData }) {
  const money = useMoney();
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [categoryId, setCategoryId] = useState("");
  const [source, setSource] = useState("");
  const [changedBy, setChangedBy] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [members, setMembers] = useState<MemberOption[] | null>(null);
  const [rows, setRows] = useState<PriceHistoryRow[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  // The changing-user filter needs the member directory; hide it when the
  // current role can't read it rather than showing a dead control.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await api<{ members?: Array<{ id?: string; fullName?: string; full_name?: string; name?: string }> }>(
        "/api/team",
      );
      if (cancelled) return;
      if (!result.ok || !Array.isArray(result.data.members)) {
        setMembers(null);
        return;
      }
      setMembers(
        result.data.members
          .filter((member): member is { id: string; fullName?: string; full_name?: string; name?: string } =>
            typeof member.id === "string",
          )
          .map((member) => ({
            id: member.id,
            fullName: member.fullName ?? member.full_name ?? member.name ?? "—",
          })),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const handle = window.setTimeout(() => {
      const params = new URLSearchParams();
      const q = deferredSearch.trim();
      if (q) params.set("search", q);
      if (categoryId) params.set("categoryId", categoryId);
      if (source) params.set("source", source);
      if (changedBy) params.set("changedBy", changedBy);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      params.set("limit", "500");
      void (async () => {
        setLoadFailed(false);
        const result = await api<{ rows?: PriceHistoryRow[] }>(
          `/api/menu/price-history?${params.toString()}`,
          { signal: controller.signal },
        );
        if (cancelled || result.aborted) return;
        if (!result.ok) {
          setLoadFailed(true);
          setRows(null);
          return;
        }
        setRows(Array.isArray(result.data.rows) ? result.data.rows : []);
      })();
    }, 250);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(handle);
    };
  }, [deferredSearch, categoryId, source, changedBy, from, to]);

  const filtersActive =
    search.trim() !== "" || categoryId !== "" || source !== "" || changedBy !== "" || from !== "" || to !== "";
  const clearFilters = () => {
    setSearch("");
    setCategoryId("");
    setSource("");
    setChangedBy("");
    setFrom("");
    setTo("");
  };

  const categoryOptions = useMemo(
    () => [
      { value: "", label: "همهٔ دسته‌ها" },
      ...data.categories.map((category) => ({ value: category.id, label: category.name })),
    ],
    [data.categories],
  );
  const sourceOptions = useMemo(
    () => [
      { value: "", label: "همهٔ منابع" },
      ...PRICE_CHANGE_SOURCES.map((value) => ({ value, label: PRICE_SOURCE_LABELS[value] })),
    ],
    [],
  );
  const memberOptions = useMemo(
    () =>
      members === null
        ? null
        : [{ value: "", label: "همهٔ اعضا" }, ...members.map((member) => ({ value: member.id, label: member.fullName }))],
    [members],
  );

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="space-y-2.5">
        <SearchField
          value={search}
          onChange={setSearch}
          label="جستجوی آیتم در تاریخچهٔ قیمت"
          placeholder="جستجوی نام آیتم…"
          className="w-full sm:max-w-sm"
        />
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-36 grow sm:max-w-52">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">دسته</label>
            <SearchableSelect
              value={categoryId}
              onChange={setCategoryId}
              options={categoryOptions}
              ariaLabel="فیلتر دسته"
            />
          </div>
          <div className="min-w-36 grow sm:max-w-48">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">منبع تغییر</label>
            <SearchableSelect
              value={source}
              onChange={setSource}
              options={sourceOptions}
              ariaLabel="فیلتر منبع تغییر"
            />
          </div>
          {memberOptions ? (
            <div className="min-w-36 grow sm:max-w-48">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">تغییردهنده</label>
              <SearchableSelect
                value={changedBy}
                onChange={setChangedBy}
                options={memberOptions}
                ariaLabel="فیلتر تغییردهنده"
              />
            </div>
          ) : null}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">از تاریخ</label>
            <input
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className={`${inputClass} w-40`}
              aria-label="از تاریخ"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">تا تاریخ</label>
            <input
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              className={`${inputClass} w-40`}
              aria-label="تا تاریخ"
            />
          </div>
          {filtersActive ? (
            <button
              type="button"
              onClick={clearFilters}
              className="h-10 rounded-xl border border-amber-200 bg-amber-100 px-3 text-sm font-medium text-amber-950 transition-colors hover:bg-amber-200/70 focus-visible:outline-none focus-visible:ring focus-visible:ring-amber-400/40 dark:border-amber-500/30 dark:bg-amber-500/20 dark:text-amber-200"
            >
              پاک‌کردن فیلترها
            </button>
          ) : null}
        </div>
      </div>

      {loadFailed ? (
        <ErrorBox>بارگذاری تاریخچهٔ قیمت ممکن نشد. دوباره تلاش کنید.</ErrorBox>
      ) : rows === null ? (
        <LoadingSkeleton rows={5} label="در حال بارگذاری تاریخچهٔ قیمت" />
      ) : rows.length === 0 ? (
        <EmptyState
          title={filtersActive ? "رکوردی با این فیلترها پیدا نشد" : "هنوز تغییر قیمتی ثبت نشده است"}
        >
          {filtersActive
            ? "بازهٔ تاریخ یا فیلتر منبع را تغییر دهید."
            : "هر تغییر قیمت — دستی، وارداتی، از سوی هوش مصنوعی یا همگام‌سازی — اینجا با تاریخ و دلیل ثبت می‌شود."}
        </EmptyState>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block">
            <DataTable caption="تاریخچهٔ تغییرات قیمت منو">
              <DataTableHead>
                <tr>
                  <Th>آیتم</Th>
                  <Th numeric>قیمت قبلی</Th>
                  <Th numeric>قیمت جدید</Th>
                  <Th numeric>تغییر</Th>
                  <Th>منبع</Th>
                  <Th>تغییردهنده</Th>
                  <Th>تاریخ و ساعت</Th>
                  <Th>دلیل</Th>
                </tr>
              </DataTableHead>
              <DataTableBody>
                {rows.map((row) => (
                  <DataTableRow key={row.id}>
                    <Td>
                      <span className="block truncate font-medium">{row.itemName}</span>
                      {row.categoryName ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          {row.categoryName}
                        </span>
                      ) : null}
                    </Td>
                    <Td numeric muted>{money.format(row.oldPriceRial)}</Td>
                    <Td numeric>{money.format(row.newPriceRial)}</Td>
                    <Td numeric>
                      <PercentBadge percent={row.deltaPercent} deltaRial={row.deltaRial} />
                    </Td>
                    <Td>
                      <StatusBadge tone={row.source === "manual" ? "active" : "neutral"}>
                        {PRICE_SOURCE_LABELS[row.source]}
                      </StatusBadge>
                    </Td>
                    <Td muted>{row.changedByName ?? "—"}</Td>
                    <Td nowrap muted>{formatJalali(row.changedAt, { withTime: true })}</Td>
                    <Td muted>
                      <span className="block max-w-40 truncate" title={row.reason ?? ""}>
                        {row.reason ?? "—"}
                      </span>
                    </Td>
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>
          </div>

          {/* Mobile list */}
          <ul className="space-y-2.5 md:hidden">
            {rows.map((row) => (
              <li
                key={row.id}
                className="rounded-xl border border-border/80 bg-card p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{row.itemName}</span>
                    <span className="block text-xs text-muted-foreground">
                      {row.changedByName ?? "—"} · {formatJalali(row.changedAt, { withTime: true })}
                    </span>
                  </span>
                  <StatusBadge tone={row.source === "manual" ? "active" : "neutral"}>
                    {PRICE_SOURCE_LABELS[row.source]}
                  </StatusBadge>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm tabular-nums">
                  <span className="text-muted-foreground line-through decoration-border">
                    {money.format(row.oldPriceRial)}
                  </span>
                  <span aria-hidden>→</span>
                  <span className="font-medium">{money.format(row.newPriceRial)}</span>
                  <PercentBadge percent={row.deltaPercent} deltaRial={row.deltaRial} />
                </div>
                {row.reason ? (
                  <p className="mt-1 text-xs text-muted-foreground">دلیل: {row.reason}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function PercentBadge({
  percent,
  deltaRial,
}: {
  percent: number | null;
  deltaRial: number;
}) {
  const text =
    percent === null
      ? "—"
      : `${toPersianDigits(String(percent).replace(".", "٫"))}٪`;
  const tone =
    percent === null || percent === 0
      ? "text-muted-foreground"
      : percent > 0
        ? "text-emerald-700 dark:text-emerald-300"
        : "text-red-700 dark:text-red-300";
  return (
    <span className={`inline-flex items-center gap-1 text-sm font-medium ${tone}`} title={undefined}>
      {deltaRial > 0 ? "▲" : deltaRial < 0 ? "▼" : ""}
      {text}
    </span>
  );
}
