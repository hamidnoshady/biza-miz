"use client";

/**
 * Tab «افزودنی‌ها» — issue #844.
 *
 * The group table (name, rule «۱ از ۳», option count, attached-item count,
 * status, order, `…`) and the detail Sheet (bounds, options with their price
 * deltas, per-option order, link state, and the items using the group).
 * Option order is persisted through the same atomic `POST /api/menu/reorder`
 * as every other collection — one statement, never a two-PATCH swap. The
 * *per-item* order of attached groups lives in the item Sheet and is never
 * globally re-sorted here; POS/waiter screens read it as stored.
 */
import { useMemo, useState } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
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
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import type {
  RestaurantMenuData,
  RestaurantModifier,
  RestaurantModifierGroup,
} from "@/lib/restaurant-menu";
import type { Runner } from "./menu-workspace";

export function ModifiersPanel({
  data,
  canEdit,
  run,
  onNotice,
}: {
  data: RestaurantMenuData;
  canEdit: boolean;
  run: Runner;
  onNotice: (message: string) => void;
}) {
  const [openGroupId, setOpenGroupId] = useState<string | null>(null);
  const [groupForm, setGroupForm] = useState<
    null | { mode: "create" } | { mode: "edit"; groupId: string }
  >(null);
  const [reorderOpen, setReorderOpen] = useState(false);
  const [confirmState, setConfirmState] = useState<
    null | { kind: "toggle"; group: RestaurantModifierGroup } | { kind: "delete"; group: RestaurantModifierGroup }
  >(null);
  const [dialogError, setDialogError] = useState("");

  const modifiersByGroup = useMemo(() => {
    const map = new Map<string, RestaurantModifier[]>();
    for (const modifier of data.modifiers) {
      const list = map.get(modifier.groupId);
      if (list) list.push(modifier);
      else map.set(modifier.groupId, [modifier]);
    }
    for (const list of map.values()) list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "fa"));
    return map;
  }, [data.modifiers]);

  const linksByGroup = useMemo(() => {
    const map = new Map<string, number>();
    for (const link of data.itemModifierGroups) {
      map.set(link.modifierGroupId, (map.get(link.modifierGroupId) ?? 0) + 1);
    }
    return map;
  }, [data.itemModifierGroups]);

  async function toggleGroup(group: RestaurantModifierGroup) {
    setDialogError("");
    const result = await run(() =>
      api(`/api/menu/modifier-groups/${group.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !group.isActive }),
      }),
    );
    if (result.ok) setConfirmState(null);
    else setDialogError(result.error ?? "");
  }

  async function removeGroup(group: RestaurantModifierGroup) {
    setDialogError("");
    const result = await run(() =>
      api(`/api/menu/modifier-groups/${group.id}`, { method: "DELETE" }),
    );
    if (result.ok) {
      setConfirmState(null);
      if (result.data.deactivated === true) {
        onNotice("این گروه در سفارش‌های قبلی استفاده شده، پس به‌جای حذف غیرفعال شد.");
      }
    } else {
      setDialogError(result.error ?? "");
    }
  }

  const openGroup = openGroupId
    ? (data.modifierGroups.find((group) => group.id === openGroupId) ?? null)
    : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {toPersianDigits(data.modifierGroups.length)} گروه افزودنی در این شعبه
        </p>
        {canEdit ? (
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setDialogError("");
                setReorderOpen(true);
              }}
              disabled={data.modifierGroups.length < 2}
            >
              مرتب‌سازی
            </Button>
            <Button
              onClick={() => {
                setDialogError("");
                setGroupForm({ mode: "create" });
              }}
            >
              <PlusIcon className="size-4" data-icon="inline-start" />
              افزودن گروه
            </Button>
          </div>
        ) : null}
      </div>

      {data.modifierGroups.length === 0 ? (
        <EmptyState title="هنوز گروه افزودنی‌ای ثبت نشده است">
          {canEdit
            ? "گروه‌ها (مثل «شیر اضافه» یا «اندازه نوشیدنی») را بسازید و به آیتم‌ها وصل کنید."
            : "برای این شعبه گروه افزودنی ثبت نشده است."}
        </EmptyState>
      ) : (
        <DataTable caption="فهرست گروه‌های افزودنی">
          <DataTableHead>
            <tr>
              <Th>گروه</Th>
              <Th>قاعده</Th>
              <Th numeric>گزینه‌ها</Th>
              <Th numeric>آیتم‌های متصل</Th>
              <Th>وضعیت</Th>
              <Th numeric>ترتیب</Th>
              <Th>
                <span className="sr-only">عملیات</span>
              </Th>
            </tr>
          </DataTableHead>
          <DataTableBody>
            {data.modifierGroups.map((group, index) => {
              const options = modifiersByGroup.get(group.id) ?? [];
              const activeOptions = options.filter((option) => option.isActive).length;
              return (
                <DataTableRow
                  key={group.id}
                  onClick={() => setOpenGroupId(group.id)}
                  aria-label={`جزئیات ${group.name}`}
                >
                  <Td>
                    <span className="font-medium">{group.name}</span>
                  </Td>
                  <Td muted nowrap>
                    {toPersianDigits(group.minSelect)} از {toPersianDigits(group.maxSelect)}
                  </Td>
                  <Td numeric>
                    {toPersianDigits(activeOptions)}
                    {activeOptions !== options.length ? (
                      <span className="text-muted-foreground">
                        {" "}
                        از {toPersianDigits(options.length)}
                      </span>
                    ) : null}
                  </Td>
                  <Td numeric>{toPersianDigits(linksByGroup.get(group.id) ?? 0)}</Td>
                  <Td>
                    <StatusBadge tone={group.isActive ? "positive" : "neutral"}>
                      {group.isActive ? "فعال" : "غیرفعال"}
                    </StatusBadge>
                  </Td>
                  <Td numeric muted>{toPersianDigits(index + 1)}</Td>
                  <Td>
                    {canEdit ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label={`عملیات ${group.name}`}>
                            <MoreHorizontalIcon className="size-5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-48">
                          <DropdownMenuItem onSelect={() => setOpenGroupId(group.id)}>
                            <PencilIcon className="size-4" />
                            جزئیات و ویرایش
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => {
                              setDialogError("");
                              setConfirmState({ kind: "toggle", group });
                            }}
                          >
                            {group.isActive ? "غیرفعال کردن" : "فعال کردن"}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => {
                              setDialogError("");
                              setConfirmState({ kind: "delete", group });
                            }}
                          >
                            <Trash2Icon className="size-4" />
                            حذف
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </Td>
                </DataTableRow>
              );
            })}
          </DataTableBody>
        </DataTable>
      )}

      {openGroup ? (
        <GroupDetailSheet
          key={openGroup.id}
          group={openGroup}
          data={data}
          options={modifiersByGroup.get(openGroup.id) ?? []}
          canEdit={canEdit}
          run={run}
          onClose={() => setOpenGroupId(null)}
        />
      ) : null}

      <GroupFormDialog
        data={data}
        state={groupForm}
        error={dialogError}
        run={run}
        onClose={() => setGroupForm(null)}
      />

      <ReorderGroupsDialog
        open={reorderOpen}
        groups={data.modifierGroups}
        error={dialogError}
        run={run}
        onClose={() => setReorderOpen(false)}
      />

      <Dialog
        open={confirmState !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmState(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmState?.kind === "toggle"
                ? confirmState.group.isActive
                  ? `غیرفعال کردن «${confirmState.group.name}»`
                  : `فعال کردن «${confirmState.group.name}»`
                : confirmState
                  ? `حذف «${confirmState.group.name}»`
                  : ""}
            </DialogTitle>
            <DialogDescription>
              {confirmState?.kind === "toggle"
                ? confirmState.group.isActive
                  ? "گروه غیرفعال در سفارش جدید پیشنهاد نمی‌شود؛ اتصال‌های آن به آیتم‌ها می‌ماند و سفارش‌های قبلی دست‌نخورده‌اند."
                  : "گروه دوباره در سفارش‌های جدید پیشنهاد می‌شود."
                : "اگر گزینه‌های این گروه در سفارشی فروش رفته باشند، گروه به‌جای حذف غیرفعال می‌شود تا مرجع سفارش‌های قبلی بماند. گروه خالی حذف می‌شود."}
            </DialogDescription>
          </DialogHeader>
          <ErrorBox>{dialogError}</ErrorBox>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmState(null)}>
              انصراف
            </Button>
            {confirmState?.kind === "toggle" ? (
              <Button
                variant={confirmState.group.isActive ? "destructive" : "default"}
                onClick={() => void toggleGroup(confirmState.group)}
              >
                {confirmState.group.isActive ? "غیرفعال کن" : "فعال کن"}
              </Button>
            ) : confirmState ? (
              <Button variant="destructive" onClick={() => void removeGroup(confirmState.group)}>
                حذف کن
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function GroupDetailSheet({
  group,
  data,
  options,
  canEdit,
  run,
  onClose,
}: {
  group: RestaurantModifierGroup;
  data: RestaurantMenuData;
  options: RestaurantModifier[];
  canEdit: boolean;
  run: Runner;
  onClose: () => void;
}) {
  const money = useMoney();
  const [name, setName] = useState(group.name);
  const [minSelect, setMinSelect] = useState(String(group.minSelect));
  const [maxSelect, setMaxSelect] = useState(String(group.maxSelect));
  const [isActive, setIsActive] = useState(group.isActive);
  const [formError, setFormError] = useState("");

  // Option add/edit form (inline — the sheet owns it, per issue).
  const [optionName, setOptionName] = useState("");
  const [optionDelta, setOptionDelta] = useState("");
  const [editOption, setEditOption] = useState<RestaurantModifier | null>(null);

  const itemsUsing = useMemo(() => {
    const ids = new Set(
      data.itemModifierGroups
        .filter((link) => link.modifierGroupId === group.id)
        .map((link) => link.menuItemId),
    );
    return data.items.filter((item) => ids.has(item.id));
  }, [data, group.id]);

  async function saveGroup() {
    const trimmed = name.trim();
    if (!trimmed) {
      setFormError("نام گروه الزامی است.");
      return;
    }
    const min = Number(minSelect);
    const max = Number(maxSelect);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < 0 || min > max) {
      setFormError("حداقل و حداکثر انتخاب را درست وارد کنید (حداقل نباید از حداکثر بیشتر باشد).");
      return;
    }
    const result = await run(() =>
      api(`/api/menu/modifier-groups/${group.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: trimmed, minSelect: min, maxSelect: max, isActive }),
      }),
    );
    if (!result.ok) setFormError(result.error ?? "");
  }

  async function addOption() {
    const trimmed = optionName.trim();
    if (!trimmed) {
      setFormError("نام افزودنی الزامی است.");
      return;
    }
    const delta = optionDelta.trim() === "" ? 0 : money.parse(optionDelta);
    if (!Number.isFinite(delta)) {
      setFormError("مبلغ افزوده را درست وارد کنید.");
      return;
    }
    const result = await run(() =>
      api("/api/menu/modifiers", {
        method: "POST",
        body: JSON.stringify({ groupId: group.id, name: trimmed, priceDelta: delta }),
      }),
    );
    if (result.ok) {
      setOptionName("");
      setOptionDelta("");
      setFormError("");
    } else setFormError(result.error ?? "");
  }

  async function toggleOption(modifier: RestaurantModifier) {
    const result = await run(() =>
      api(`/api/menu/modifiers/${modifier.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !modifier.isActive }),
      }),
    );
    if (!result.ok) setFormError(result.error ?? "");
  }

  async function removeOption(modifier: RestaurantModifier) {
    const result = await run(() => api(`/api/menu/modifiers/${modifier.id}`, { method: "DELETE" }));
    if (!result.ok) setFormError(result.error ?? "");
  }

  /** One atomic reorder call for this group's options — never a 2-PATCH swap. */
  async function moveOption(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= options.length) return;
    const ids = options.map((option) => option.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    const result = await run(() =>
      api("/api/menu/reorder", {
        method: "POST",
        body: JSON.stringify({ entity: "modifiers", ids }),
      }),
    );
    if (!result.ok) setFormError(result.error ?? "");
  }

  async function saveOptionEdit() {
    if (!editOption) return;
    const trimmed = editOption.name.trim();
    if (!trimmed) {
      setFormError("نام افزودنی الزامی است.");
      return;
    }
    const result = await run(() =>
      api(`/api/menu/modifiers/${editOption.id}`, {
        method: "PATCH",
        // `priceDelta` is kept as integer Rial in state (the input converts
        // through money.parse on every keystroke), so it is sent as-is.
        body: JSON.stringify({ name: trimmed, priceDelta: editOption.priceDelta }),
      }),
    );
    if (result.ok) setEditOption(null);
    else setFormError(result.error ?? "");
  }

  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        side="right"
        aria-label={`جزئیات گروه ${group.name}`}
        className="w-full max-w-none gap-0 overflow-y-auto p-0 sm:w-[30rem] sm:max-w-[30rem]"
      >
        <SheetHeader className="shrink-0 border-b border-border/80 px-4 py-3 pe-12">
          <SheetTitle>{group.name}</SheetTitle>
          <SheetDescription>
            قاعدهٔ انتخاب، گزینه‌ها با مبلغ افزوده، و آیتم‌هایی که این گروه را دارند.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-5 p-4 pb-24">
          <ErrorBox>{formError}</ErrorBox>

          <section aria-label="تنظیمات گروه" className="space-y-1">
            {canEdit ? (
              <>
                <Field label="نام گروه">
                  <input
                    className={inputClass}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </Field>
                <div className="flex gap-3">
                  <Field label="حداقل انتخاب">
                    <PersianNumberInput
                      value={minSelect}
                      onChange={(event) => setMinSelect(event.target.value)}
                      grouping={false}
                      inputMode="numeric"
                      className={inputClass}
                    />
                  </Field>
                  <Field label="حداکثر انتخاب">
                    <PersianNumberInput
                      value={maxSelect}
                      onChange={(event) => setMaxSelect(event.target.value)}
                      grouping={false}
                      inputMode="numeric"
                      className={inputClass}
                    />
                  </Field>
                </div>
                <div className="flex items-center justify-between gap-3 rounded-xl border border-border/80 bg-muted/40 px-3 py-2.5">
                  <span className="text-sm">فعال بودن گروه</span>
                  <span className="flex items-center gap-2">
                    <StatusBadge tone={isActive ? "positive" : "neutral"}>
                      {isActive ? "فعال" : "غیرفعال"}
                    </StatusBadge>
                    <Switch
                      checked={isActive}
                      onCheckedChange={setIsActive}
                      aria-label="فعال بودن گروه افزودنی"
                    />
                  </span>
                </div>
                <Button className="w-full" onClick={() => void saveGroup()}>
                  ذخیرهٔ تنظیمات گروه
                </Button>
              </>
            ) : (
              <div className="rounded-xl border border-border/80 bg-muted/40 px-3 py-2.5 text-sm">
                <span className="block font-medium">{group.name}</span>
                <span className="block text-muted-foreground">
                  {toPersianDigits(group.minSelect)} از {toPersianDigits(group.maxSelect)} ·{" "}
                  {group.isActive ? "فعال" : "غیرفعال"}
                </span>
              </div>
            )}
          </section>

          <section aria-label="گزینه‌ها" className="space-y-3">
            <h3 className="text-sm font-semibold text-foreground">گزینه‌ها</h3>
            {options.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
                این گروه هنوز گزینه‌ای ندارد.
              </p>
            ) : (
              <ul className="space-y-2">
                {options.map((option, index) => (
                  <li
                    key={option.id}
                    className="rounded-xl border border-border/80 bg-card p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{option.name}</span>
                        <span className="block text-xs text-muted-foreground tabular-nums">
                          {option.priceDelta === 0
                            ? "بدون مبلغ اضافه"
                            : `${option.priceDelta > 0 ? "+" : "−"}${money.format(Math.abs(option.priceDelta), { withUnit: true })}`}
                        </span>
                      </span>
                      {canEdit ? (
                        <span className="flex shrink-0 items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`بالا بردن ${option.name}`}
                            disabled={index === 0}
                            onClick={() => void moveOption(index, -1)}
                          >
                            <ArrowUpIcon className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`پایین بردن ${option.name}`}
                            disabled={index === options.length - 1}
                            onClick={() => void moveOption(index, 1)}
                          >
                            <ArrowDownIcon className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`ویرایش ${option.name}`}
                            onClick={() => {
                              setFormError("");
                              setEditOption(option);
                            }}
                          >
                            <PencilIcon className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`حذف ${option.name}`}
                            onClick={() => void removeOption(option)}
                          >
                            <Trash2Icon className="size-4" />
                          </Button>
                        </span>
                      ) : null}
                    </div>
                    {canEdit ? (
                      <div className="mt-2 flex items-center justify-between gap-2 border-t border-border/60 pt-2">
                        <span className="text-xs text-muted-foreground">فعال</span>
                        <Switch
                          checked={option.isActive}
                          onCheckedChange={() => void toggleOption(option)}
                          size="sm"
                          aria-label={`فعال بودن ${option.name}`}
                        />
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

            {canEdit ? (
              <div className="rounded-xl border border-dashed border-border p-3">
                <h4 className="mb-2 text-sm font-medium">افزودن گزینه</h4>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    className={inputClass}
                    value={optionName}
                    onChange={(event) => setOptionName(event.target.value)}
                    placeholder="نام، مثلاً «شات اسپرسو»"
                    aria-label="نام گزینهٔ جدید"
                  />
                  <div className="w-full sm:w-44">
                    <PersianNumberInput
                      value={optionDelta}
                      onChange={(event) => setOptionDelta(event.target.value)}
                      allowNegative
                      grouping
                      inputMode="decimal"
                      className={inputClass}
                      placeholder={`مبلغ (${money.unitLabel})`}
                      aria-label="مبلغ افزوده"
                    />
                  </div>
                  <Button className="shrink-0" onClick={() => void addOption()}>
                    <PlusIcon className="size-4" data-icon="inline-start" />
                    افزودن
                  </Button>
                </div>
              </div>
            ) : null}
          </section>

          <section aria-label="آیتم‌هایی که این گروه را دارند" className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">
              آیتم‌هایی که این گروه را دارند ({toPersianDigits(itemsUsing.length)})
            </h3>
            {itemsUsing.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                هنوز هیچ آیتمی به این گروه وصل نیست؛ از برگهٔ «آیتم‌ها» و بخش افزودنی‌های آیتم
                متصل کنید.
              </p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {itemsUsing.map((item) => (
                  <li
                    key={item.id}
                    className="rounded-xl border border-border/80 bg-muted/40 px-2.5 py-1 text-sm"
                  >
                    {item.name}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* The option edit dialog lives inside the sheet's tree so it layers
            above it rather than behind it. */}
        <Dialog
          open={editOption !== null}
          onOpenChange={(next) => {
            if (!next) setEditOption(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>ویرایش «{editOption?.name}»</DialogTitle>
              <DialogDescription>نام و مبلغ افزودهٔ این گزینه را تغییر دهید.</DialogDescription>
            </DialogHeader>
            <ErrorBox>{formError}</ErrorBox>
            {editOption ? (
              <>
                <Field label="نام گزینه">
                  <input
                    className={inputClass}
                    value={editOption.name}
                    onChange={(event) =>
                      setEditOption({ ...editOption, name: event.target.value })
                    }
                  />
                </Field>
                <Field label={`مبلغ افزوده (${money.unitLabel})`}>
                  <PersianNumberInput
                    value={String(money.toInput(editOption.priceDelta))}
                    onChange={(event) => {
                      setEditOption({
                        ...editOption,
                        priceDelta: money.parse(event.target.value),
                      });
                    }}
                    allowNegative
                    grouping
                    inputMode="decimal"
                    className={inputClass}
                  />
                </Field>
              </>
            ) : null}
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditOption(null)}>
                انصراف
              </Button>
              <Button onClick={() => void saveOptionEdit()}>ذخیره</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </SheetContent>
    </Sheet>
  );
}

function GroupFormDialog({
  data,
  state,
  error,
  run,
  onClose,
}: {
  data: RestaurantMenuData;
  state: null | { mode: "create" } | { mode: "edit"; groupId: string };
  error: string;
  run: Runner;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [minSelect, setMinSelect] = useState("0");
  const [maxSelect, setMaxSelect] = useState("1");
  const [localError, setLocalError] = useState("");
  const [seen, setSeen] = useState<string | null>(null);
  const key = state ? (state.mode === "edit" ? state.groupId : "create") : null;
  if (state && seen !== key) {
    const existing =
      state.mode === "edit"
        ? (data.modifierGroups.find((group) => group.id === state.groupId) ?? null)
        : null;
    setSeen(key);
    setName(existing?.name ?? "");
    setMinSelect(String(existing?.minSelect ?? 0));
    setMaxSelect(String(existing?.maxSelect ?? 1));
    setLocalError("");
  }

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) {
      setLocalError("نام گروه الزامی است.");
      return;
    }
    const min = Number(minSelect);
    const max = Number(maxSelect);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < 0 || min > max) {
      setLocalError("حداقل و حداکثر انتخاب را درست وارد کنید.");
      return;
    }
    const result = await run(() =>
      api("/api/menu/modifier-groups", {
        method: "POST",
        body: JSON.stringify({ name: trimmed, minSelect: min, maxSelect: max }),
      }),
    );
    if (result.ok) onClose();
    else setLocalError(result.error ?? "");
  }

  if (!state || state.mode !== "create") return null;
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>افزودن گروه افزودنی</DialogTitle>
          <DialogDescription>
            گروه می‌سازید (مثل «اندازه»)؛ گزینه‌ها را در جزئیات گروه اضافه می‌کنید.
          </DialogDescription>
        </DialogHeader>
        <ErrorBox>{localError || error}</ErrorBox>
        <Field label="نام گروه">
          <input
            className={inputClass}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="مثلاً «شیر اضافه»"
          />
        </Field>
        <div className="flex gap-3">
          <Field label="حداقل انتخاب">
            <PersianNumberInput
              value={minSelect}
              onChange={(event) => setMinSelect(event.target.value)}
              grouping={false}
              inputMode="numeric"
              className={inputClass}
            />
          </Field>
          <Field label="حداکثر انتخاب">
            <PersianNumberInput
              value={maxSelect}
              onChange={(event) => setMaxSelect(event.target.value)}
              grouping={false}
              inputMode="numeric"
              className={inputClass}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            انصراف
          </Button>
          <Button onClick={() => void save()}>افزودن گروه</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReorderGroupsDialog({
  open,
  groups,
  error,
  run,
  onClose,
}: {
  open: boolean;
  groups: RestaurantModifierGroup[];
  error: string;
  run: Runner;
  onClose: () => void;
}) {
  const [order, setOrder] = useState<string[]>([]);
  const [seen, setSeen] = useState(false);
  const [localError, setLocalError] = useState("");
  if (open && !seen) {
    setSeen(true);
    setOrder(groups.map((group) => group.id));
    setLocalError("");
  }
  if (!open && seen) setSeen(false);

  const byId = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);

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
        body: JSON.stringify({ entity: "modifierGroups", ids: order }),
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
          <DialogTitle>مرتب‌سازی گروه‌های افزودنی</DialogTitle>
          <DialogDescription>
            ترتیب با فلش‌ها تنظیم و با یک ذخیرهٔ واحد (یک تراکنش) اعمال می‌شود.
          </DialogDescription>
        </DialogHeader>
        <ErrorBox>{localError || error}</ErrorBox>
        <ol className="space-y-2">
          {order.map((id, index) => {
            const group = byId.get(id);
            if (!group) return null;
            return (
              <li
                key={id}
                className="flex items-center justify-between gap-2 rounded-xl border border-border/80 px-3 py-2"
              >
                <span className="min-w-0 truncate text-sm font-medium">{group.name}</span>
                <span className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`بالا بردن ${group.name}`}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUpIcon className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`پایین بردن ${group.name}`}
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
