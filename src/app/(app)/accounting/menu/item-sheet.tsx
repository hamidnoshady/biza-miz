"use client";

/**
 * The item create/edit Sheet — issue #844.
 *
 * Opens from the right (the RTL leading edge), full-height/full-width on a
 * phone. It owns only *item identity* fields — اطلاعات اصلی (name, category,
 * SKU, description, image), وضعیت فروش and (on creation) the initial price.
 *
 * An existing item's price is deliberately NOT a field here: selling price
 * changes only through the dedicated audited dialog, which is one click away
 * from the edit state («تغییر قیمت» below the read-only price line) and posts
 * to `/api/menu/items/:id/price-change`.
 *
 * The افزودنی‌ها section is the per-item attachment manager: which groups are
 * attached, their effective min/max, each link's active state, its per-item
 * order, and the per-link min/max overrides (blank = inherit the group's
 * default; the override editor the retired manager had lives here) — the same
 * order and bounds the POS and the waiter screen honour.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, TrashIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import {
  ErrorBox,
  Field,
  PrimaryButton,
  SecondaryButton,
  api,
  errorMessageOrRaw,
  inputClass,
} from "@/app/dashboard/ui";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { MediaImageField } from "@/app/dashboard/media/media-picker";
import { StatusBadge } from "@/app/dashboard/page-chrome";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import {
  effectiveBounds,
  type RestaurantMenuData,
  type RestaurantMenuItem,
  type RestaurantItemModifierGroup,
  type RestaurantModifierGroup,
} from "@/lib/restaurant-menu";
import type { Runner } from "./menu-workspace";

export function ItemSheet({
  mode,
  item,
  initialFocusAddons,
  data,
  run,
  onClose,
  onCreated,
  onChangePrice,
}: {
  mode: "create" | "edit";
  /** The row being edited; `null` in create mode. */
  item: RestaurantMenuItem | null;
  /** The «افزودنی‌ها» row action opens with this section in view. */
  initialFocusAddons: boolean;
  data: RestaurantMenuData;
  run: Runner;
  onClose: () => void;
  /** Create mode hands back the new id so the Sheet can flip into edit mode. */
  onCreated: (id: string) => void;
  /** Opens the dedicated price dialog (edit mode only). */
  onChangePrice?: (item: RestaurantMenuItem) => void;
}) {
  const money = useMoney();
  const editing = mode === "edit" && item !== null;
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [sku, setSku] = useState("");
  const [description, setDescription] = useState("");
  const [imageMediaId, setImageMediaId] = useState<string | null>(null);
  const [isActive, setIsActive] = useState(true);
  const [priceInput, setPriceInput] = useState("");
  const [formError, setFormError] = useState("");
  /** Which attachment's «محدودیت اختصاصی» editor is open (one at a time). */
  const [overrideEditorId, setOverrideEditorId] = useState<string | null>(null);
  const addonsRef = useRef<HTMLDivElement>(null);

  // (Re)fill the form whenever the sheet switches target — mount, or the
  // create → edit hand-off after onCreated.
  useEffect(() => {
    setFormError("");
    setName(item?.name ?? "");
    setCategoryId(item?.categoryId ?? "");
    setSku(item?.sku ?? "");
    setDescription(item?.description ?? "");
    setImageMediaId(item?.imageMediaId ?? null);
    setIsActive(item?.isActive ?? true);
    setPriceInput(item ? String(money.toInput(item.price)) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed to the target, not every money identity change
  }, [item?.id, mode]);

  useEffect(() => {
    if (initialFocusAddons && editing) {
      addonsRef.current?.scrollIntoView({ block: "start" });
    }
  }, [initialFocusAddons, editing]);

  const categories = useMemo(
    () =>
      data.categories
        .filter((category) => category.isActive || category.id === item?.categoryId)
        .map((category) => ({ value: category.id, label: category.name })),
    [data.categories, item],
  );

  const itemLinks = useMemo(() => {
    if (!item) return [];
    return data.itemModifierGroups
      .filter((link) => link.menuItemId === item.id)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }, [data.itemModifierGroups, item]);

  const groupsById = useMemo(
    () => new Map(data.modifierGroups.map((group) => [group.id, group])),
    [data.modifierGroups],
  );
  const attachableGroups = useMemo(() => {
    const attached = new Set(itemLinks.map((link) => link.modifierGroupId));
    return data.modifierGroups
      .filter((group) => !attached.has(group.id))
      .map((group) => ({ value: group.id, label: group.name }));
  }, [data.modifierGroups, itemLinks]);

  const [attachGroupId, setAttachGroupId] = useState("");

  async function save() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError("نام آیتم الزامی است.");
      return;
    }
    if (!editing && !categoryId) {
      setFormError("برای ساخت آیتم، دسته را انتخاب کنید.");
      return;
    }
    if (!editing) {
      const price = money.parse(priceInput);
      if (priceInput.trim() === "" || !Number.isFinite(price) || price < 0) {
        setFormError("قیمت فروش را درست وارد کنید.");
        return;
      }
      const result = await run(() =>
        api<{ ok?: boolean; id?: string }>("/api/menu/items", {
          method: "POST",
          body: JSON.stringify({
            name: trimmedName,
            categoryId,
            price,
            description: description.trim() || undefined,
            sku: sku.trim() || undefined,
            imageMediaId: imageMediaId ?? undefined,
            isActive,
          }),
        }),
      );
      if (result.ok) {
        // The workspace re-fetches; hand the new id back so the Sheet reopens
        // in edit mode with the افزودنی‌ها section ready.
        if (typeof result.data.id === "string") onCreated(result.data.id);
        else onClose();
      } else {
        setFormError(result.error ?? "");
      }
      return;
    }

    const body: Record<string, unknown> = {
      name: trimmedName,
      description: description.trim() || null,
      sku: sku.trim() || null,
      imageMediaId,
      isActive,
    };
    // Only a *chosen* category is sent: `categoryId: ""` means the item keeps
    // (or stays in) «بدون دسته», which the patch validator models by omission.
    if (categoryId) body.categoryId = categoryId;
    const result = await run(() =>
      api(`/api/menu/items/${item.id}`, { method: "PATCH", body: JSON.stringify(body) }),
    );
    if (!result.ok) setFormError(result.error ?? "");
  }

  /** Applies one attachment patch; resolves `false` when the server refused. */
  async function patchLink(groupId: string, patch: Record<string, unknown>) {
    if (!item) return false;
    const result = await run(() =>
      api("/api/menu/item-modifier-groups", {
        method: "PATCH",
        body: JSON.stringify({ menuItemId: item.id, modifierGroupId: groupId, ...patch }),
      }),
    );
    if (!result.ok) setFormError(result.error ?? "");
    return result.ok;
  }

  /**
   * The per-link min/max overrides — a patch of just the attachment
   * configuration, same door as patchLink but reporting the failure to the
   * editor inline (it sits far from the sheet-level error box).
   */
  async function saveOverrides(
    groupId: string,
    patch: { minSelectOverride: number | null; maxSelectOverride: number | null },
  ): Promise<{ ok: boolean; error?: string }> {
    if (!item) return { ok: false, error: "" };
    const result = await run(() =>
      api("/api/menu/item-modifier-groups", {
        method: "PATCH",
        body: JSON.stringify({ menuItemId: item.id, modifierGroupId: groupId, ...patch }),
      }),
    );
    return { ok: result.ok, error: result.ok ? undefined : (result.error ?? "") };
  }

  async function attachGroup() {
    if (!item || !attachGroupId) return;
    const result = await run(() =>
      api("/api/menu/item-modifier-groups", {
        method: "POST",
        body: JSON.stringify({ menuItemId: item.id, modifierGroupId: attachGroupId }),
      }),
    );
    if (result.ok) setAttachGroupId("");
    else setFormError(result.error ?? "");
  }

  async function detachGroup(groupId: string) {
    if (!item) return;
    const result = await run(() =>
      api(
        `/api/menu/item-modifier-groups?menuItemId=${encodeURIComponent(item.id)}&modifierGroupId=${encodeURIComponent(groupId)}`,
        { method: "DELETE" },
      ),
    );
    if (!result.ok) setFormError(result.error ?? "");
  }

  async function moveLink(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= itemLinks.length) return;
    const current = itemLinks[index];
    const neighbour = itemLinks[target];
    // Two single-row patches: each is atomic; the pair exchanges their orders.
    // The first failure stops the swap (no half-applied silent state) and the
    // reload shows the true order for a retry.
    const first = await patchLink(current.modifierGroupId, { sortOrder: neighbour.sortOrder });
    if (!first) return;
    await patchLink(neighbour.modifierGroupId, { sortOrder: current.sortOrder });
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
        aria-label={editing ? "ویرایش آیتم منو" : "افزودن آیتم منو"}
        className="w-full max-w-none gap-0 overflow-y-auto p-0 sm:w-[30rem] sm:max-w-[30rem]"
      >
        <SheetHeader className="shrink-0 border-b border-border/80 px-4 py-3 pe-12">
          <SheetTitle>{editing ? `ویرایش «${item?.name}»` : "افزودن آیتم" }</SheetTitle>
          <SheetDescription>
            {editing
              ? "اطلاعات اصلی، وضعیت فروش و افزودنی‌های این آیتم. قیمت از مسیر اختصاصی «تغییر قیمت» عوض می‌شود."
              : "نام، دسته و قیمت فروش را وارد کنید؛ بقیهٔ جزئیات را همین‌جا می‌توانید کامل کنید."}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-5 p-4 pb-24">
          <ErrorBox>{formError}</ErrorBox>

          <section aria-label="اطلاعات اصلی" className="space-y-1">
            <h3 className="mb-2 text-sm font-semibold text-foreground">اطلاعات اصلی</h3>
            <Field label="نام آیتم">
              <input
                className={inputClass}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="مثلاً «لاتهٔ کارامل»"
              />
            </Field>
            <Field
              label="دسته"
              hint={
                categories.length === 0
                  ? "ابتدا در برگهٔ «دسته‌ها» یک دستهٔ فعال بسازید."
                  : editing
                    ? undefined
                    : "برای ساخت آیتم، دسته الزامی است."
              }
            >
              <SearchableSelect
                value={categoryId}
                onChange={setCategoryId}
                options={categories}
                placeholder="انتخاب دسته…"
                ariaLabel="دستهٔ آیتم"
              />
            </Field>
            <Field label="کد کالا (SKU)" hint="در جستجوی صندوق هم پیدا می‌شود؛ اختیاری است.">
              <input
                className={inputClass}
                value={sku}
                dir="ltr"
                onChange={(event) => setSku(event.target.value)}
                placeholder="مثلاً LAT-01"
              />
            </Field>
            <Field label="توضیحات">
              <textarea
                className={`${inputClass} min-h-20 py-2`}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="توضیح کوتاه برای منو یا صندوق"
              />
            </Field>
            <MediaImageField
              label="تصویر آیتم"
              value={imageMediaId}
              onChange={setImageMediaId}
            />
          </section>

          {editing ? (
            <section aria-label="قیمت فروش" className="space-y-2">
              <h3 className="text-sm font-semibold text-foreground">قیمت فروش</h3>
              <div className="flex items-center justify-between gap-3 rounded-xl border border-border/80 bg-muted/40 px-3 py-2.5">
                <span className="text-sm font-medium tabular-nums">
                  {item ? money.format(item.price, { withUnit: true }) : "—"}
                </span>
                {onChangePrice && item ? (
                  <Button variant="outline" size="sm" onClick={() => onChangePrice(item)}>
                    تغییر قیمت
                  </Button>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">
                قیمتِ موجود فقط از مسیر «تغییر قیمت» عوض می‌شود؛ هر تغییر، با دلیل و تاریخچهٔ
                دائمی ثبت می‌شود.
              </p>
            </section>
          ) : (
            <section aria-label="قیمت فروش" className="space-y-1">
              <h3 className="mb-2 text-sm font-semibold text-foreground">قیمت فروش</h3>
              <Field label={`قیمت (${money.unitLabel})`}>
                <PersianNumberInput
                  value={priceInput}
                  onChange={(event) => setPriceInput(event.target.value)}
                  grouping
                  inputMode="numeric"
                  className={inputClass}
                  placeholder="مثلاً ۱۲۰٬۰۰۰"
                />
              </Field>
            </section>
          )}

          <section aria-label="وضعیت فروش" className="flex items-center justify-between gap-3">
            <span>
              <span className="block text-sm font-medium text-foreground">وضعیت فروش</span>
              <span className="block text-xs text-muted-foreground">
                آیتم غیرفعال در منو و صندوق دیده نمی‌شود.
              </span>
            </span>
            <span className="flex items-center gap-2">
              <StatusBadge tone={isActive ? "positive" : "neutral"}>
                {isActive ? "فعال" : "غیرفعال"}
              </StatusBadge>
              <Switch
                checked={isActive}
                onCheckedChange={setIsActive}
                aria-label="فعال بودن آیتم"
              />
            </span>
          </section>

          {editing ? (
            <section ref={addonsRef} aria-label="افزودنی‌ها" className="space-y-3 scroll-mt-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-foreground">افزودنی‌ها</h3>
                <span className="text-xs text-muted-foreground">
                  {toPersianDigits(itemLinks.length)} گروه وصل‌شده
                </span>
              </div>

              {itemLinks.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
                  هنوز گروه افزودنی به این آیتم وصل نشده است.
                </p>
              ) : (
                <ul className="space-y-2">
                  {itemLinks.map((link, index) => {
                    const group = groupsById.get(link.modifierGroupId);
                    const bounds = group ? effectiveBounds(group, link) : null;
                    return (
                      <li
                        key={link.modifierGroupId}
                        className="rounded-xl border border-border/80 bg-card p-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <span className="block truncate text-sm font-medium">
                              {group?.name ?? "گروه ناموجود"}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {bounds
                                ? `${toPersianDigits(bounds.minSelect)} از ${toPersianDigits(bounds.maxSelect)}`
                                : "—"}
                              {link.minSelectOverride !== null || link.maxSelectOverride !== null
                                ? " · اختصاصی"
                                : ""}
                              {" · "}
                              ترتیب {toPersianDigits(link.sortOrder + 1)}
                            </span>
                          </div>
                          <span className="flex shrink-0 items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`بالا بردن ${group?.name ?? ""}`}
                              disabled={index === 0}
                              onClick={() => void moveLink(index, -1)}
                            >
                              <ArrowUpIcon className="size-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`پایین بردن ${group?.name ?? ""}`}
                              disabled={index === itemLinks.length - 1}
                              onClick={() => void moveLink(index, 1)}
                            >
                              <ArrowDownIcon className="size-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`حذف اتصال ${group?.name ?? ""}`}
                              onClick={() => void detachGroup(link.modifierGroupId)}
                            >
                              <TrashIcon className="size-4" />
                            </Button>
                          </span>
                        </div>
                        <div className="mt-2 flex items-center justify-between gap-2 border-t border-border/60 pt-2">
                          <span className="text-xs text-muted-foreground">
                            پیشنهاد در سفارش
                          </span>
                          <span className="flex items-center gap-2">
                            <StatusBadge tone={link.isActive ? "positive" : "neutral"}>
                              {link.isActive ? "فعال" : "غیرفعال"}
                            </StatusBadge>
                            <Switch
                              checked={link.isActive}
                              onCheckedChange={(checked) =>
                                void patchLink(link.modifierGroupId, { isActive: checked })
                              }
                              aria-label={`پیشنهاد ${group?.name ?? ""} در سفارش`}
                            />
                          </span>
                        </div>
                        {overrideEditorId === link.modifierGroupId ? (
                          <LinkOverrideEditor
                            link={link}
                            group={group ?? null}
                            onCancel={() => setOverrideEditorId(null)}
                            onSave={async (patch) => {
                              const result = await saveOverrides(link.modifierGroupId, patch);
                              // Success folds the editor away; failure keeps it
                              // open with the server's message inline.
                              if (result.ok) setOverrideEditorId(null);
                              return result;
                            }}
                          />
                        ) : (
                          <div className="mt-2 flex justify-end border-t border-border/60 pt-2">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-8 text-xs text-muted-foreground"
                              onClick={() => setOverrideEditorId(link.modifierGroupId)}
                            >
                              محدودیت اختصاصی (حداقل/حداکثر)
                            </Button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}

              {attachableGroups.length > 0 ? (
                <div className="flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <Field label="افزودن گروه افزودنی">
                      <SearchableSelect
                        value={attachGroupId}
                        onChange={setAttachGroupId}
                        options={attachableGroups}
                        placeholder="انتخاب گروه…"
                        ariaLabel="گروه افزودنی برای وصل کردن"
                      />
                    </Field>
                  </div>
                  <Button
                    variant="outline"
                    className="mb-4 shrink-0"
                    disabled={!attachGroupId}
                    onClick={() => void attachGroup()}
                  >
                    <PlusIcon className="size-4" data-icon="inline-start" />
                    وصل کردن
                  </Button>
                </div>
              ) : null}
            </section>
          ) : null}
        </div>

        <div className="sticky bottom-0 flex gap-2 border-t border-border/80 bg-card/95 px-4 py-3 backdrop-blur">
          <PrimaryButton onClick={() => void save()}>
            {editing ? "ذخیرهٔ تغییرات" : "افزودن آیتم"}
          </PrimaryButton>
          <SecondaryButton onClick={onClose}>انصراف</SecondaryButton>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Per-attachment selection bounds: blank inherits the group default, a number
 * overrides it for this item only. Validation mirrors the group editor —
 * effective min ≤ effective max, and the effective max is at least 1 — so a
 * bad pair can never reach the POS through the server's per-value check.
 */
function LinkOverrideEditor({
  link,
  group,
  onSave,
  onCancel,
}: {
  link: RestaurantItemModifierGroup;
  group: RestaurantModifierGroup | null;
  onSave: (patch: {
    minSelectOverride: number | null;
    maxSelectOverride: number | null;
  }) => Promise<{ ok: boolean; error?: string }>;
  onCancel: () => void;
}) {
  const seed = (value: number | null) => (value === null ? "" : String(value));
  const [minOverride, setMinOverride] = useState(() => seed(link.minSelectOverride));
  const [maxOverride, setMaxOverride] = useState(() => seed(link.maxSelectOverride));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // Re-seed when the link itself changes (a save that reloads the tree, or
  // another writer): the editor follows the server, not a stale buffer.
  const linkKey = `${link.modifierGroupId}:${link.minSelectOverride}:${link.maxSelectOverride}`;
  const [seenKey, setSeenKey] = useState(linkKey);
  if (seenKey !== linkKey) {
    setSeenKey(linkKey);
    setMinOverride(seed(link.minSelectOverride));
    setMaxOverride(seed(link.maxSelectOverride));
    setError("");
  }

  function parse(raw: string): number | null | undefined {
    if (raw.trim() === "") return null;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 ? value : undefined;
  }

  async function save() {
    const min = parse(minOverride);
    const max = parse(maxOverride);
    if (min === undefined || max === undefined) {
      setError("مقادیر باید عدد صحیح غیرمنفی باشند.");
      return;
    }
    const effectiveMin = min ?? group?.minSelect ?? 0;
    const effectiveMax = max ?? group?.maxSelect ?? 1;
    if (effectiveMax < 1) {
      setError("«حداکثر انتخاب» باید دست‌کم ۱ باشد.");
      return;
    }
    if (effectiveMin > effectiveMax) {
      setError("«حداقل انتخاب» نمی‌تواند از «حداکثر انتخاب» بیشتر باشد.");
      return;
    }
    setError("");
    setSaving(true);
    try {
      const result = await onSave({ minSelectOverride: min, maxSelectOverride: max });
      if (!result.ok) setError(errorMessageOrRaw(result.error));
    } finally {
      setSaving(false);
    }
  }

  // Live view of what would be saved: a number overrides, blank inherits.
  const currentMin = parse(minOverride);
  const currentMax = parse(maxOverride);
  const effectiveMin = currentMin ?? group?.minSelect ?? null;
  const effectiveMax = currentMax ?? group?.maxSelect ?? null;
  const hasOverride = currentMin !== null || currentMax !== null;

  return (
    <div className="mt-2 space-y-2 rounded-xl border border-border/70 bg-muted/40 p-2.5">
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="حداقل انتخاب (اختیاری)">
          <PersianNumberInput
            value={minOverride}
            onChange={(event) => setMinOverride(event.target.value)}
            inputMode="numeric"
            grouping={false}
            className={inputClass}
            placeholder={`پیش‌فرض: ${group ? toPersianDigits(group.minSelect) : "—"}`}
            disabled={saving}
          />
        </Field>
        <Field label="حداکثر انتخاب (اختیاری)">
          <PersianNumberInput
            value={maxOverride}
            onChange={(event) => setMaxOverride(event.target.value)}
            inputMode="numeric"
            grouping={false}
            className={inputClass}
            placeholder={`پیش‌فرض: ${group ? toPersianDigits(group.maxSelect) : "—"}`}
            disabled={saving}
          />
        </Field>
      </div>
      <p className="text-xs text-muted-foreground">
        خالی یعنی پیش‌فرض گروه؛ مقدار ثبت‌شده فقط برای همین آیتم اعمال می‌شود
        {hasOverride && effectiveMin !== null && effectiveMax !== null
          ? ` · مؤثر: ${toPersianDigits(effectiveMin)} تا ${toPersianDigits(effectiveMax)}`
          : ""}
        .
      </p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={onCancel}>
          انصراف
        </Button>
        <SecondaryButton onClick={() => void save()} disabled={saving}>
          ذخیرهٔ محدودیت‌ها
        </SecondaryButton>
      </div>
    </div>
  );
}
