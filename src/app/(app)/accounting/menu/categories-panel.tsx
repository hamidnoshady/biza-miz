"use client";

/**
 * Tab «دسته‌ها» — issue #844's compact category table.
 *
 * Add/Edit are Dialogs; reorder is a *single* `POST /api/menu/reorder`
 * (one unnest UPDATE in one transaction — never two PATCHes that can leave
 * duplicate sort orders after a partial failure). Deactivating a category
 * that still holds active items says what will happen before it happens, and
 * delete explains its own impact: with items it deactivates instead (the
 * route's historical-order rule), without items it removes the row.
 */
import { useMemo, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, MoreHorizontalIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import { EmptyState, StatusBadge } from "@/app/dashboard/page-chrome";
import { ErrorBox, Field, api, inputClass } from "@/app/dashboard/ui";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { toPersianDigits } from "@/lib/digits";
import type { RestaurantMenuData, RestaurantMenuCategory } from "@/lib/restaurant-menu";
import type { Runner } from "./menu-workspace";

export function CategoriesPanel({
  data,
  canEdit,
  busy,
  run,
  onNotice,
}: {
  data: RestaurantMenuData;
  canEdit: boolean;
  busy: boolean;
  run: Runner;
  onNotice: (message: string) => void;
}) {
  const [formDialog, setFormDialog] = useState<
    null | { mode: "create" } | { mode: "edit"; categoryId: string }
  >(null);
  const [reorderOpen, setReorderOpen] = useState(false);
  const [confirmState, setConfirmState] = useState<
    null | { kind: "toggle"; category: RestaurantMenuCategory } | { kind: "delete"; category: RestaurantMenuCategory }
  >(null);
  const [dialogError, setDialogError] = useState("");

  const counts = useMemo(() => {
    const total = new Map<string, number>();
    const active = new Map<string, number>();
    for (const item of data.items) {
      if (!item.categoryId) continue;
      total.set(item.categoryId, (total.get(item.categoryId) ?? 0) + 1);
      if (item.isActive) active.set(item.categoryId, (active.get(item.categoryId) ?? 0) + 1);
    }
    return { total, active };
  }, [data.items]);

  async function toggleActive(category: RestaurantMenuCategory) {
    setDialogError("");
    const result = await run(() =>
      api(`/api/menu/categories/${category.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !category.isActive }),
      }),
    );
    if (result.ok) setConfirmState(null);
    else setDialogError(result.error ?? "");
  }

  async function remove(category: RestaurantMenuCategory) {
    setDialogError("");
    const result = await run(() => api(`/api/menu/categories/${category.id}`, { method: "DELETE" }));
    if (result.ok) {
      setConfirmState(null);
      if (result.data.deactivated === true) {
        onNotice(
          "این دسته آیتم داشت، پس به‌جای حذف غیرفعال شد تا سفارش‌های قبلی مرجع‌شان را از دست ندهند.",
        );
      }
    } else {
      setDialogError(result.error ?? "");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {toPersianDigits(data.categories.length)} دسته در این شعبه
        </p>
        {canEdit ? (
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setDialogError("");
                setReorderOpen(true);
              }}
              disabled={data.categories.length < 2}
            >
              مرتب‌سازی
            </Button>
            <Button
              onClick={() => {
                setDialogError("");
                setFormDialog({ mode: "create" });
              }}
            >
              <PlusIcon className="size-4" data-icon="inline-start" />
              افزودن دسته
            </Button>
          </div>
        ) : null}
      </div>

      {data.categories.length === 0 ? (
        <EmptyState title="هنوز دسته‌ای ثبت نشده است">
          {canEdit
            ? "با «افزودن دسته» اولین دستهٔ منو را بسازید؛ آیتم‌ها به دسته تعلق می‌گیرند."
            : "برای این شعبه دسته‌ای ثبت نشده است."}
        </EmptyState>
      ) : (
        <DataTable caption="فهرست دسته‌های منو">
          <DataTableHead>
            <tr>
              <Th>نام دسته</Th>
              <Th numeric>تعداد آیتم</Th>
              <Th numeric>مالیات</Th>
              <Th>وضعیت</Th>
              <Th numeric>ترتیب</Th>
              <Th>
                <span className="sr-only">عملیات</span>
              </Th>
            </tr>
          </DataTableHead>
          <DataTableBody>
            {data.categories.map((category, index) => {
              const activeCount = counts.active.get(category.id) ?? 0;
              const totalCount = counts.total.get(category.id) ?? 0;
              return (
                <DataTableRow key={category.id}>
                  <Td>
                    <span className="font-medium">{category.name}</span>
                  </Td>
                  <Td numeric>{toPersianDigits(totalCount)}</Td>
                  <Td numeric>{toPersianDigits(category.taxRate)}٪</Td>
                  <Td>
                    <StatusBadge tone={category.isActive ? "positive" : "neutral"}>
                      {category.isActive ? "فعال" : "غیرفعال"}
                    </StatusBadge>
                  </Td>
                  <Td numeric muted>{toPersianDigits(index + 1)}</Td>
                  <Td>
                    {canEdit ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`عملیات ${category.name}`}
                          >
                            <MoreHorizontalIcon className="size-5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-48">
                          <DropdownMenuItem
                            onSelect={() => {
                              setDialogError("");
                              setFormDialog({ mode: "edit", categoryId: category.id });
                            }}
                          >
                            ویرایش
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => {
                              setDialogError("");
                              setConfirmState({ kind: "toggle", category });
                            }}
                          >
                            {category.isActive ? "غیرفعال کردن" : "فعال کردن"}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => {
                              setDialogError("");
                              setConfirmState({ kind: "delete", category });
                            }}
                          >
                            حذف
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                    {canEdit && activeCount > 0 && category.isActive ? (
                      <span className="sr-only">
                        {toPersianDigits(activeCount)} آیتم فعال
                      </span>
                    ) : null}
                  </Td>
                </DataTableRow>
              );
            })}
          </DataTableBody>
        </DataTable>
      )}

      <CategoryFormDialog
        data={data}
        state={formDialog}
        error={dialogError}
        run={run}
        onClose={() => setFormDialog(null)}
      />

      <ReorderCategoriesDialog
        open={reorderOpen}
        categories={data.categories}
        error={dialogError}
        run={run}
        onClose={() => setReorderOpen(false)}
      />

      <ConfirmCategoryAction
        state={confirmState}
        counts={counts}
        error={dialogError}
        busy={busy}
        onClose={() => setConfirmState(null)}
        onToggle={(category) => void toggleActive(category)}
        onDelete={(category) => void remove(category)}
      />
    </div>
  );
}

function CategoryFormDialog({
  data,
  state,
  error,
  run,
  onClose,
}: {
  data: RestaurantMenuData;
  state: null | { mode: "create" } | { mode: "edit"; categoryId: string };
  error: string;
  run: Runner;
  onClose: () => void;
}) {
  const editing = state?.mode === "edit" ? state.categoryId : null;
  const existing = editing ? (data.categories.find((c) => c.id === editing) ?? null) : null;
  const [name, setName] = useState("");
  const [tax, setTax] = useState("");
  const [seen, setSeen] = useState<string | null>(null);
  const [localError, setLocalError] = useState("");
  const key = editing ?? "create";
  if (state && seen !== key) {
    setSeen(key);
    setName(existing?.name ?? "");
    setTax(existing ? String(existing.taxRate) : "");
    setLocalError("");
  }

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) {
      setLocalError("نام دسته الزامی است.");
      return;
    }
    const taxValue = tax.trim();
    if (taxValue !== "" && (!Number.isFinite(Number(taxValue)) || Number(taxValue) < 0 || Number(taxValue) > 100)) {
      setLocalError("نرخ مالیات باید بین ۰ و ۱۰۰ باشد.");
      return;
    }
    const body: Record<string, unknown> = { name: trimmed };
    if (taxValue !== "") body.taxRate = Number(taxValue);
    const result = await run(() =>
      editing
        ? api(`/api/menu/categories/${editing}`, { method: "PATCH", body: JSON.stringify(body) })
        : api("/api/menu/categories", { method: "POST", body: JSON.stringify(body) }),
    );
    if (result.ok) onClose();
    else setLocalError(result.error ?? "");
  }

  if (!state) return null;
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? "ویرایش دسته" : "افزودن دسته"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "نام و نرخ مالیات دسته را تغییر دهید."
              : "نام دسته را وارد کنید؛ نرخ مالیات خالی یعنی نرخ پیش‌فرض کسب‌وکار."}
          </DialogDescription>
        </DialogHeader>
        <ErrorBox>{localError || error}</ErrorBox>
        <Field label="نام دسته">
          <input
            className={inputClass}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="مثلاً «نوشیدنی سرد»"
          />
        </Field>
        <Field
          label="نرخ مالیات (٪)"
          hint={
            editing
              ? "خالی بگذارید تا نرخ فعلی دسته دست‌نخورده بماند."
              : "خالی یعنی نرخ پیش‌فرض کسب‌وکار."
          }
        >
          <PersianNumberInput
            value={tax}
            onChange={(event) => setTax(event.target.value)}
            allowDecimal
            grouping={false}
            inputMode="decimal"
            className={inputClass}
            placeholder="مثلاً ۹"
          />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            انصراف
          </Button>
          <Button onClick={() => void save()}>
            {editing ? "ذخیره" : "افزودن"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Reorder dialog: local moves, one atomic save. The ids go to
 * `/api/menu/reorder`, which validates scope and rewrites every ordinal in a
 * single UPDATE — a partial failure cannot leave two categories claiming the
 * same position.
 */
function ReorderCategoriesDialog({
  open,
  categories,
  error,
  run,
  onClose,
}: {
  open: boolean;
  categories: RestaurantMenuCategory[];
  error: string;
  run: Runner;
  onClose: () => void;
}) {
  const [order, setOrder] = useState<string[]>([]);
  const [seen, setSeen] = useState(false);
  const [localError, setLocalError] = useState("");
  if (open && !seen) {
    setSeen(true);
    setOrder(categories.map((c) => c.id));
    setLocalError("");
  }
  if (!open && seen) setSeen(false);

  const byId = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  function move(index: number, direction: -1 | 1) {
    const next = [...order];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setOrder(next);
  }

  async function save() {
    const result = await run(() =>
      api("/api/menu/reorder", {
        method: "POST",
        body: JSON.stringify({ entity: "categories", ids: order }),
      }),
    );
    if (result.ok) onClose();
    else setLocalError(result.error ?? "");
  }

  if (!open) return null;
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>مرتب‌سازی دسته‌ها</DialogTitle>
          <DialogDescription>
            ترتیب را با فلش‌ها تنظیم و در پایان با یک ذخیرهٔ واحد اعمال کنید.
          </DialogDescription>
        </DialogHeader>
        <ErrorBox>{localError || error}</ErrorBox>
        <ol className="space-y-2">
          {order.map((id, index) => {
            const category = byId.get(id);
            if (!category) return null;
            return (
              <li
                key={id}
                className="flex items-center justify-between gap-2 rounded-xl border border-border/80 px-3 py-2"
              >
                <span className="min-w-0 truncate text-sm font-medium">{category.name}</span>
                <span className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`بالا بردن ${category.name}`}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUpIcon className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`پایین بردن ${category.name}`}
                    disabled={index === order.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDownIcon className="size-4" />
                  </Button>
                </span>
              </li>
            );
          })}
        </ol>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            انصراف
          </Button>
          <Button onClick={() => void save()}>ذخیرهٔ ترتیب</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConfirmCategoryAction({
  state,
  counts,
  error,
  busy,
  onClose,
  onToggle,
  onDelete,
}: {
  state: null | { kind: "toggle"; category: RestaurantMenuCategory } | { kind: "delete"; category: RestaurantMenuCategory };
  counts: { total: Map<string, number>; active: Map<string, number> };
  error: string;
  busy: boolean;
  onClose: () => void;
  onToggle: (category: RestaurantMenuCategory) => void;
  onDelete: (category: RestaurantMenuCategory) => void;
}) {
  if (!state) return null;
  const category = state.category;
  const activeCount = counts.active.get(category.id) ?? 0;
  const totalCount = counts.total.get(category.id) ?? 0;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {state.kind === "toggle"
              ? category.isActive
                ? `غیرفعال کردن «${category.name}»`
                : `فعال کردن «${category.name}»`
              : `حذف «${category.name}»`}
          </DialogTitle>
          <DialogDescription>
            {state.kind === "toggle" ? (
              category.isActive && activeCount > 0 ? (
                <>
                  این دسته {toPersianDigits(activeCount)} آیتم فعال دارد. با غیرفعال شدن دسته،
                  این آیتم‌ها در صندوق و منوی فروش پنهان می‌شوند (خود آیتم‌ها و قیمت‌شان دست
                  نمی‌خورد و با فعال کردن دوباره برمی‌گردند). اگر فقط بعضی آیتم‌ها را نمی‌خواهید،
                  آن‌ها را تک‌تک غیرفعال کنید.
                </>
              ) : category.isActive ? (
                "دسته غیرفعال می‌شود و از انتخاب‌های فروش خارج می‌گردد."
              ) : (
                "دسته دوباره در منو و صندوق نمایش داده می‌شود."
              )
            ) : totalCount > 0 ? (
              <>
                این دسته {toPersianDigits(totalCount)} آیتم دارد. حذف دسته، دستهٔ آیتم‌ها را
                آزاد می‌کند (خود آیتم‌ها پاک نمی‌شوند) ولی سفارش‌های قبلی دیگر مرجع دسته ندارند؛
                به همین دلیل دستهٔ دارای آیتم به‌جای حذف، غیرفعال می‌شود. برای حذف واقعی، اول
                آیتم‌ها را به دستهٔ دیگری منتقل کنید.
              </>
            ) : (
              "دستهٔ خالی حذف می‌شود. این عمل برگشت‌پذیر نیست."
            )}
          </DialogDescription>
        </DialogHeader>
        <ErrorBox>{error}</ErrorBox>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            انصراف
          </Button>
          {state.kind === "toggle" ? (
            <Button
              variant={category.isActive ? "destructive" : "default"}
              disabled={busy}
              onClick={() => onToggle(category)}
            >
              {category.isActive ? "غیرفعال کن" : "فعال کن"}
            </Button>
          ) : (
            <Button variant="destructive" disabled={busy} onClick={() => onDelete(category)}>
              {totalCount > 0 ? "غیرفعال کن" : "حذف کن"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
