"use client";

/**
 * Phase 42b — the retail «انبارها» group.
 *
 * The retail catalogue has its own item/stock model, so this component keeps
 * the retail endpoint and types separate from the F&B warehouse screen. The
 * list UX is intentionally the same: search, status filtering, summaries,
 * responsive cards and a direct stock action.
 */
import { PlusIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { toLatinDigits, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { api, ErrorBox, Field, inputClass } from "../ui";
import { EmptyState, LoadingSkeleton, SectionCard, StatusBadge } from "../page-chrome";
import { FilterChip, FilterChipRow, SearchField } from "@/app/dashboard/filters";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";

export interface Warehouse {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  is_active: boolean;
  created_at: string;
  item_count: string;
  stock_value_rial: string;
  inactive_stock_value_rial?: string | null;
  inactive_item_count?: string | null;
  low_stock_count: string;
  last_movement_at: string | null;
}

interface WarehousesResponse {
  warehouses: Warehouse[];
}

type WarehouseStatusFilter = "all" | "active" | "inactive";

const WAREHOUSE_ERRORS: Record<string, string> = {
  missing_fields: "نام انبار را وارد کنید.",
  branch_name_taken: "انباری با این نام وجود دارد.",
  location_name_taken: "انباری با این نام وجود دارد.",
  name_too_long: "نام انبار بیش از حد طولانی است.",
  address_too_long: "آدرس بیش از حد طولانی است.",
  phone_too_long: "شمارهٔ تلفن بیش از حد طولانی است.",
  branch_limit_exceeded: "به سقف تعداد انبار/شعبه در پلن فعلی رسیده‌اید.",
};

export function warehouseErrorMessage(code: string | undefined): string {
  if (!code) return "";
  return WAREHOUSE_ERRORS[code] ??
    (code === "unauthorized"
      ? "وارد نشده‌اید."
      : code === "forbidden"
        ? "دسترسی مجاز نیست."
        : code === "bad_request"
          ? "درخواست نامعتبر بود."
          : `خطای غیرمنتظره (${code}). دوباره تلاش کنید.`);
}

const FILTERS: Array<{ key: WarehouseStatusFilter; label: string }> = [
  { key: "all", label: "همه" },
  { key: "active", label: "فعال" },
  { key: "inactive", label: "غیرفعال" },
];


function warehouseMatches(warehouse: Warehouse, search: string, status: WarehouseStatusFilter): boolean {
  if (status !== "all" && (status === "active") !== warehouse.is_active) return false;
  const term = search.trim().toLocaleLowerCase("fa");
  if (!term) return true;
  return [warehouse.name, warehouse.address, warehouse.phone]
    .filter(Boolean)
    .some((value) => value!.toLocaleLowerCase("fa").includes(term));
}

function WarehouseStatus({ warehouse }: { warehouse: Warehouse }) {
  return warehouse.is_active ? <StatusBadge tone="positive">فعال</StatusBadge> : <StatusBadge tone="neutral">غیرفعال</StatusBadge>;
}

function WarehouseDetails({ warehouse }: { warehouse: Warehouse }) {
  return (
    <p className="mt-1 min-w-0 truncate text-xs text-muted-foreground">
      {[warehouse.address, warehouse.phone].filter(Boolean).join(" · ") || "بدون آدرس یا تلفن"}
    </p>
  );
}

function WarehouseStats({ warehouse }: { warehouse: Warehouse }) {
  const money = useMoney();
  return (
    <div className="grid grid-cols-3 gap-2 text-xs">
      <div className="min-w-0 rounded-lg bg-muted/60 px-2 py-2">
        <p className="text-muted-foreground">اقلام</p>
        <p className="mt-1 truncate font-semibold tabular-nums text-foreground">{toPersianDigits(warehouse.item_count)}</p>
      </div>
      <div className="min-w-0 rounded-lg bg-muted/60 px-2 py-2">
        <p className="text-muted-foreground">ارزش موجودی</p>
        <p className="mt-1 truncate font-semibold tabular-nums text-foreground">{money.format(Number(warehouse.stock_value_rial))}</p>
      </div>
      <div className="min-w-0 rounded-lg bg-muted/60 px-2 py-2">
        <p className="text-muted-foreground">کمبود</p>
        <p className="mt-1 truncate font-semibold tabular-nums text-foreground">
          {Number(warehouse.low_stock_count) > 0 ? `${toPersianDigits(warehouse.low_stock_count)} قلم` : "—"}
        </p>
      </div>
    </div>
  );
}

/** «افزودن انبار» — the form tab of the retail «انبارها» group. */
export function AddWarehouseSection({ onCreated }: { onCreated?: () => void | Promise<void> }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError("");
    setDone("");
    try {
      const result = await api("/api/stock/warehouses", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), address: address.trim() || undefined, phone: phone.trim() || undefined }),
      });
      if (!result.ok) {
        setError(warehouseErrorMessage((result.data as { error?: string }).error));
        return;
      }
      setName("");
      setAddress("");
      setPhone("");
      setDone("انبار با موفقیت افزوده شد.");
      await onCreated?.();
    } catch {
      setError("ارتباط با سرور برقرار نشد. دوباره تلاش کنید.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard
      title={
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">انبارها</p>
          <h2 className="mt-1 font-semibold text-foreground">افزودن انبار</h2>
        </div>
      }
      description="نام انبار را بنویسید؛ آدرس و تلفن اختیاری است. هر انبار یک شعبه است و کالا و سند به آن تعلق می‌گیرد."
    >
      <ErrorBox>{error}</ErrorBox>
      {done ? <p className="mb-3 text-xs text-emerald-700 dark:text-emerald-300" role="status">{done}</p> : null}
      <form onSubmit={submit} className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Field label="نام انبار">
          <input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} placeholder="مثلاً: انبار مرکزی" maxLength={80} autoComplete="organization" required />
        </Field>
        <Field label="آدرس (اختیاری)">
          <input className={inputClass} value={address} onChange={(event) => setAddress(event.target.value)} maxLength={500} autoComplete="street-address" />
        </Field>
        <Field label="تلفن (اختیاری)">
          <input className={inputClass} dir="ltr" inputMode="tel" value={phone} onChange={(event) => setPhone(toLatinDigits(event.target.value))} placeholder="۰۲۱…" maxLength={32} autoComplete="tel" />
        </Field>
        <div className="flex items-end sm:col-span-2">
          <Button type="submit" disabled={busy || !name.trim()} size="lg" className="w-full px-5 font-semibold">
            <PlusIcon aria-hidden="true" className="size-4" />
            {busy ? "در حال افزودن…" : "افزودن انبار"}
          </Button>
        </div>
      </form>
    </SectionCard>
  );
}

