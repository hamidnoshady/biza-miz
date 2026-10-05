"use client";

/**
 * Tab «آیتم‌ها» — issue #844's canonical desktop table with a purpose-built
 * mobile list.
 *
 * Desktop: one `DataTable` — آیتم (thumb + name + SKU) / دسته / قیمت فروش /
 * افزودنی‌ها / وضعیت / آخرین تغییر قیمت / `…`. The whole row opens the edit
 * Sheet; secondary actions live only inside `…`, so the row is never a wall
 * of buttons. Mobile: compact cards (48–56px thumb, name + category, price,
 * status, one `…`) that open the same Sheet — the card opens detail, the `…`
 * owns the actions, and nothing scrolls horizontally.
 *
 * Price edits never happen here: «تغییر قیمت» opens the dedicated audited
 * dialog, which posts to `/api/menu/items/:id/price-change`.
 */
import { useDeferredValue, useMemo, useState } from "react";
import {
  ArrowDownUpIcon,
  MoreHorizontalIcon,
  MoveIcon,
  PencilIcon,
  PlusIcon,
  PowerIcon,
  Trash2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DataTable,
  DataTableBody,
  DataTableHead,
  DataTableRow,
  Td,
  Th,
} from "@/app/dashboard/data-table";
import { EmptyState, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { FilterChip, FilterChipRow, SearchField } from "@/app/dashboard/filters";
import { ErrorBox, Field, api } from "@/app/dashboard/ui";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { MenuItemImage } from "@/app/dashboard/menu-item-image";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import type {
  RestaurantMenuData,
  RestaurantMenuItem,
} from "@/lib/restaurant-menu";
import { PRICE_SOURCE_LABELS } from "@/lib/menu-price-sources";
import type { LatestChanges, Runner } from "./menu-workspace";

type StatusFilter = "all" | "active" | "inactive";
type SortKey = "menu" | "name" | "price-desc" | "price-asc";

const SORT_OPTIONS: ReadonlyArray<{ value: SortKey; label: string }> = [
  { value: "menu", label: "ترتیب منو" },
  { value: "name", label: "نام (الفبا)" },
  { value: "price-desc", label: "قیمت: زیاد به کم" },
  { value: "price-asc", label: "قیمت: کم به زیاد" },
];

export function ItemsPanel({
  data,
  latest,
  canEdit,
  busy,
  run,
  onOpenItem,
  onChangePrice,
}: {
  data: RestaurantMenuData;
  latest: LatestChanges;
  canEdit: boolean;
  busy: boolean;
  run: Runner;
  onOpenItem: (item: RestaurantMenuItem | null, focusAddons?: boolean) => void;
  onChangePrice: (item: RestaurantMenuItem) => void;
}) {
  const { format } = useMoney();
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [categoryId, setCategoryId] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<SortKey>("menu");
  const [moveTarget, setMoveTarget] = useState<RestaurantMenuItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RestaurantMenuItem | null>(null);
  const [dialogError, setDialogError] = useState("");

  const categoriesById = useMemo(
    () => new Map(data.categories.map((c) => [c.id, c])),
    [data.categories],
  );
  const { itemModifierGroups } = data;
  const linksByItem = useMemo(() => {
    const map = new Map<string, typeof itemModifierGroups>();
    for (const link of itemModifierGroups) {
      const list = map.get(link.menuItemId);
      if (list) list.push(link);
      else map.set(link.menuItemId, [link]);
    }
    return map;
  }, [itemModifierGroups]);

  const filtersActive =
    search.trim() !== "" || categoryId !== "" || status !== "all" || sort !== "menu";

  const filtered = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase();
    let rows = data.items.filter((item) => {
      if (categoryId && item.categoryId !== categoryId) return false;
      if (status === "active" && !item.isActive) return false;
      if (status === "inactive" && item.isActive) return false;
      if (q) {
        const haystack = `${item.name} ${item.sku ?? ""}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
    if (sort === "name") rows = [...rows].sort((a, b) => a.name.localeCompare(b.name, "fa"));
    else if (sort === "price-desc") rows = [...rows].sort((a, b) => b.price - a.price);
    else if (sort === "price-asc") rows = [...rows].sort((a, b) => a.price - b.price);
    return rows;
  }, [data.items, deferredSearch, categoryId, status, sort]);

  const clearFilters = () => {
    setSearch("");
    setCategoryId("");
    setStatus("all");
    setSort("menu");
  };

  const categoryOptions = useMemo(
    () => [
      { value: "", label: "همهٔ دسته‌ها" },
      ...data.categories.map((c) => ({ value: c.id, label: c.name })),
    ],
    [data.categories],
  );

  async function toggleActive(item: RestaurantMenuItem) {
    await run(() =>
      api(`/api/menu/items/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !item.isActive }),
      }),
    );
  }

  return (
    <div className="space-y-4">
      {/* Toolbar — search is full-width on a phone; chips scroll horizontally
          rather than wrapping into a block that pushes the list down. */}
      <div className="space-y-2.5">
        <SearchField
          value={search}
          onChange={setSearch}
          label="جستجوی آیتم بر اساس نام یا کد کالا"
          placeholder="جستجوی نام یا کد کالا…"
          className="w-full sm:max-w-sm"
        />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <FilterChipRow
            label="فیلتر وضعیت آیتم"
            className="flex-nowrap overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible sm:pb-0"
          >
            <FilterChip selected={status === "all"} onClick={() => setStatus("all")}>
              همه
            </FilterChip>
            <FilterChip selected={status === "active"} onClick={() => setStatus("active")}>
              فعال
            </FilterChip>
            <FilterChip selected={status === "inactive"} onClick={() => setStatus("inactive")}>
              غیرفعال
            </FilterChip>
          </FilterChipRow>
          <div className="flex flex-wrap items-center gap-2">
            <SearchableSelect
              value={categoryId}
              onChange={setCategoryId}
              options={categoryOptions}
              placeholder="دسته"
              ariaLabel="فیلتر دسته"
              className="min-w-40 sm:w-48"
            />
            <SearchableSelect
              value={sort}
              onChange={(value) => setSort(value as SortKey)}
              options={SORT_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
              ariaLabel="مرتب‌سازی آیتم‌ها"
              className="min-w-40 sm:w-48"
            />
            {filtersActive ? (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                پاک‌کردن فیلترها
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {filtered.length === 0 ? (
        filtersActive ? (
          <EmptyState title="آیتمی با این فیلترها پیدا نشد" action={
            <Button variant="outline" onClick={clearFilters}>
              پاک‌کردن فیلترها
            </Button>
          }>
            جستجو یا فیلتر وضعیت را تغییر دهید.
          </EmptyState>
        ) : (
          <EmptyState
            title="هنوز آیتمی در منو نیست"
            action={
              canEdit ? (
                <Button onClick={() => onOpenItem(null)}>
                  <PlusIcon className="size-4" data-icon="inline-start" />
                  افزودن آیتم
                </Button>
              ) : undefined
            }
          >
            اولین آیتم را با نام، دسته و قیمت فروش بسازید.
          </EmptyState>
        )
      ) : (
        <>
          {/* Desktop — the canonical table */}
          <div className="hidden md:block">
            <DataTable caption="فهرست آیتم‌های منو">
              <DataTableHead>
                <tr>
                  <Th>آیتم</Th>
                  <Th>دسته</Th>
                  <Th numeric>قیمت فروش</Th>
                  <Th>افزودنی‌ها</Th>
                  <Th>وضعیت</Th>
                  <Th>آخرین تغییر قیمت</Th>
                  <Th>
                    <span className="sr-only">عملیات</span>
                  </Th>
                </tr>
              </DataTableHead>
              <DataTableBody>
                {filtered.map((item) => {
                  const linkCount = (linksByItem.get(item.id) ?? []).length;
                  const lastChange = latest[item.id];
                  return (
                    <DataTableRow
                      key={item.id}
                      onClick={() => onOpenItem(item)}
                      aria-label={`ویرایش ${item.name}`}
                    >
                      <Td>
                        <span className="flex min-w-0 items-center gap-3">
                          <MenuItemImage
                            mediaId={item.imageMediaId}
                            url={item.imageUrl}
                            className="size-9 shrink-0 rounded-lg"
                            iconClassName="size-4"
                          />
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{item.name}</span>
                            {item.sku ? (
                              <span className="block truncate text-xs text-muted-foreground" dir="ltr">
                                {item.sku}
                              </span>
                            ) : null}
                          </span>
                        </span>
                      </Td>
                      <Td muted>
                        {item.categoryId
                          ? (categoriesById.get(item.categoryId)?.name ?? "—")
                          : "بدون دسته"}
                      </Td>
                      <Td numeric>{format(item.price)}</Td>
                      <Td numeric>{toPersianDigits(linkCount)}</Td>
                      <Td>
                        <StatusBadge tone={item.isActive ? "positive" : "neutral"}>
                          {item.isActive ? "فعال" : "غیرفعال"}
                        </StatusBadge>
                      </Td>
                      <Td muted nowrap>
                        {lastChange ? (
                          <span className="block">
                            <span className="block text-foreground">
                              {formatJalali(lastChange.changedAt, { withTime: true })}
                            </span>
                            <span className="block text-xs">
                              {PRICE_SOURCE_LABELS[lastChange.source]}
                            </span>
                          </span>
                        ) : (
                          "—"
                        )}
                      </Td>
                      <Td>
                        {canEdit ? (
                          <ItemActionsMenu
                            item={item}
                            onEdit={() => onOpenItem(item)}
                            onAddons={() => onOpenItem(item, true)}
                            onPrice={() => onChangePrice(item)}
                            onToggle={() => void toggleActive(item)}
                            onMove={() => {
                              setDialogError("");
                              setMoveTarget(item);
                            }}
                            onDelete={() => {
                              setDialogError("");
                              setDeleteTarget(item);
                            }}
                          />
                        ) : null}
                      </Td>
                    </DataTableRow>
                  );
                })}
              </DataTableBody>
            </DataTable>
          </div>

          {/* Mobile — purpose-built cards, not a squeezed table */}
          <ul className="space-y-2.5 md:hidden">
            {filtered.map((item) => {
              const linkCount = (linksByItem.get(item.id) ?? []).length;
              return (
                <li key={item.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={(event) => {
                      const control = (event.target as Element).closest?.(
                        "button, [role='menuitem'], [role='menu']",
                      );
                      if (control) return;
                      onOpenItem(item);
                    }}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onOpenItem(item);
                      }
                    }}
                    className="flex min-h-16 w-full items-center gap-3 rounded-xl border border-border/80 bg-card p-3 text-start transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/45"
                  >
                    <MenuItemImage
                      mediaId={item.imageMediaId}
                      url={item.imageUrl}
                      className="size-13 shrink-0 rounded-lg"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate font-medium">{item.name}</span>
                        <StatusBadge tone={item.isActive ? "positive" : "neutral"}>
                          {item.isActive ? "فعال" : "غیرفعال"}
                        </StatusBadge>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {item.categoryId
                          ? (categoriesById.get(item.categoryId)?.name ?? "بدون دسته")
                          : "بدون دسته"}
                        {linkCount > 0 ? ` · ${toPersianDigits(linkCount)} افزودنی` : ""}
                      </span>
                      <span className="mt-0.5 block text-sm font-medium tabular-nums">
                        {format(item.price)}
                      </span>
                    </span>
                    {canEdit ? (
                      <ItemActionsMenu
                        item={item}
                        onEdit={() => onOpenItem(item)}
                        onAddons={() => onOpenItem(item, true)}
                        onPrice={() => onChangePrice(item)}
                        onToggle={() => void toggleActive(item)}
                        onMove={() => {
                          setDialogError("");
                          setMoveTarget(item);
                        }}
                        onDelete={() => {
                          setDialogError("");
                          setDeleteTarget(item);
                        }}
                      />
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <MoveCategoryDialog
        item={moveTarget}
        data={data}
        busy={busy}
        error={dialogError}
        onClose={() => setMoveTarget(null)}
        onConfirm={async (toCategoryId) => {
          if (!moveTarget) return;
          const result = await run(() =>
            api(`/api/menu/items/${moveTarget.id}`, {
              method: "PATCH",
              body: JSON.stringify({ categoryId: toCategoryId }),
            }),
          );
          if (result.ok) setMoveTarget(null);
          else setDialogError(result.error ?? "");
        }}
      />

      <DeleteItemDialog
        item={deleteTarget}
        busy={busy}
        error={dialogError}
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return;
          const result = await run(() =>
            api(`/api/menu/items/${deleteTarget.id}`, { method: "DELETE" }),
          );
          if (result.ok) setDeleteTarget(null);
          else setDialogError(result.error ?? "");
        }}
      />
    </div>
  );
}

function ItemActionsMenu({
  item,
  onEdit,
  onAddons,
  onPrice,
  onToggle,
  onMove,
  onDelete,
}: {
  item: RestaurantMenuItem;
  onEdit: () => void;
  onAddons: () => void;
  onPrice: () => void;
  onToggle: () => void;
  onMove: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`عملیات ${item.name}`}
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontalIcon className="size-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuItem onSelect={onEdit}>
          <PencilIcon className="size-4" />
          ویرایش اطلاعات
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onAddons}>
          <PlusIcon className="size-4" />
          افزودنی‌ها
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onPrice}>
          <ArrowDownUpIcon className="size-4" />
          تغییر قیمت
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onToggle}>
          <PowerIcon className="size-4" />
          {item.isActive ? "غیرفعال کردن" : "فعال کردن"}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onMove}>
          <MoveIcon className="size-4" />
          انتقال به دسته
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2Icon className="size-4" />
          حذف
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MoveCategoryDialog({
  item,
  data,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  item: RestaurantMenuItem | null;
  data: RestaurantMenuData;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: (categoryId: string) => void | Promise<void>;
}) {
  const [target, setTarget] = useState("");
  const open = item !== null;
  const options = useMemo(
    () =>
      data.categories
        .filter((category) => category.isActive || category.id === item?.categoryId)
        .map((category) => ({ value: category.id, label: category.name })),
    [data.categories, item],
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setTarget("");
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>انتقال «{item?.name}» به دسته</DialogTitle>
          <DialogDescription>
            آیتم به انتهای دستهٔ مقصد اضافه و ترتیب آن دسته بازچینش می‌شود؛ ترتیب بقیهٔ دسته‌ها
            دست‌نخورده می‌ماند.
          </DialogDescription>
        </DialogHeader>
        <ErrorBox>{error}</ErrorBox>
        <Field label="دستهٔ مقصد">
          <SearchableSelect
            value={target}
            onChange={setTarget}
            options={options}
            placeholder="انتخاب دسته…"
            ariaLabel="دستهٔ مقصد"
          />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            انصراف
          </Button>
          <Button
            disabled={!target || busy}
            onClick={() => void onConfirm(target)}
          >
            انتقال
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteItemDialog({
  item,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  item: RestaurantMenuItem | null;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <Dialog
      open={item !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>حذف آیتم «{item?.name}»</DialogTitle>
          <DialogDescription>
            آیتم از منو و فروش حذف می‌شود. سفارش‌های ثبت‌شدهٔ قبلی دست‌نخورده می‌مانند، چون قیمت در
            خط سفارش هنگام فروش ذخیره شده است. اگر فقط می‌خواهید فروش آن را متوقف کنید،
            «غیرفعال کردن» بهتر است.
          </DialogDescription>
        </DialogHeader>
        <ErrorBox>{error}</ErrorBox>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            انصراف
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void onConfirm()}>
            حذف آیتم
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
