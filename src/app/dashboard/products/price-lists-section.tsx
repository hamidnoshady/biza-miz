"use client";

/**
 * Phase 42 — «لیست قیمت»: the reference's price-update matrix on the
 * platform's chrome. Sale and purchase columns write the trade's own stock
 * route (the one writer the invoice screen trusts); named list columns write
 * `price_list_entries`. «بروزرسانی سریع» moves a whole column by percent or
 * amount with an optional round, and the lists modal adds/renames/deletes the
 * named lists themselves.
 *
 * Hardened per #924: costing safety (purchase bulk guard), permission parity,
 * explicit scope, atomic save with stock versioning, failed-edit preservation,
 * unsaved-draft interlock, immutable history, zero/blank semantics,
 * currency/precision, preview, scalability, cosmetics read-only, and CSV fix.
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
import type { PriceMatrixRow } from "@/lib/price-lists-service";
import type { PriceEntry, PriceList } from "@/lib/price-lists-service";
import { entryKey, type EntryConflict } from "@/lib/price-list-conflicts";
import { formatJalali } from "@/lib/jalali";
import { api, ErrorBox, errorMessage, Field, InfoBox, inputClass } from "../ui";
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
type StockConflict = { itemId: string; kind: "sale" | "purchase"; requestedPrice: number | null; currentPrice: number | null; currentVersion: string | null; updatedAt: string | null; value: string; sentVersion: string | null };
type PendingStockConflicts = Record<string, StockConflict>;

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
  // F08/F10: require integer, non-negative, safe integer, and no fractional
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric < 0) return true;
  if (numeric > Number.MAX_SAFE_INTEGER) return true;
  return false;
}

// F08: explicit zero/blank semantics helper
function zeroSemantics(value: string, kind: "sale" | "purchase" | "list"): { empty: boolean; zero: boolean; valid: boolean } {
  const trimmed = value.trim();
  if (trimmed === "") return { empty: true, zero: false, valid: true };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return { empty: false, zero: false, valid: false };
  return { empty: false, zero: n === 0, valid: true };
}

export function PriceListsSection({ apiBase, canEdit = true }: { apiBase: string; canEdit?: boolean }) {
  const money = useMoney();
  const [items, setItems] = useState<PriceMatrixRow[] | null>(null);
  // The catalogue size, not the page size: paging is server-side now.
  const [total, setTotal] = useState(0);
  const [lists, setLists] = useState<PriceList[]>([]);
  const [cells, setCells] = useState<Cells>({});
  const [initial, setInitial] = useState<Cells>({});
  // `entryKey(list, item)` → the version each filled list cell had when loaded.
  // A cell with no key was empty, which the save sends as `null`.
  const [versions, setVersions] = useState<Record<string, string>>({});
  const [conflicts, setConflicts] = useState<Record<string, PendingConflict>>({});
  const [stockConflicts, setStockConflicts] = useState<PendingStockConflicts>({});
  const [stockVersions, setStockVersions] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const deferredSearch = useDeferredValue(search);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [listsModal, setListsModal] = useState(false);
  const [csvBusy, setCsvBusy] = useState(false);
  const [quickModal, setQuickModal] = useState(false);
  // F13: cosmetics industry has batch-derived cost — make purchase column read-only
  const isCosmetics = apiBase.includes("cosmetics");
  // F02: a member with `inventory.view` but not `inventory.adjust` may read the
  // matrix; every write route already answers 403 to them, so the grid must not
  // offer an edit that is certain to fail.
  const editDeniedReason = "دسترسی «اصلاح موجودی» ندارید؛ قیمت‌ها را فقط می‌توانید ببینید.";

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
   * F05: now also keeps stock conflicts/skipped and unapplied drafts.
   */
  // Drafts must survive a page or search change, so the merge below reads the
  // latest cells/initial rather than the closure that started the request.
  const cellsRef = useRef<Cells>({});
  cellsRef.current = cells;
  const initialRef = useRef<Cells>({});
  initialRef.current = initial;

  /**
   * Loads one bounded page of the matrix (issue #924 F12). The server returns
   * the item window, the filled cells for *that window only*, and the catalogue
   * total; nothing here scales with the number of products. Search and paging
   * are query parameters, so a 1,685-item shop reads 50 rows per page.
   */
  const load = useCallback(
    async (
      signal?: AbortSignal,
      keep: Record<string, PendingConflict> = {},
      keepStock: PendingStockConflicts = {},
      // F05: preserve unapplied stock failures/skips
      preserveDrafts?: Cells,
      query: { q?: string; page?: number } = {},
    ) => {
      const ticket = ++requestId.current;
      const pageNumber = Math.max(1, query.page ?? 1);
      const params = new URLSearchParams({
        limit: String(PRICE_PAGE_SIZE),
        offset: String((pageNumber - 1) * PRICE_PAGE_SIZE),
      });
      const needle = query.q?.trim();
      if (needle) params.set("q", needle);
      const res = await api<{
        error?: string;
        lists: PriceList[];
        items: PriceMatrixRow[];
        entries: PriceEntry[];
        total: number;
      }>(`/api/products/price-lists?${params.toString()}`, { signal });
      if (res.aborted || ticket !== requestId.current) return;
      if (!res.ok) {
        setLoadError(errorMessage(res.data.error));
        setItems((current) => current ?? []);
        return;
      }
      setLoadError("");

      const convert = moneyRef.current;
      const priced = res.data.items;
      const entryPrice = new Map(
        res.data.entries.map((entry) => [`${entry.priceListId}:${entry.itemId}`, entry.price]),
      );
      const next: Cells = {};
      for (const item of priced) {
        const row: Row = {
          sale: item.unitPrice != null ? String(convert.toInput(item.unitPrice)) : "",
          purchase: item.unitCost != null ? String(convert.toInput(item.unitCost)) : "",
        };
        for (const list of res.data.lists) {
          const price = entryPrice.get(`${list.id}:${item.id}`);
          row[list.id] = price != null ? String(convert.toInput(price)) : "";
        }
        next[item.id] = row;
      }

      const baseline = Object.fromEntries(Object.entries(next).map(([id, row]) => [id, { ...row }]));
      const kept: Record<string, PendingConflict> = {};
      for (const [key, conflict] of Object.entries(keep)) {
        const row = next[conflict.itemId];
        if (!row || !(conflict.priceListId in row)) continue;
        row[conflict.priceListId] = conflict.value;
        kept[key] = conflict;
      }
      // F05: preserve drafts for failed stock cells and skipped reasons
      const keptStock: PendingStockConflicts = {};
      for (const [key, sc] of Object.entries(keepStock)) {
        const [kind, itemId] = key.split(":");
        if (!next[itemId] || !(kind in next[itemId])) continue;
        next[itemId][kind] = sc.value;
        keptStock[key] = sc;
      }
      if (preserveDrafts) {
        // These are exactly the cells the save could not apply (failed request,
        // conflict, or skipped guard). Restore them unconditionally: a reload
        // must never make an unapplied value look saved or silently drop it.
        for (const [itemId, row] of Object.entries(preserveDrafts)) {
          if (!next[itemId]) continue;
          for (const [col, val] of Object.entries(row)) {
            if (next[itemId][col] !== undefined) next[itemId][col] = val;
          }
        }
      }

      // Merge rather than replace: cells typed on another page are still
      // unsaved, and the reload of this page must not resurrect the server's
      // value over a draft the user has not saved yet.
      const previousCells = cellsRef.current;
      const previousInitial = initialRef.current;
      const mergedCells: Cells = { ...previousCells, ...next };
      for (const item of priced) {
        const typedRow = previousCells[item.id];
        const baseRow = previousInitial[item.id] ?? {};
        if (!typedRow) continue;
        for (const [col, val] of Object.entries(typedRow)) {
          if ((baseRow[col] ?? "").trim() !== val.trim()) mergedCells[item.id][col] = val;
        }
      }

      setItems(priced);
      setLists(res.data.lists);
      setTotal(res.data.total);
      setCells(mergedCells);
      setInitial((current) => ({ ...current, ...baseline }));
      setVersions((current) => ({
        ...current,
        ...Object.fromEntries(
          res.data.entries.map((entry) => [entryKey(entry.priceListId, entry.itemId), entry.version]),
        ),
      }));
      setConflicts((current) => ({ ...current, ...kept }));
      setStockConflicts((current) => ({ ...current, ...keptStock }));
      // Sale and purchase are two cells of the same item_stock row, so both
      // keys share its version. (A previous map only emitted the sale key,
      // making every purchase edit look like a stale write.)
      setStockVersions((current) => ({
        ...current,
        ...Object.fromEntries(
          priced.flatMap((item) =>
            item.version == null ? [] : [[`sale:${item.id}`, item.version], [`purchase:${item.id}`, item.version]],
          ),
        ),
      }));
    },
    // The matrix endpoint is shared: only `PRICE_PAGE_SIZE` shapes the request.
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal, undefined, undefined, undefined, { q: deferredSearch, page });
    return () => controller.abort();
  }, [load, deferredSearch, page]);

  // One bounded page (audit F14). Edits are keyed by item in `cells`, never by
  // row position, so paging and filtering keep them. The server already
  // filtered and paged, so `items` *is* the page.
  const pageWindow = tablePageWindow(total, page, PRICE_PAGE_SIZE);
  const pageItems = items;
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
    const priceOf = (value: string) => (value.trim() === "" ? null : convert.fromInput(Math.round(Number(value.trim()))));

    const entryUpdates = dirty.filter((u) => u.column !== "sale" && u.column !== "purchase");
    const stockUpdates = dirty.filter((u) => u.column === "sale" || u.column === "purchase");
    const failures: string[] = [];
    const refused: Record<string, PendingConflict> = {};
    const refusedStock: PendingStockConflicts = {};
    const skipped: { itemId: string; kind: string; reason: string }[] = [];
    // Cells whose request failed outright: their stored value is unknown, so the
    // draft must survive the reload (F05).
    const failedCells = new Set<string>();
    let entryTouched = 0;
    let stockTouched = 0;

    // F12: batch entries over 2000 via chunking (explicit ceilings, recoverable partial results)
    const ENTRY_CHUNK = 2000;
    if (entryUpdates.length > 0) {
      const expectedOf = (key: string) => (key in conflicts ? conflicts[key].sentVersion : (versions[key] ?? null));
      const typed = new Map(entryUpdates.map((u) => [entryKey(u.column, u.itemId), u.value]));
      for (let i = 0; i < entryUpdates.length; i += ENTRY_CHUNK) {
        const chunk = entryUpdates.slice(i, i + ENTRY_CHUNK);
        const { ok, data } = await api<{ error?: string; conflicts?: EntryConflict[]; touched?: number }>(
          "/api/products/price-lists/entries",
          {
            method: "PUT",
            body: JSON.stringify({
              updates: chunk.map((u) => ({
                priceListId: u.column,
                itemId: u.itemId,
                price: priceOf(u.value),
                expectedVersion: expectedOf(entryKey(u.column, u.itemId)),
              })),
            }),
          },
        );
        if (!ok) {
          failures.push(errorMessage((data as { error?: string }).error));
          for (const u of chunk) failedCells.add(entryKey(u.column, u.itemId));
        } else entryTouched += (data as { touched?: number }).touched ?? 0;
        for (const conflict of (ok ? (data as { conflicts?: EntryConflict[] }).conflicts : undefined) ?? []) {
          const key = entryKey(conflict.priceListId, conflict.itemId);
          refused[key] = { ...conflict, value: typed.get(key) ?? "", sentVersion: expectedOf(key) };
        }
      }
    }

    // F04: stock prices via batch endpoint with versioning, F01 purchase guard, F08 zero semantics
    if (stockUpdates.length > 0) {
      const STOCK_CHUNK = 2000;
      for (let i = 0; i < stockUpdates.length; i += STOCK_CHUNK) {
        const chunk = stockUpdates.slice(i, i + STOCK_CHUNK);
        const typedStock = new Map(chunk.map((u) => [`${u.column}:${u.itemId}`, u.value]));
        const expectedStockOf = (key: string) => (key in stockConflicts ? stockConflicts[key].sentVersion : (stockVersions[key] ?? null));
        const payload = chunk.map((u) => ({
          itemId: u.itemId,
          kind: u.column as "sale" | "purchase",
          price: priceOf(u.value),
          expectedVersion: expectedStockOf(`${u.column}:${u.itemId}`),
        }));
        // Filter out clears (null) — they are skipped, not failures (F08)
        const nonEmpty = payload.filter((p) => p.price !== null);
        const cleared = payload.filter((p) => p.price === null);
        for (const c of cleared) {
          skipped.push({ itemId: c.itemId, kind: c.kind, reason: "clear_not_supported" });
        }
        if (nonEmpty.length === 0) continue;
        const { ok, data } = await api<{ error?: string; touched?: number; conflicts?: StockConflict[]; skipped?: typeof skipped }>(
          "/api/products/price-lists/stock",
          {
            method: "PUT",
            body: JSON.stringify({ updates: nonEmpty }),
          },
        );
        if (!ok) {
          failures.push(errorMessage((data as { error?: string }).error));
          for (const c of chunk) failedCells.add(`${c.column}:${c.itemId}`);
        } else stockTouched += (data as { touched?: number }).touched ?? 0;
        for (const sc of (ok ? (data as { conflicts?: StockConflict[] }).conflicts : undefined) ?? []) {
          const key = `${sc.kind}:${sc.itemId}`;
          refusedStock[key] = { ...sc, value: typedStock.get(key) ?? "", sentVersion: expectedStockOf(key) };
        }
        for (const sk of (ok ? (data as { skipped?: typeof skipped }).skipped : undefined) ?? []) {
          skipped.push(sk);
        }
      }
    }

    const clearedStock = stockUpdates.filter((u) => u.value.trim() === "").length;
    const conflictCount = Object.keys(refused).length + Object.keys(refusedStock).length;
    setBusy(false);

    // F05: preserve every failed/unapplied cell and reason
    const hasFailures = failures.length > 0;
    const hasConflicts = conflictCount > 0;
    const hasSkips = skipped.length > 0;

    if (hasFailures || hasConflicts || hasSkips) {
      if (hasFailures) setError([...new Set(failures)].join(" "));
      else if (hasConflicts)
        setError(
          `${toPersianDigits(conflictCount)} قیمت ذخیره نشد، چون پس از باز شدن این صفحه کس دیگری آن را تغییر داده است. بقیهٔ تغییرات ذخیره شد؛ برای هر مورد مقدار فعلی را بارگذاری کنید یا آگاهانه مقدار خود را جایگزین کنید.`,
        );
      else if (hasSkips) {
        const purchaseLocks = skipped.filter((s) => s.reason === "purchase_cost_locked_with_stock").length;
        if (purchaseLocks > 0) setError(`${toPersianDigits(purchaseLocks)} قیمت خرید به‌خاطر موجودی غیرصفر تغییر نکرد (قیمت خرید با موجودی قفل است).`);
        else setError(`${toPersianDigits(skipped.length)} مورد بدون تغییر ماند (خالی یا صفر نامعتبر).`);
      }
      // Preserve drafts for failed/skipped
      const preserve: Cells = {};
      for (const u of dirty) {
        const key = u.column === "sale" || u.column === "purchase" ? `${u.column}:${u.itemId}` : entryKey(u.column, u.itemId);
        if (
          failedCells.has(key) ||
          refused[key] ||
          refusedStock[key] ||
          skipped.some((s) => s.itemId === u.itemId && s.kind === u.column)
        ) {
          if (!preserve[u.itemId]) preserve[u.itemId] = {};
          preserve[u.itemId][u.column] = u.value;
        }
      }
      await load(undefined, refused, refusedStock, preserve, { q: deferredSearch, page });
      return;
    }

    // F08: accurate reporting — no "success" when changed:0
    const totalTouched = entryTouched + stockTouched;
    if (totalTouched === 0 && dirty.length > 0) {
      setNotice("هیچ قیمتی تغییر نکرد — مقادیر واردشده با مقادیر فعلی یکسان بود.");
      await load(undefined, undefined, undefined, undefined, { q: deferredSearch, page });
      return;
    }
    setNotice(clearedStock > 0 ? "قیمت‌ها ذخیره شد. خالی‌کردن قیمت فروش/خرید ممکن نیست و این ستون‌ها بدون تغییر ماندند." : "قیمت‌ها ذخیره شد.");
    await load();
  }

  function discard() {
    setCells(Object.fromEntries(Object.entries(initial).map(([id, row]) => [id, { ...row }])));
    setConflicts({});
    setStockConflicts({});
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

  /**
   * Exports the *filtered* set, not just the page on screen. Each request is a
   * bounded 200-row window (the matrix endpoint's maximum), read in sequence —
   * a big catalogue is exported without ever asking the server for all of it
   * at once.
   */
  async function downloadCsv() {
    if (!items || total === 0 || csvBusy) return;
    setCsvBusy(true);
    setError("");
    try {
      const convert = moneyRef.current;
      const EXPORT_PAGE = 200;
      const exported: PriceMatrixRow[] = [];
      const prices = new Map<string, number>();
      const exportLists = new Map<string, string>();
      for (let offset = 0; ; offset += EXPORT_PAGE) {
        const params = new URLSearchParams({ limit: String(EXPORT_PAGE), offset: String(offset) });
        if (search.trim()) params.set("q", search.trim());
        const res = await api<{
          error?: string;
          lists: PriceList[];
          items: PriceMatrixRow[];
          entries: PriceEntry[];
          total: number;
        }>(`/api/products/price-lists?${params.toString()}`);
        if (!res.ok) {
          setError(errorMessage(res.data.error));
          return;
        }
        for (const list of res.data.lists) exportLists.set(list.id, list.name);
        for (const entry of res.data.entries) prices.set(`${entry.priceListId}:${entry.itemId}`, entry.price);
        exported.push(...res.data.items);
        if (res.data.items.length === 0 || exported.length >= res.data.total) break;
      }

      const columns = [...exportLists.entries()];
      const unit = money.unitLabel;
      const head = [
        "کد کالا",
        "بارکد",
        "عنوان کالا",
        `قیمت فروش (${unit})`,
        `قیمت خرید (${unit})`,
        ...columns.map(([, name]) => `${name} (${unit})`),
      ];
      const lines = exported.map((item) => {
        const row = cells[item.id] ?? {};
        const cell = (value: string | number | null | undefined) =>
          value === null || value === undefined ? "" : String(value).trim();
        const stored = (column: string, price: number | null) =>
          price == null ? "" : String(convert.toInput(price));
        const named = (listId: string) => stored(listId, prices.get(`${listId}:${item.id}`) ?? null);
        return [
          item.sku ?? "",
          item.barcode ?? "",
          item.name,
          row.sale !== undefined ? cell(row.sale) : stored("sale", item.unitPrice),
          row.purchase !== undefined ? cell(row.purchase) : stored("purchase", item.unitCost),
          ...columns.map(([id]) => (row[id] !== undefined ? cell(row[id]) : named(id))),
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
    } finally {
      setCsvBusy(false);
    }
  }

  const columnCount = 3 + 2 + lists.length;

  return (
    <div className="min-w-0 space-y-4 sm:space-y-5">
      <ErrorBox>{loadError || error}</ErrorBox>
      {canEdit ? null : <InfoBox>{editDeniedReason}</InfoBox>}

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
          onClick={() => void downloadCsv()}
          disabled={!items || total === 0 || csvBusy}
        >
          <FileSpreadsheetIcon aria-hidden="true" className="size-4" />
          دانلود CSV لیست قیمت
        </Button>
        {canEdit ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setQuickModal(true)}>
            <RefreshCwIcon aria-hidden="true" className="size-4" />
            بروزرسانی سریع
          </Button>
        ) : null}
        {canEdit ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setListsModal(true)}>
            <PlusIcon aria-hidden="true" className="size-4" />
            مدیریت لیست‌های قیمت
          </Button>
        ) : null}
        {canEdit && dirty.length > 0 ? (
          <Button type="button" variant="ghost" size="sm" onClick={discard} disabled={busy}>
            <XIcon aria-hidden="true" className="size-4" />
            لغو تغییرات
          </Button>
        ) : null}
        {canEdit ? (
          <Button type="button" size="sm" onClick={saveAll} disabled={busy || dirty.length === 0}>
            <SaveIcon aria-hidden="true" className="size-4" />
            {busy
              ? "در حال ذخیره…"
              : dirty.length > 0
                ? `ذخیره ${toPersianDigits(dirty.length)} تغییر`
                : "ذخیره قیمت‌ها"}
          </Button>
        ) : null}
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
      {Object.keys(stockConflicts).length > 0 ? (
        <SectionCard
          title="قیمت فروش/خرید هم‌زمان تغییر کرده"
          description="این قیمت‌های انبار پس از باز شدن صفحه تغییر کرده‌اند و ذخیره نشدند."
          actions={
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => {
                setCells((cur) => {
                  const next = { ...cur };
                  for (const key of Object.keys(stockConflicts)) {
                    const [kind, itemId] = key.split(":");
                    if (!next[itemId]) continue;
                    next[itemId] = { ...next[itemId], [kind]: initial[itemId]?.[kind] ?? "" };
                  }
                  return next;
                });
                setStockConflicts({});
              }}>
                بارگذاری مقدار فعلی همه
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => { setStockConflicts({}); setNotice("مقدار شما با «ذخیره» جایگزین می‌شود."); }}>
                جایگزینی همه با مقدار من
              </Button>
            </div>
          }
        >
          <ul className="divide-y divide-border/80 text-sm">
            {Object.entries(stockConflicts).map(([key, sc]) => {
              const itemName = items?.find((item) => item.id === sc.itemId)?.name ?? "کالا";
              const label = sc.kind === "sale" ? "قیمت فروش" : "قیمت خرید";
              const mine = sc.value.trim() === "" ? "بدون قیمت" : `${toPersianDigits(sc.value.trim())} ${money.unitLabel}`;
              const theirs = sc.currentPrice == null ? "بدون قیمت" : money.format(sc.currentPrice, { withUnit: true });
              return (
                <li key={key} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0 space-y-1">
                    <p className="font-medium">{`${itemName} — ${label}`}</p>
                    <p className="text-xs text-muted-foreground">{`مقدار شما: ${mine} · مقدار فعلی: ${theirs}`}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="ghost" size="sm" onClick={() => {
                      setCells((cur) => ({ ...cur, [sc.itemId]: { ...cur[sc.itemId], [sc.kind]: initial[sc.itemId]?.[sc.kind] ?? "" } }));
                      setStockConflicts((cur) => { const n = { ...cur }; delete n[key]; return n; });
                    }}>بارگذاری مقدار فعلی</Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => { setStockConflicts((cur) => { const n = { ...cur }; delete n[key]; return n; }); }}>جایگزینی با مقدار من</Button>
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
          items
            ? `${toPersianDigits(total)} کالا${search.trim() ? " در این جستجو" : ""} — مبالغ به ${money.unitLabel} · ستون‌های نام‌دار (عمده، همکار، …) فقط قیمت مرجع‌اند: در فاکتور فروش و محاسبهٔ سود، ستون «قیمت فروش» اعمال می‌شود و این ستون‌ها هیچ نرخی را در جای دیگری بازنویسی نمی‌کنند.`
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
        {items === null ? (
          <div className="p-4 sm:p-5">
            <SectionCardSkeleton rows={6} />
          </div>
        ) : items.length === 0 ? (
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
                <Th key={list.id}>
                  <span className="inline-flex items-center gap-1">
                    {list.name}
                    {/*
                      F09 made explicit: a named list is a *reference* shelf.
                      Nothing in checkout, invoicing or costing resolves its
                      price — the «قیمت فروش» column does. Saying so on the
                      column itself stops a shopkeeper from assuming the label
                      sets what the customer pays.
                    */}
                    <span
                      className="rounded border border-border bg-muted px-1 py-0.5 text-[10px] font-normal text-muted-foreground"
                      title="قیمت مرجع: در فاکتور فروش و محاسبهٔ سود استفاده نمی‌شود؛ نرخ اعمال‌شده ستون «قیمت فروش» است."
                    >
                      مرجع
                    </span>
                  </span>
                </Th>
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
                        conflict={`${column}:${item.id}` in stockConflicts}
                        readOnly={!canEdit || (column === "purchase" && isCosmetics)}
                        readOnlyReason={
                          !canEdit
                            ? editDeniedReason
                            : column === "purchase" && isCosmetics
                              ? "در آرایشی، قیمت خرید از بهای هر لات محاسبه می‌شود"
                              : undefined
                        }
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
                        readOnly={!canEdit}
                        readOnlyReason={editDeniedReason}
                        onChange={setCell}
                      />
                    </Td>
                  ))}
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
        {items && items.length > 0 && (pageWindow.pageCount > 1 || editedElsewhere > 0) ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/80 p-4 text-xs text-muted-foreground">
            <span>
              {`کالای ${toPersianDigits(pageWindow.start + 1)} تا ${toPersianDigits(pageWindow.end)} از ${toPersianDigits(total)}`}
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
        onChanged={() => load(undefined, undefined, undefined, undefined, { q: deferredSearch, page })}
      />
      <QuickUpdateModal
        open={quickModal}
        onOpenChange={setQuickModal}
        lists={lists}
        hasUnsaved={dirty.length > 0}
        onApplied={async ({ changed, skipped }) => {
          await load(undefined, undefined, undefined, undefined, { q: deferredSearch, page });
          if (changed === 0) {
            setNotice(
              skipped > 0
                ? `هیچ قیمتی تغییر نکرد — ${toPersianDigits(skipped)} مورد به‌خاطر محدودیت‌ها (موجودی غیرصفر یا صفر شدن قیمت فروش) بدون تغییر ماند.`
                : "هیچ قیمتی تغییر نکرد — این تغییر مقداری را عوض نمی‌کند.",
            );
            return;
          }
          setNotice(
            skipped > 0
              ? `${toPersianDigits(changed)} قیمت بروزرسانی شد و ${toPersianDigits(skipped)} مورد بدون تغییر ماند.`
              : `${toPersianDigits(changed)} قیمت بروزرسانی شد.`,
          );
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
  readOnly = false,
  readOnlyReason,
  onChange,
}: {
  itemId: string;
  column: ColumnKey;
  label: string;
  value: string;
  changed: boolean;
  /** Someone else changed this cell after it loaded; the save refused it. */
  conflict?: boolean;
  readOnly?: boolean;
  readOnlyReason?: string;
  onChange: (itemId: string, column: ColumnKey, value: string) => void;
}) {
  const invalid = cellError(value);
  // F13: purchase cost locked in cosmetics — surface as disabled with explanation
  if (readOnly) {
    return (
      <div className="min-h-9 w-28 rounded-md border bg-muted px-2 py-1 text-xs text-muted-foreground flex items-center" title={readOnlyReason} aria-label={`${label} (قفل)`}>
        {value || "—"}
      </div>
    );
  }
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
    if (hasUnsaved && !window.confirm("تغییرات ذخیره‌نشده دارید که از بین می‌رود. ادامه می‌دهید؟")) return;
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
    if (hasUnsaved && !window.confirm("تغییرات ذخیره‌نشده دارید که از بین می‌رود. ادامه می‌دهید؟")) return;
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
    if (hasUnsaved && !window.confirm("تغییرات ذخیره‌نشده دارید که از بین می‌رود. ادامه می‌دهید؟")) return;
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
          <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            ⚠️ تغییرات ذخیره‌نشده‌ای در جدول دارید. افزودن/حذف/تغییر نام لیست باعث بارگذاری مجدد جدول و از دست رفتن تغییرات می‌شود. ابتدا «ذخیره» یا «لغو تغییرات» را بزنید، یا با آگاهی ادامه دهید.
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

/** The «تغییر قیمت سریع» modal: percent/amount over one column, optional round. F03/F11 hardened. */
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
  onApplied: (result: { changed: number; skipped: number }) => Promise<void> | void;
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
  const [preview, setPreview] = useState<{
    count: number;
    skippedCount: number;
    totalBefore: number | null;
    totalAfter: number | null;
    sample: { itemId: string; oldPrice: number | null; newPrice: number | null }[];
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    if (open) return;
    setValue("");
    setError("");
    setConfirming(false);
    setBusy(false);
    setPreview(null);
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

  async function doPreview() {
    if (!valid) {
      setError("مقدار تغییر را به‌صورت عددی بزرگ‌تر از صفر وارد کنید.");
      return;
    }
    if (mode === "percent" && direction === "decrease" && numeric > 100) {
      setError("کاهش درصدی نمی‌تواند بیش از ۱۰۰٪ باشد.");
      return;
    }
    setPreviewLoading(true);
    setError("");
    const targetBody = target === "sale" ? { kind: "sale" } : target === "purchase" ? { kind: "purchase" } : { kind: "list", priceListId: target };
    const payloadValue = mode === "percent" ? signed : money.fromInput(Math.round(signed));
    const { ok, data } = await api<{ error?: string; preview?: { count: number; sample: { itemId: string; oldPrice: number | null; newPrice: number | null }[]; willSkip?: unknown[] } }>(
      "/api/products/price-lists/quick-update",
      { method: "POST", body: JSON.stringify({ target: targetBody, mode, value: payloadValue, round, preview: true, scope: { kind: "all" } }) },
    );
    setPreviewLoading(false);
    if (!ok) { setError(errorMessage((data as { error?: string }).error)); return; }
    const p = (
      data as {
        preview?: {
          count: number;
          skippedCount?: number;
          totalBefore?: number;
          totalAfter?: number;
          sample: { itemId: string; oldPrice: number | null; newPrice: number | null }[];
        };
      }
    ).preview;
    if (p) {
      setPreview({
        count: p.count,
        skippedCount: p.skippedCount ?? 0,
        totalBefore: p.totalBefore ?? null,
        totalAfter: p.totalAfter ?? null,
        sample: p.sample,
      });
    }
  }

  async function apply() {
    if (!valid) {
      setError("مقدار تغییر را به‌صورت عددی بزرگ‌تر از صفر وارد کنید.");
      return;
    }
    if (mode === "percent" && direction === "decrease" && numeric > 100) {
      setError("کاهش درصدی نمی‌تواند بیش از ۱۰۰٪ باشد.");
      return;
    }
    if (hasUnsaved && !window.confirm("تغییرات ذخیره‌نشده دارید که پس از این بروزرسانی از بین می‌رود. ادامه می‌دهید؟")) return;
    setBusy(true);
    setError("");
    const targetBody = target === "sale" ? { kind: "sale" } : target === "purchase" ? { kind: "purchase" } : { kind: "list", priceListId: target };
    const payloadValue = mode === "percent" ? signed : money.fromInput(Math.round(signed));
    const { ok, data } = await api<{ error?: string; changed?: number; skipped?: number }>(
      "/api/products/price-lists/quick-update",
      { method: "POST", body: JSON.stringify({ target: targetBody, mode, value: payloadValue, round, scope: { kind: "all" } }) },
    );
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    const changed = (data as { changed?: number }).changed ?? 0;
    const skipped = (data as { skipped?: number }).skipped ?? 0;
    onOpenChange(false);
    await onApplied({ changed, skipped });
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

        {preview ? (
            <div className="rounded-lg bg-muted p-3 text-xs space-y-1">
              <p>
                پیش‌نمایش: {toPersianDigits(preview.count)} کالا تغییر می‌کند
                {preview.skippedCount > 0 ? ` · ${toPersianDigits(preview.skippedCount)} مورد بدون تغییر می‌ماند` : ""}.
              </p>
              {preview.count === 0 ? (
                <p className="text-muted-foreground">این تغییر هیچ قیمتی را عوض نمی‌کند؛ مقادیر فعلی از قبل همین‌اند یا خارج از محدوده‌اند.</p>
              ) : null}
              {preview.totalBefore != null && preview.totalAfter != null ? (
                <p className="text-muted-foreground">
                  جمع ستون: {money.format(preview.totalBefore, { withUnit: true })} → {money.format(preview.totalAfter, { withUnit: true })}
                </p>
              ) : null}
              {preview.sample.length > 0 ? (
                <ul className="list-disc ps-4 space-y-0.5">
                  {preview.sample.slice(0, 5).map((s, i) => (
                    <li key={i}>
                      {toPersianDigits(money.toInput(s.oldPrice ?? 0))} → {toPersianDigits(money.toInput(s.newPrice ?? 0))} {money.unitLabel}
                    </li>
                  ))}
                </ul>
              ) : null}
              {target === "purchase" ? <p className="text-amber-700 dark:text-amber-300">توجه: قیمت خرید تنها برای کالاهای با موجودی صفر تغییر می‌کند؛ بقیه بدون تغییر می‌مانند.</p> : null}
            </div>
          ) : null}
        <DialogFooter className="flex-col gap-2 sm:flex-col sm:items-stretch">
          {confirming ? (
            <>
              <p className="text-xs text-muted-foreground">
                همهٔ قیمت‌های ستون «{targetLabel}» {direction === "increase" ? "افزایش" : "کاهش"} می‌یابد به اندازهٔ {toPersianDigits(numeric)}{mode === "percent" ? "٪" : ` ${money.unitLabel}`}
                {preview ? ` — ${toPersianDigits(preview.count)} کالا تحت تأثیر قرار می‌گیرد` : ""}. ادامه می‌دهید؟
              </p>
              <div className="flex gap-2">
                <Button type="button" className="flex-1" disabled={busy} onClick={apply}>
                  {busy ? "در حال اعمال…" : "بله، اعمال کن"}
                </Button>
                <Button type="button" variant="outline" className="flex-1" disabled={busy} onClick={() => setConfirming(false)}>انصراف</Button>
              </div>
            </>
          ) : (
            <div className="flex gap-2">
              <Button type="button" variant="outline" className="flex-1" disabled={previewLoading || !valid} onClick={doPreview}>
                {previewLoading ? "در حال پیش‌نمایش…" : "پیش‌نمایش"}
              </Button>
              <Button type="button" className="flex-1" disabled={busy || !valid} onClick={() => { setError(""); setConfirming(true); }}>اعمال تغییرات</Button>
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
