"use client";

/**
 * Phase 42 — «لیست قیمت»: the reference's price-update matrix on the
 * platform's chrome. Sale and purchase columns write the trade's own stock
 * route (the one writer the invoice screen trusts); named list columns write
 * `price_list_entries`. «بروزرسانی سریع» moves a whole column by percent or
 * amount with an optional round, and the lists modal adds/renames/deletes the
 * named lists themselves.
 */
import { tablePageWindow } from "@/lib/table-page";
import { useCallback, useEffect, useMemo, useRef, useState, useDeferredValue } from "react";
import { FileSpreadsheetIcon, PencilIcon, PlusIcon, RefreshCwIcon, SaveIcon, Trash2Icon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import { todayJalali } from "@/lib/jalali";
import { normalizePosSearchText } from "@/lib/pos-selection";
import type { VariantSummary } from "@/lib/accessories-service";
import type { PriceEntry, PriceList } from "@/lib/price-lists-service";
import { entryKey, type EntryConflict } from "@/lib/price-list-conflicts";
import { formatJalali } from "@/lib/jalali";
import { api, ErrorBox, errorMessage, Field, inputClass } from "../ui";
import { EmptyState, SectionCard, SectionCardSkeleton } from "../page-chrome";
import { SearchField } from "@/app/dashboard/filters";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";

type ColumnKey = string; // "sale" | "purchase" | <price list id>
type Row = Record<ColumnKey, string>;
type Cells = Record<string, Row>;

/**
 * A list cell the server refused because someone changed it after this screen
 * loaded it (audit F14). `value` is what the user typed — kept in the grid
 * across the reload — and `sentVersion` is the stale version the save carried,
 * which the cell keeps sending until the user decides: reload the current
 * value, or overwrite it deliberately.
 */
type PendingConflict = EntryConflict & { value: string; sentVersion: string | null };

/** Rows per page of the price matrix; each row carries two inputs plus one per price list. */
const PRICE_PAGE_SIZE = 50;

/**
 * A cell holds what the user typed, so it must be compared and validated as
 * text. Empty means "no price on this column"; anything that is not a
 * non-negative number is a typo the save must refuse rather than send as
 * `NaN` — which `Number()` would previously have turned into a cleared cell or
 * a rejected request with no explanation of which row was at fault.
 */
function cellError(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return false;
  const numeric = Number(trimmed);
  return !Number.isFinite(numeric) || numeric < 0;
}

export function PriceListsSection({ apiBase }: { apiBase: string }) {
  const money = useMoney();
  const [items, setItems] = useState<VariantSummary[] | null>(null);
  const [lists, setLists] = useState<PriceList[]>([]);
  const [cells, setCells] = useState<Cells>({});
  const [initial, setInitial] = useState<Cells>({});
  // `entryKey(list, item)` → the version each filled list cell had when loaded.
  // A cell with no key was empty, which the save sends as `null`.
  const [versions, setVersions] = useState<Record<string, string>>({});
  const [conflicts, setConflicts] = useState<Record<string, PendingConflict>>({});
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const deferredSearch = useDeferredValue(search);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [listsModal, setListsModal] = useState(false);
  const [quickModal, setQuickModal] = useState(false);

  /**
   * `money` is a fresh object on every render of a provider, and `load` used to
   * depend on it — so `useEffect(load, [load])` re-fetched the whole matrix on
   * every parent render and threw away the user's unsaved edits with it. The
   * conversion helpers are read through a ref instead, and the effect depends
   * only on the API base.
   */
  const moneyRef = useRef(money);
  moneyRef.current = money;

  // A reload must not resurrect a response from a request the user has already
  // superseded (two quick saves, or a save racing the initial load).
  const requestId = useRef(0);

  /**
   * `keep` carries the cells a save could not apply because of a conflict:
   * the reload shows everything else as it now is, but those cells keep the
   * user's unsaved value (and their pending conflict) instead of being reset.
   */
  const load = useCallback(
    async (signal?: AbortSignal, keep: Record<string, PendingConflict> = {}) => {
      const ticket = ++requestId.current;
      const [itemsRes, listsRes] = await Promise.all([
        api<{ items: VariantSummary[] }>(`${apiBase}/items`, { signal }),
        api<{ lists: PriceList[]; entries: PriceEntry[] }>("/api/products/price-lists", { signal }),
      ]);
      if (itemsRes.aborted || listsRes.aborted || ticket !== requestId.current) return;
      if (!itemsRes.ok || !listsRes.ok) {
        // The old code returned silently here, leaving the screen on its
        // skeleton for ever with no way to find out why.
        setLoadError(
          errorMessage(
            ((itemsRes.ok ? listsRes.data : itemsRes.data) as { error?: string }).error,
          ),
        );
        setItems((current) => current ?? []);
        return;
      }
      setLoadError("");

      const convert = moneyRef.current;
      const priced = itemsRes.data.items.filter((item) => item.kind !== "variant_parent");
      const entryPrice = new Map(
        listsRes.data.entries.map((entry) => [`${entry.priceListId}:${entry.itemId}`, entry.price]),
      );
      const next: Cells = {};
      for (const item of priced) {
        const row: Row = {
          sale: item.unitPrice != null ? String(convert.toInput(item.unitPrice)) : "",
          purchase: item.unitCost != null ? String(convert.toInput(item.unitCost)) : "",
        };
        for (const list of listsRes.data.lists) {
          const price = entryPrice.get(`${list.id}:${item.id}`);
          row[list.id] = price != null ? String(convert.toInput(price)) : "";
        }
        next[item.id] = row;
      }

      // structuredClone of a plain string map; JSON round-tripping a matrix of
      // a few thousand cells on every load was pure overhead.
      const baseline = Object.fromEntries(Object.entries(next).map(([id, row]) => [id, { ...row }]));
      const kept: Record<string, PendingConflict> = {};
      for (const [key, conflict] of Object.entries(keep)) {
        const row = next[conflict.itemId];
        // An item or list deleted meanwhile has no cell left to keep.
        if (!row || !(conflict.priceListId in row)) continue;
        row[conflict.priceListId] = conflict.value;
        kept[key] = conflict;
      }

      setItems(priced);
      setLists(listsRes.data.lists);
      setCells(next);
      setInitial(baseline);
      setVersions(
        Object.fromEntries(
          listsRes.data.entries.map((entry) => [entryKey(entry.priceListId, entry.itemId), entry.version]),
        ),
      );
      setConflicts(kept);
    },
    [apiBase],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // Pre-compute the normalized haystack once per dataset. `normalizePosSearchText`
  // folds ی/ك and Persian/Arabic digits, so «كیف» finds «کیف» and «۱۲۳» finds
  // "123" — a plain `toLowerCase()` matched neither.
  const searchIndex = useMemo(() => {
    if (!items) return null;
    return items.map((item) => ({
      item,
      haystack: normalizePosSearchText(
        [item.name, item.parentName ?? "", item.sku ?? "", item.barcode ?? ""]
          .filter(Boolean)
          .join(" "),
      ),
    }));
  }, [items]);

  const filtered = useMemo(() => {
    if (!items || !searchIndex) return null;
    const needle = normalizePosSearchText(deferredSearch);
    if (!needle) return items;
    return searchIndex.filter(({ haystack }) => haystack.includes(needle)).map(({ item }) => item);
  }, [items, searchIndex, deferredSearch]);

  // One bounded page of the filtered list (audit F14). Edits are keyed by item
  // in `cells`, never by row position, so paging and filtering keep them.
  const pageWindow = tablePageWindow(filtered?.length ?? 0, page, PRICE_PAGE_SIZE);
  const pageItems = filtered ? filtered.slice(pageWindow.start, pageWindow.end) : null;
  useEffect(() => setPage(1), [deferredSearch]);

  const setCell = useCallback((itemId: string, column: ColumnKey, value: string) => {
    setCells((current) => ({
      ...current,
      [itemId]: { ...current[itemId], [column]: value },
    }));
  }, []);

  /**
   * Every changed cell in the *whole* matrix, not just the filtered view.
   *
   * The old version iterated `filtered`, so typing a new price, then typing
   * into the search box, then pressing «ذخیره قیمت‌ها» silently discarded every
   * edit that the filter had scrolled out of view.
   */
  const dirty = useMemo(() => {
    const updates: { itemId: string; column: ColumnKey; value: string }[] = [];
    for (const [itemId, row] of Object.entries(cells)) {
      const base = initial[itemId] ?? {};
      for (const [column, value] of Object.entries(row)) {
        // Compare trimmed: typing a space into an untouched cell is not an
        // edit, and used to count as one — «ذخیره ۱ تغییر» with nothing to save.
        if ((base[column] ?? "").trim() === value.trim()) continue;
        updates.push({ itemId, column, value });
      }
    }
    return updates;
  }, [cells, initial]);

  const invalid = useMemo(() => dirty.filter((update) => cellError(update.value)), [dirty]);
  const editedElsewhere = useMemo(() => {
    const onPage = new Set((pageItems ?? []).map((item) => item.id));
    return new Set(dirty.filter((update) => !onPage.has(update.itemId)).map((update) => update.itemId)).size;
  }, [dirty, pageItems]);

  // Leaving the page with unsaved prices in the grid is a real loss: there is
  // no draft anywhere, and the matrix is the only place the typing exists.
  useEffect(() => {
    if (dirty.length === 0) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty.length]);

  async function saveAll() {
    if (dirty.length === 0) {
      setError("");
      setNotice("تغییری برای ذخیره نیست.");
      return;
    }
    if (invalid.length > 0) {
      setNotice("");
      setError(`${toPersianDigits(invalid.length)} قیمت نامعتبر است؛ مقادیر قرمزرنگ را اصلاح کنید.`);
      return;
    }

    setBusy(true);
    setError("");
    setNotice("");

    const convert = moneyRef.current;
    const priceOf = (value: string) =>
      value.trim() === "" ? null : convert.fromInput(Math.round(Number(value.trim())));

    const entryUpdates = dirty.filter((u) => u.column !== "sale" && u.column !== "purchase");
    const stockUpdates = dirty.filter((u) => u.column === "sale" || u.column === "purchase");
    const failures: string[] = [];
    const refused: Record<string, PendingConflict> = {};

    if (entryUpdates.length > 0) {
      // Each cell carries the version it was loaded at — or, while a conflict
      // on it is still undecided, the stale version that conflicted, so a
      // second press of «ذخیره» cannot overwrite the colleague's value by
      // accident. Only «جایگزینی با مقدار من» moves it to the current version.
      const expectedOf = (key: string) =>
        key in conflicts ? conflicts[key].sentVersion : (versions[key] ?? null);
      const typed = new Map(entryUpdates.map((u) => [entryKey(u.column, u.itemId), u.value]));
      const { ok, data } = await api<{ error?: string; conflicts?: EntryConflict[] }>(
        "/api/products/price-lists/entries",
        {
          method: "PUT",
          body: JSON.stringify({
            updates: entryUpdates.map((u) => ({
              priceListId: u.column,
              itemId: u.itemId,
              price: priceOf(u.value),
              expectedVersion: expectedOf(entryKey(u.column, u.itemId)),
            })),
          }),
        },
      );
      if (!ok) failures.push(errorMessage(data.error));
      for (const conflict of (ok ? data.conflicts : undefined) ?? []) {
        const key = entryKey(conflict.priceListId, conflict.itemId);
        refused[key] = { ...conflict, value: typed.get(key) ?? "", sentVersion: expectedOf(key) };
      }
    }

    /**
     * The stock route takes one item per call, so the sale/purchase column is
     * saved in parallel batches rather than strictly one after another: a
     * 200-row column used to be 200 sequential requests, which took minutes on
     * a slow link with the button spinning the whole time. The batch size keeps
     * the browser's per-host connection limit from queueing them anyway.
     */
    const BATCH = 8;
    for (let index = 0; index < stockUpdates.length; index += BATCH) {
      const batch = stockUpdates.slice(index, index + BATCH);
      const results = await Promise.all(
        batch.map(async (update) => {
          const price = priceOf(update.value);
          // Clearing a sale/purchase cell is not a stock write: `item_stock`
          // has no "unset the price" operation, so the field is left alone.
          if (price == null) return { ok: true, cleared: true, data: {} as { error?: string; message?: string } };
          const { ok, data } = await api<{ error?: string; message?: string }>(
            `${apiBase}/items/${update.itemId}/stock`,
            {
              method: "POST",
              body: JSON.stringify(
                update.column === "sale" ? { unitPrice: price } : { unitCost: price },
              ),
            },
          );
          return { ok, cleared: false, data };
        }),
      );
      for (const result of results) {
        if (!result.ok) failures.push(result.data.message ?? errorMessage(result.data.error));
      }
    }

    const clearedStock = stockUpdates.filter((u) => u.value.trim() === "").length;
    const conflictCount = Object.keys(refused).length;
    setBusy(false);

    if (failures.length > 0) {
      // Show the actual reason the server gave rather than a flat "some prices
      // were not saved", and de-duplicate so one repeated cause reads once.
      setError([...new Set(failures)].join(" "));
      await load(undefined, refused);
      return;
    }
    if (conflictCount > 0) {
      setError(
        `${toPersianDigits(conflictCount)} قیمت ذخیره نشد، چون پس از باز شدن این صفحه کس دیگری آن را تغییر داده است. بقیهٔ تغییرات ذخیره شد؛ برای هر مورد مقدار فعلی را بارگذاری کنید یا آگاهانه مقدار خود را جایگزین کنید.`,
      );
      await load(undefined, refused);
      return;
    }
    setNotice(
      clearedStock > 0
        ? "قیمت‌ها ذخیره شد. خالی‌کردن قیمت فروش/خرید ممکن نیست و این ستون‌ها بدون تغییر ماندند."
        : "قیمت‌ها ذخیره شد.",
    );
    await load();
  }

  function discard() {
    setCells(Object.fromEntries(Object.entries(initial).map(([id, row]) => [id, { ...row }])));
    setConflicts({});
    setError("");
    setNotice("تغییرات ذخیره‌نشده لغو شد.");
  }

  /** Drop the user's value for these conflicted cells and show what is stored now. */
  function takeCurrent(keys: string[]) {
    setCells((current) => {
      const next = { ...current };
      for (const key of keys) {
        const conflict = conflicts[key];
        if (!conflict || !next[conflict.itemId]) continue;
        next[conflict.itemId] = {
          ...next[conflict.itemId],
          [conflict.priceListId]: initial[conflict.itemId]?.[conflict.priceListId] ?? "",
        };
      }
      return next;
    });
    resolveConflicts(keys);
  }

  /**
   * Keep the user's value and let the next save replace the stored one. The
   * cell then sends the version the reload read, so if the value moves *again*
   * before the save, that is reported as a fresh conflict rather than
   * overwritten.
   */
  function overwrite(keys: string[]) {
    resolveConflicts(keys);
    setError("");
    setNotice("مقدار شما با «ذخیره» جایگزین مقدار فعلی می‌شود.");
  }

  function resolveConflicts(keys: string[]) {
    setConflicts((current) => {
      const next = { ...current };
      for (const key of keys) delete next[key];
      return next;
    });
  }

  function downloadCsv() {
    if (!filtered || filtered.length === 0) return;
    const unit = money.unitLabel;
    const head = [
      "کد کالا",
      "بارکد",
      "عنوان کالا",
      `قیمت فروش (${unit})`,
      `قیمت خرید (${unit})`,
      ...lists.map((list) => `${list.name} (${unit})`),
    ];
    const lines = filtered.map((item) => {
      const row = cells[item.id] ?? {};
      // Export what the screen shows — the business's own unit — rather than
      // silently converting to Rial under a «(ریال)» header that was wrong for
      // every Toman business anyway.
      const cell = (value: string) => (value.trim() === "" ? "" : value.trim());
      return [
        item.sku ?? "",
        item.barcode ?? "",
        item.name,
        cell(row.sale ?? ""),
        cell(row.purchase ?? ""),
        ...lists.map((list) => cell(row[list.id] ?? "")),
      ]
        // A leading =/+/-/@ in a spreadsheet cell is a formula; quoting alone
        // does not stop Excel from evaluating it.
        .map((value) => (/^[=+\-@]/.test(value) ? `'${value}` : value))
        .map((value) => `"${value.replaceAll('"', '""')}"`)
        .join(",");
    });
    // CRLF: Excel on Windows treats a bare LF inside a quoted field as part of
    // the cell and mis-parses the row.
    const csv = `\uFEFF${[head.join(","), ...lines].join("\r\n")}\r\n`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    // The file name carries the Shamsi date — it is shown to the user in the
    // downloads bar and the file manager, so it is a date a user sees.
    const { jy, jm, jd } = todayJalali();
    anchor.download = `price-lists-${jy}-${String(jm).padStart(2, "0")}-${String(jd).padStart(2, "0")}.csv`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    // Revoking in the same tick cancelled the download in Firefox/Safari.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  const columnCount = 3 + 2 + lists.length;

  return (
    <div className="min-w-0 space-y-4 sm:space-y-5">
      <ErrorBox>{loadError || error}</ErrorBox>

      {/*
        The toolbar is the page's primary control strip, so it wraps to the
        start on a phone instead of being pushed off the end: `justify-end`
        alone put «ذخیره قیمت‌ها» on its own overflowing row at 360px.
      */}
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={downloadCsv}
          disabled={!filtered || filtered.length === 0}
        >
          <FileSpreadsheetIcon aria-hidden="true" className="size-4" />
          دانلود اکسل لیست قیمت
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setQuickModal(true)}>
          <RefreshCwIcon aria-hidden="true" className="size-4" />
          بروزرسانی سریع
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setListsModal(true)}>
          <PlusIcon aria-hidden="true" className="size-4" />
          مدیریت لیست‌های قیمت
        </Button>
        {dirty.length > 0 ? (
          <Button type="button" variant="ghost" size="sm" onClick={discard} disabled={busy}>
            <XIcon aria-hidden="true" className="size-4" />
            لغو تغییرات
          </Button>
        ) : null}
        <Button type="button" size="sm" onClick={saveAll} disabled={busy || dirty.length === 0}>
          <SaveIcon aria-hidden="true" className="size-4" />
          {busy
            ? "در حال ذخیره…"
            : dirty.length > 0
              ? `ذخیره ${toPersianDigits(dirty.length)} تغییر`
              : "ذخیره قیمت‌ها"}
        </Button>
      </div>

      {/*
        A polite live region: the save result used to be a bare paragraph after
        the table, which a screen reader never announced and a mouse user had to
        scroll past a 200-row grid to find.
      */}
      <p role="status" aria-live="polite" className="sr-only">
        {error || notice}
      </p>
      {notice ? (
        <p className="text-xs text-emerald-700 dark:text-emerald-400">{notice}</p>
      ) : null}

      {Object.keys(conflicts).length > 0 ? (
        <SectionCard
          title="قیمت‌هایی که هم‌زمان تغییر کرده‌اند"
          description="این قیمت‌ها پس از باز شدن صفحه در جای دیگری تغییر کرده‌اند و ذخیره نشدند. مقدار شما در جدول باقی مانده است."
          actions={
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => takeCurrent(Object.keys(conflicts))}>
                بارگذاری مقدار فعلی همه
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => overwrite(Object.keys(conflicts))}>
                جایگزینی همه با مقدار من
              </Button>
            </div>
          }
        >
          <ul className="divide-y divide-border/80 text-sm">
            {Object.entries(conflicts).map(([key, conflict]) => {
              const itemName = items?.find((item) => item.id === conflict.itemId)?.name ?? "کالا";
              const listName = lists.find((list) => list.id === conflict.priceListId)?.name ?? "لیست قیمت";
              const mine = conflict.value.trim() === "" ? "بدون قیمت" : `${toPersianDigits(conflict.value.trim())} ${money.unitLabel}`;
              const theirs =
                conflict.currentPrice == null ? "بدون قیمت" : money.format(conflict.currentPrice, { withUnit: true });
              return (
                <li key={key} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0 space-y-1">
                    <p className="font-medium">{`${itemName} — ${listName}`}</p>
                    <p className="text-xs text-muted-foreground">
                      {`مقدار شما: ${mine} · مقدار فعلی: ${theirs}`}
                      {conflict.updatedAt
                        ? ` · آخرین تغییر: ${formatJalali(conflict.updatedAt, { withTime: true })}`
                        : " · این قیمت در این فاصله حذف شده است"}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="ghost" size="sm" onClick={() => takeCurrent([key])}>
                      بارگذاری مقدار فعلی
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => overwrite([key])}>
                      جایگزینی با مقدار من
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </SectionCard>
      ) : null}

      <SectionCard
        title="نمایش لیست قیمت‌های کالا"
        description={
          filtered
            ? `${toPersianDigits(filtered.length)} کالا${
                items && filtered.length !== items.length
                  ? ` از ${toPersianDigits(items.length)}`
                  : ""
              } — مبالغ به ${money.unitLabel}`
            : "در حال خواندن…"
        }
        actions={
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder="فیلتر و جستجو"
            label="جستجوی کالا بر اساس نام، کد یا بارکد"
            className="w-full sm:w-64"
          />
        }
        flush
      >
        {filtered === null ? (
          <div className="p-4 sm:p-5">
            <SectionCardSkeleton rows={6} />
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-4 sm:p-5">
            <EmptyState>
              {search.trim()
                ? "کالایی با این جستجو پیدا نشد."
                : "کالایی برای قیمت‌گذاری ثبت نشده است."}
            </EmptyState>
          </div>
        ) : (
          <DataTable caption="قیمت کالاها در فهرست‌های قیمت" tableClassName="min-w-[56rem]">
            <DataTableHead>
              <Th>#</Th>
              <Th>کد کالا</Th>
              <Th>عنوان کالا</Th>
              <Th>قیمت فروش</Th>
              <Th>قیمت خرید</Th>
              {lists.map((list) => (
                <Th key={list.id}>{list.name}</Th>
              ))}
            </DataTableHead>
            <DataTableBody>
              {(pageItems ?? []).map((item, index) => (
                <DataTableRow key={item.id}>
                  <Td muted className="text-xs">{toPersianDigits(pageWindow.start + index + 1)}</Td>
                  <Td dir="ltr" muted className="text-xs">
                    {item.sku ?? "—"}
                  </Td>
                  <Td className="font-medium">{item.name}</Td>
                  {(["sale", "purchase"] as const).map((column) => (
                    <Td key={column}>
                      <PriceCell
                        itemId={item.id}
                        column={column}
                        label={`${column === "sale" ? "قیمت فروش" : "قیمت خرید"} ${item.name}`}
                        value={cells[item.id]?.[column] ?? ""}
                        changed={(initial[item.id]?.[column] ?? "") !== (cells[item.id]?.[column] ?? "")}
                        onChange={setCell}
                      />
                    </Td>
                  ))}
                  {lists.map((list) => (
                    <Td key={list.id}>
                      <PriceCell
                        itemId={item.id}
                        column={list.id}
                        label={`${list.name} ${item.name}`}
                        value={cells[item.id]?.[list.id] ?? ""}
                        changed={(initial[item.id]?.[list.id] ?? "") !== (cells[item.id]?.[list.id] ?? "")}
                        conflict={entryKey(list.id, item.id) in conflicts}
                        onChange={setCell}
                      />
                    </Td>
                  ))}
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
        {filtered && filtered.length > 0 && (pageWindow.pageCount > 1 || editedElsewhere > 0) ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/80 p-4 text-xs text-muted-foreground">
            <span>
              {`کالای ${toPersianDigits(pageWindow.start + 1)} تا ${toPersianDigits(pageWindow.end)} از ${toPersianDigits(filtered.length)}`}
              {editedElsewhere > 0
                ? ` — ${toPersianDigits(editedElsewhere)} کالای دیگر هم تغییر ذخیره‌نشده دارد و با «ذخیره» ثبت می‌شود.`
                : ""}
            </span>
            {pageWindow.pageCount > 1 ? (
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pageWindow.page <= 1}
                  onClick={() => setPage(pageWindow.page - 1)}
                >
                  قبلی
                </Button>
                <span aria-live="polite">
                  {`صفحهٔ ${toPersianDigits(pageWindow.page)} از ${toPersianDigits(pageWindow.pageCount)}`}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pageWindow.page >= pageWindow.pageCount}
                  onClick={() => setPage(pageWindow.page + 1)}
                >
                  بعدی
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </SectionCard>

      <ListsModal
        open={listsModal}
        onOpenChange={setListsModal}
        lists={lists}
        hasUnsaved={dirty.length > 0}
        onChanged={load}
      />
      <QuickUpdateModal
        open={quickModal}
        onOpenChange={setQuickModal}
        lists={lists}
        hasUnsaved={dirty.length > 0}
        onApplied={async () => {
          await load();
          setNotice("بروزرسانی سریع اعمال شد.");
        }}
      />
    </div>
  );
}

function PriceCell({
  itemId,
  column,
  label,
  value,
  changed,
  conflict = false,
  onChange,
}: {
  itemId: string;
  column: ColumnKey;
  label: string;
  value: string;
  changed: boolean;
  /** Someone else changed this cell after it loaded; the save refused it. */
  conflict?: boolean;
  onChange: (itemId: string, column: ColumnKey, value: string) => void;
}) {
  const invalid = cellError(value);
  return (
    <PersianNumberInput
      className={`${inputClass} min-h-9 w-28 text-xs ${
        invalid || conflict
          ? "border-destructive text-destructive focus-visible:border-destructive"
          : changed
            ? "border-amber-500 bg-amber-50 dark:bg-amber-950/30"
            : ""
      }`}
      dir="ltr"
      inputMode="numeric"
      // Prices are whole units of money and never negative; letting a «-» be
      // typed produced a cell the server refused with no explanation.
      allowNegative={false}
      allowDecimal={false}
      value={value}
      aria-label={conflict ? `${label} (تغییر هم‌زمان؛ ذخیره نشد)` : label}
      aria-invalid={invalid || conflict || undefined}
      onChange={(event) => onChange(itemId, column, event.target.value)}
      placeholder="—"
    />
  );
}

/** The «لیست قیمت‌ها» modal: add, rename and delete the named lists. */
function ListsModal({
  open,
  onOpenChange,
  lists,
  hasUnsaved,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lists: PriceList[];
  hasUnsaved: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Reopening the modal used to show the previous attempt's error and a
  // half-finished rename.
  useEffect(() => {
    if (open) return;
    setName("");
    setEditing(null);
    setEditName("");
    setConfirming(null);
    setError("");
  }, [open]);

  async function add() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("نام لیست قیمت را وارد کنید.");
      return;
    }
    if (lists.some((list) => list.name.trim() === trimmed)) {
      setError("لیستی با همین نام وجود دارد.");
      return;
    }
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string }>("/api/products/price-lists", {
      method: "POST",
      body: JSON.stringify({ name: trimmed }),
    });
    if (!ok) {
      setBusy(false);
      setError(errorMessage(data.error));
      return;
    }
    setName("");
    await onChanged();
    setBusy(false);
  }

  async function rename(id: string) {
    const trimmed = editName.trim();
    if (!trimmed) {
      setError("نام لیست قیمت را وارد کنید.");
      return;
    }
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string }>(`/api/products/price-lists/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: trimmed }),
    });
    if (!ok) {
      // A failed rename used to leave the row in edit mode with no message at
      // all, so a duplicate name looked like the button was dead.
      setBusy(false);
      setError(errorMessage(data.error));
      return;
    }
    setEditing(null);
    await onChanged();
    setBusy(false);
  }

  async function remove(id: string) {
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string }>(`/api/products/price-lists/${id}`, {
      method: "DELETE",
    });
    if (!ok) {
      setBusy(false);
      setError(errorMessage(data.error));
      return;
    }
    setConfirming(null);
    await onChanged();
    setBusy(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>لیست قیمت‌ها</DialogTitle>
          <DialogDescription>
            هر لیست یک ستون قیمت در جدول است (مثلاً «عمده» یا «همکار»). حذف یک لیست، قیمت‌های ثبت‌شده
            در آن ستون را هم پاک می‌کند.
          </DialogDescription>
        </DialogHeader>

        {hasUnsaved ? (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            تغییرات ذخیره‌نشده‌ای در جدول دارید؛ افزودن یا حذف لیست، جدول را دوباره می‌خواند و آن
            تغییرات از بین می‌رود.
          </p>
        ) : null}

        <ul className="max-h-64 space-y-2 overflow-y-auto">
          {lists.map((list) => (
            <li
              key={list.id}
              className="rounded-xl border border-border/80 bg-muted/40 px-3 py-2"
            >
              <div className="flex items-center gap-2">
                {editing === list.id ? (
                  <>
                    <input
                      className={`${inputClass} min-h-9`}
                      value={editName}
                      maxLength={60}
                      onChange={(event) => setEditName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void rename(list.id);
                        }
                        if (event.key === "Escape") setEditing(null);
                      }}
                      aria-label={`نام تازهٔ ${list.name}`}
                      autoFocus
                    />
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy || !editName.trim()}
                      onClick={() => rename(list.id)}
                    >
                      ذخیره
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setEditing(null)}
                    >
                      انصراف
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                      {list.name}{" "}
                      <span className="text-xs text-muted-foreground">({list.currency})</span>
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="size-9 shrink-0 p-0"
                      aria-label={`ویرایش ${list.name}`}
                      disabled={busy}
                      onClick={() => {
                        setError("");
                        setConfirming(null);
                        setEditing(list.id);
                        setEditName(list.name);
                      }}
                    >
                      <PencilIcon aria-hidden="true" className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="size-9 shrink-0 p-0 text-destructive"
                      aria-label={`حذف ${list.name}`}
                      disabled={busy}
                      onClick={() => {
                        setError("");
                        setConfirming(list.id);
                      }}
                    >
                      <Trash2Icon aria-hidden="true" className="size-4" />
                    </Button>
                  </>
                )}
              </div>

              {/*
                Deleting a list drops every price in that column, and the old
                icon button did it on the first click with no confirmation and
                no undo.
              */}
              {confirming === list.id ? (
                <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border/60 pt-2">
                  <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                    «{list.name}» و همهٔ قیمت‌های آن حذف شود؟
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={busy}
                    onClick={() => remove(list.id)}
                  >
                    حذف
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setConfirming(null)}
                  >
                    انصراف
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
          {lists.length === 0 ? (
            <li className="text-xs text-muted-foreground">لیست قیمتی تعریف نشده است.</li>
          ) : null}
        </ul>

        <DialogFooter className="flex-col gap-2 sm:flex-col sm:items-stretch">
          <div className="flex w-full flex-wrap items-center gap-2">
            <input
              className={`${inputClass} flex-1`}
              value={name}
              maxLength={60}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                void add();
              }}
              aria-label="نام لیست قیمت جدید"
              placeholder="نام لیست جدید (مثلاً عمده)"
            />
            <Button type="button" disabled={busy || !name.trim()} onClick={add}>
              <PlusIcon aria-hidden="true" className="size-4" />
              افزودن
            </Button>
          </div>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The «تغییر قیمت سریع» modal: percent/amount over one column, optional round. */
function QuickUpdateModal({
  open,
  onOpenChange,
  lists,
  hasUnsaved,
  onApplied,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lists: PriceList[];
  hasUnsaved: boolean;
  onApplied: () => Promise<void> | void;
}) {
  const money = useMoney();
  const [target, setTarget] = useState<string>("sale");
  const [mode, setMode] = useState<"percent" | "amount">("percent");
  const [direction, setDirection] = useState<"increase" | "decrease">("increase");
  const [value, setValue] = useState("");
  const [round, setRound] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) return;
    setValue("");
    setError("");
    setConfirming(false);
    setBusy(false);
  }, [open]);

  // A list can be deleted while this modal remembers it as the target, which
  // would post an id the server no longer knows.
  useEffect(() => {
    if (target === "sale" || target === "purchase") return;
    if (!lists.some((list) => list.id === target)) setTarget("sale");
  }, [lists, target]);

  const numeric = Number(value.trim());
  const valid = value.trim() !== "" && Number.isFinite(numeric) && numeric > 0;
  const signed = direction === "increase" ? numeric : -numeric;
  const targetLabel =
    target === "sale"
      ? "قیمت فروش"
      : target === "purchase"
        ? "قیمت خرید"
        : (lists.find((list) => list.id === target)?.name ?? "");

  async function apply() {
    if (!valid) {
      setError("مقدار تغییر را به‌صورت عددی بزرگ‌تر از صفر وارد کنید.");
      return;
    }
    // The old field accepted a raw «-۱۰۰۰٪», which the server clamps to zero —
    // i.e. it silently unpriced the whole branch. Direction is a separate,
    // explicit control now and a percent cut cannot exceed 100.
    if (mode === "percent" && direction === "decrease" && numeric > 100) {
      setError("کاهش درصدی نمی‌تواند بیش از ۱۰۰٪ باشد.");
      return;
    }
    setBusy(true);
    setError("");
    const targetBody =
      target === "sale"
        ? { kind: "sale" }
        : target === "purchase"
          ? { kind: "purchase" }
          : { kind: "list", priceListId: target };
    // The value travels in the *stored* unit (Rial) for an amount move; sending
    // the business's display number meant a Toman business shifted every price
    // by a tenth of what it typed.
    const payloadValue = mode === "percent" ? signed : money.fromInput(Math.round(signed));
    const { ok, data } = await api<{ error?: string; changed?: number }>(
      "/api/products/price-lists/quick-update",
      {
        method: "POST",
        body: JSON.stringify({ target: targetBody, mode, value: payloadValue, round }),
      },
    );
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    onOpenChange(false);
    await onApplied();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>تغییر قیمت سریع</DialogTitle>
          <DialogDescription>
            یک درصد یا مبلغ ثابت روی همهٔ قیمت‌های یک ستون اعمال می‌شود. این کار بازگشت‌پذیر نیست.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Field label="اعمال بر لیست">
            <select
              className={inputClass}
              value={target}
              onChange={(event) => {
                setTarget(event.target.value);
                setConfirming(false);
              }}
            >
              <option value="sale">قیمت فروش</option>
              <option value="purchase">قیمت خرید</option>
              {lists.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="جهت تغییر" as="div">
            <select
              className={inputClass}
              value={direction}
              onChange={(event) => setDirection(event.target.value as "increase" | "decrease")}
              aria-label="جهت تغییر"
            >
              <option value="increase">افزایش</option>
              <option value="decrease">کاهش</option>
            </select>
          </Field>

          <Field label={mode === "percent" ? "مقدار تغییر (درصد)" : `مقدار تغییر (${money.unitLabel})`} as="div">
            {/*
              `flex-wrap` and a full-width input: at 360px the select, the input
              and the «٪» used to be squeezed onto one line until the number
              field was about three characters wide.
            */}
            <div className="flex flex-wrap items-center gap-2">
              <select
                className={`${inputClass} w-auto flex-none`}
                value={mode}
                onChange={(event) => setMode(event.target.value as "percent" | "amount")}
                aria-label="نوع تغییر"
              >
                <option value="percent">درصدی</option>
                <option value="amount">مبلغی</option>
              </select>
              <div className="flex min-w-[8rem] flex-1 items-center gap-2">
                <PersianNumberInput
                  className={inputClass}
                  dir="ltr"
                  allowNegative={false}
                  allowDecimal={false}
                  value={value}
                  onChange={(event) => {
                    setValue(event.target.value);
                    setConfirming(false);
                  }}
                  aria-label="مقدار تغییر"
                  placeholder={mode === "percent" ? "۱۰" : "۵۰۰۰"}
                />
                <span className="shrink-0 text-sm text-muted-foreground">
                  {mode === "percent" ? "٪" : money.unitLabel}
                </span>
              </div>
            </div>
          </Field>

          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={round}
              onChange={(event) => setRound(event.target.checked)}
              className="size-4 accent-amber-600"
            />
            گرد کردن به نزدیک‌ترین هزار تومان
          </label>

          {hasUnsaved ? (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              تغییرات ذخیره‌نشده‌ای در جدول دارید و پس از این بروزرسانی از بین می‌رود.
            </p>
          ) : null}

          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-col sm:items-stretch">
          {confirming ? (
            <>
              <p className="text-xs text-muted-foreground">
                همهٔ قیمت‌های ستون «{targetLabel}»{" "}
                {direction === "increase" ? "افزایش" : "کاهش"} می‌یابد به اندازهٔ{" "}
                {toPersianDigits(numeric)}
                {mode === "percent" ? "٪" : ` ${money.unitLabel}`}. ادامه می‌دهید؟
              </p>
              <div className="flex gap-2">
                <Button type="button" className="flex-1" disabled={busy} onClick={apply}>
                  {busy ? "در حال اعمال…" : "بله، اعمال کن"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1"
                  disabled={busy}
                  onClick={() => setConfirming(false)}
                >
                  انصراف
                </Button>
              </div>
            </>
          ) : (
            <Button
              type="button"
              className="w-full"
              disabled={busy || !valid}
              onClick={() => {
                setError("");
                setConfirming(true);
              }}
            >
              اعمال تغییرات
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