/** «لیست انبارها» — the list tab of the retail «انبارها» group. */
export function WarehouseListSection({ onOpenStock }: { onOpenStock: (locationId: string) => void }) {
  const money = useMoney();
  const [warehouses, setWarehouses] = useState<Warehouse[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<WarehouseStatusFilter>("all");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await api<WarehousesResponse>("/api/stock/warehouses");
      if (!result.ok) {
        setError(warehouseErrorMessage((result.data as { error?: string }).error) || "خواندن فهرست انبارها انجام نشد.");
        return;
      }
      setWarehouses(result.data.warehouses);
    } catch {
      setError("ارتباط با سرور برقرار نشد. دوباره تلاش کنید.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visibleWarehouses = useMemo(
    () => (warehouses ?? []).filter((warehouse) => warehouseMatches(warehouse, search, status)),
    [warehouses, search, status],
  );

  return (
    <SectionCard
      title={
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">انبارها</p>
          <h2 className="mt-1 font-semibold text-foreground">لیست انبارها</h2>
        </div>
      }
      description="هر انبار یک شعبه است؛ کالا، موجودی و سندهای انبار به آن تعلق دارند."
      actions={
        <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCwIcon aria-hidden="true" className={loading ? "size-4 opacity-60" : "size-4"} />
          بروزرسانی
        </Button>
      }
      flush
    >
      {warehouses === null && loading ? (
        <div className="p-4 sm:p-5">
          <LoadingSkeleton rows={4} label="در حال بارگذاری انبارها" />
        </div>
      ) : warehouses === null ? (
        <div className="p-4 sm:p-5">
          <ErrorBox>{error || "خواندن فهرست انبارها انجام نشد."}</ErrorBox>
          <Button type="button" variant="outline" onClick={() => void load()}>
            تلاش دوباره
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-3 border-b border-border/80 p-4 sm:flex-row sm:items-center sm:px-5">
            <SearchField
              value={search}
              onChange={setSearch}
              placeholder="جستجوی نام، آدرس یا تلفن…"
              label="جستجو در انبارها"
              className="flex-1"
            />
            <FilterChipRow label="فیلتر وضعیت انبار" className="shrink-0">
              {FILTERS.map((filter) => (
                <FilterChip
                  key={filter.key}
                  selected={status === filter.key}
                  onClick={() => setStatus(filter.key)}
                >
                  {filter.label}
                </FilterChip>
              ))}
            </FilterChipRow>
            <p className="shrink-0 text-xs text-muted-foreground" aria-live="polite">
              {toPersianDigits(String(visibleWarehouses.length))} انبار
            </p>
          </div>
          {warehouses.length === 0 ? (
            <div className="p-4 sm:p-5">
              <EmptyState>هنوز انباری ثبت نشده است. از «افزودن انبار» اولین انبار را بسازید.</EmptyState>
            </div>
          ) : visibleWarehouses.length === 0 ? (
            <div className="p-4 sm:p-5">
              <EmptyState>انباری با این جستجو یا فیلتر پیدا نشد.</EmptyState>
              <div className="mt-3 text-center">
                <Button type="button" variant="outline" size="sm" onClick={() => { setSearch(""); setStatus("all"); }}>
                  حذف فیلترها
                </Button>
              </div>
            </div>
          ) : (
            <>
              <DataTable
                caption="فهرست انبارها با موجودی و وضعیت"
                className="hidden border-0 md:block"
                tableClassName="min-w-[720px]"
              >
                <DataTableHead>
                  <Th className="sm:px-5">انبار</Th>
                  <Th numeric>اقلام</Th>
                  <Th numeric>ارزش موجودی</Th>
                  <Th>کمبود</Th>
                  <Th>آخرین تغییر</Th>
                  <Th>وضعیت</Th>
                </DataTableHead>
                <DataTableBody>
                  {visibleWarehouses.map((warehouse) => (
                    <DataTableRow key={warehouse.id}>
                      <Td className="sm:px-5">
                        <button
                          type="button"
                          onClick={() => onOpenStock(warehouse.id)}
                          className="max-w-full text-start font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring focus-visible:ring-amber-400/40"
                          title="مشاهده موجودی این انبار"
                        >
                          {warehouse.name}
                        </button>
                        <WarehouseDetails warehouse={warehouse} />
                      </Td>
                      <Td numeric>{toPersianDigits(warehouse.item_count)}</Td>
                      <Td numeric>{money.format(Number(warehouse.stock_value_rial))}</Td>
                      <Td>
                        {Number(warehouse.low_stock_count) > 0 ? (
                          <StatusBadge tone="danger">{toPersianDigits(warehouse.low_stock_count)} قلم</StatusBadge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </Td>
                      <Td muted className="text-xs tabular-nums">
                        {warehouse.last_movement_at ? formatJalali(warehouse.last_movement_at) : "—"}
                      </Td>
                      <Td>
                        <WarehouseStatus warehouse={warehouse} />
                      </Td>
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>
              <div className="divide-y divide-border/80 md:hidden">
                {visibleWarehouses.map((warehouse) => (
                  <article key={warehouse.id} className="space-y-3 p-4">
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <div className="min-w-0">
                        <button type="button" onClick={() => onOpenStock(warehouse.id)} className="max-w-full truncate text-start font-semibold text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring focus-visible:ring-amber-400/40">
                          {warehouse.name}
                        </button>
                        <WarehouseDetails warehouse={warehouse} />
                      </div>
                      <WarehouseStatus warehouse={warehouse} />
                    </div>
                    <WarehouseStats warehouse={warehouse} />
                    <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                      <span>{warehouse.last_movement_at ? `آخرین تغییر: ${formatJalali(warehouse.last_movement_at)}` : "هنوز تغییری ثبت نشده است"}</span>
                      <button type="button" onClick={() => onOpenStock(warehouse.id)} className="min-h-10 shrink-0 rounded-lg px-3 font-semibold text-amber-800 underline-offset-4 hover:bg-amber-50 hover:underline dark:text-amber-300 dark:hover:bg-amber-500/10">
                        مشاهده موجودی
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </SectionCard>
  );
}
