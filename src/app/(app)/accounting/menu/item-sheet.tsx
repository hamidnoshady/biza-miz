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
 *
 * Two rules this screen keeps (issue #911):
 *
 * - The create-mode price is a raw string until it parses. Clearing it to
 *   retype is normal, so an empty or half-typed amount is an inline Persian
 *   message, not a thrown parse; `0` is a real initial price.
 * - Without `menu.edit` there is nothing to save: the same Sheet opens
 *   read-only (disabled controls, no «تغییر قیمت», no add-on editing) instead
 *   of rendering a form the API would refuse anyway.
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

/** Ties the inline price message to the field it belongs to, for a screen reader. */
const PRICE_ERROR_ID = "menu-item-create-price-error";

/**
 * An opaque key for one create draft (issue #911).
 *
 * Only uniqueness matters, never secrecy or shape: the server stores it and
 * the database enforces it, and it is not shown anywhere. `crypto.randomUUID`
 * is what it is for; the fallback keeps older browsers — and the jsdom of the
 * test suite, where a non-secure context has no randomUUID — working.
 */
function newCreateKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function ItemSheet({
  mode,
  item,
  initialFocusAddons,
  data,
  canEdit,
  busy,
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
  /** `menu.edit`. Without it the Sheet is a read-only detail view. */
  canEdit: boolean;
  /** A mutation is in flight: the save CTA must not start a second one. */
  busy: boolean;
  run: Runner;
  onClose: () => void;
  /** Create mode hands back the new id so the Sheet can flip into edit mode. */
  onCreated: (id: string) => void;
  /** Opens the dedicated price dialog (edit mode only). */
  onChangePrice?: (item: RestaurantMenuItem) => void;
}) {
  const money = useMoney();
  const editing = mode === "edit" && item !== null;
  const readOnly = !canEdit;
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
  /** Doubles as the double-submit guard: a click while saving is ignored. */
  const savingRef = useRef(false);
  /**
   * One create key per draft (issue #911).
   *
   * The guard above stops a click that lands while a save is in flight, but
   * not a save whose answer never arrived — a timeout, a dropped connection,
   * a reload mid-flight — where the operator is entitled to press «ذخیره»
   * again. The first attempt mints the key and every retry of that draft
   * reuses it, so the server answers the retry with the item the first
   * attempt created instead of making a second one. A successful create ends
   * the draft and drops the key; edits only start with `mode` switching.
   */
  const createKeyRef = useRef<string | null>(null);

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
    createKeyRef.current = null;
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
  /** Active-option count per group, used both by the rows and the attach picker. */
  const activeOptionsByGroup = useMemo(() => {
    const counts = new Map<string, number>();
    for (const modifier of data.modifiers) {
      if (!modifier.isActive) continue;
      counts.set(modifier.groupId, (counts.get(modifier.groupId) ?? 0) + 1);
    }
    return counts;
  }, [data.modifiers]);

  /**
   * Groups not yet attached, including disabled ones — visibly marked rather
   * than silently absent, so a manager can see the whole configuration and
   * knows the POS will not offer a disabled group. The label states the
   * option count and rule, so attaching is an informed choice.
   */
  const attachableGroups = useMemo(() => {
    const attached = new Set(itemLinks.map((link) => link.modifierGroupId));
    return data.modifierGroups
      .filter((group) => !attached.has(group.id))
      .map((group) => {
        const optionCount = activeOptionsByGroup.get(group.id) ?? 0;
        const options = toPersianDigits(optionCount);
        const rule = `${toPersianDigits(group.minSelect)} از ${toPersianDigits(group.maxSelect)}`;
        // A group whose active option count cannot satisfy its own minimum
        // would be refused by the server on attach; naming the reason here
        // stops the manager from discovering it as an unexplained 409.
        const unsatisfiable =
          group.isActive && group.minSelect > optionCount
            ? " · حداقل انتخاب از تعداد گزینه‌های فعال بیشتر است"
            : "";
        return {
          value: group.id,
          label: group.isActive
            ? `${group.name} — ${options} گزینه · ${rule}${unsatisfiable}`
            : `${group.name} — غیرفعال (در صندلی نمایش داده نمی‌شود) · ${options} گزینه · ${rule}`,
        };
      });
  }, [data.modifierGroups, itemLinks, activeOptionsByGroup]);

  const [attachGroupId, setAttachGroupId] = useState("");
  /**
   * Detaching is one trash icon beside the reorder arrows, so it gets a
   * confirmation that names the group and states what the POS will stop
   * offering. Existing orders keep their snapshots; only future orders change.
   */
  const [confirmDetach, setConfirmDetach] = useState<RestaurantItemModifierGroup | null>(null);
  const [detachBusy, setDetachBusy] = useState(false);
  const [detachError, setDetachError] = useState("");
  const [moveBusy, setMoveBusy] = useState(false);

  // The create-mode price, parsed the way the operator typed it: never thrown
  // at, so «» (cleared to retype), «-», «.», a negative or an unsafe number
  // are states this form shows instead of exceptions out of `save()`. `0` is
  // a valid initial price — an item can be free, or priced later.
  const priceParsed = money.tryParse(priceInput);
  // An empty price is «not filled in yet» — the field says nothing and the
  // save attempt reports it at the form level. A price that is there but
  // unusable («-», «12.53», a negative) is answered here, by the field.
  const priceError =
    priceParsed.ok || priceParsed.problem === "empty"
      ? ""
      : money.problemMessage(priceParsed.problem);

  /** A save that starts while another is in flight would create a second item. */
  function saving() {
    if (savingRef.current || busy) return true;
    savingRef.current = true;
    return false;
  }

  async function save() {
    // `menu.view` has no write to make, and a save that starts while another
    // is in flight would create a second item (issue #911).
    if (!canEdit) return;
    if (saving()) return;
    try {
      await saveOnce();
    } finally {
      savingRef.current = false;
    }
  }

  async function saveOnce() {
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
      if (!priceParsed.ok) {
        // A blank box is the form's to report; a value that cannot be a price
        // is already answered inline, so the box would only repeat it.
        setFormError(priceParsed.problem === "empty" ? "قیمت فروش را درست وارد کنید." : "");
        return;
      }
      const price = priceParsed.rial;
      // Minted on the first attempt of this draft and reused by every retry.
      createKeyRef.current ??= newCreateKey();
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
            idempotencyKey: createKeyRef.current,
          }),
        }),
      );
      if (result.ok) {
        // The draft is over — a reopened sheet starts with a new key, so it
        // creates a genuinely new item.
        createKeyRef.current = null;
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

  async function detachGroup(groupId: string): Promise<boolean> {
    if (!item) return false;
    const result = await run(() =>
      api(
        `/api/menu/item-modifier-groups?menuItemId=${encodeURIComponent(item.id)}&modifierGroupId=${encodeURIComponent(groupId)}`,
        { method: "DELETE" },
      ),
    );
    if (!result.ok) setDetachError(result.error ?? "");
    return result.ok;
  }

  async function moveLink(index: number, direction: -1 | 1) {
    if (!item || moveBusy) return;
    const target = index + direction;
    if (target < 0 || target >= itemLinks.length) return;
    // ONE request carrying the complete new order: the server reassigns every
    // position in a single UPDATE inside one transaction. The old two-PATCH
    // swap could commit the first write and fail the second, leaving two
    // links on one slot — and the POS rendering that corrupted order.
    const groupIds = itemLinks.map((link) => link.modifierGroupId);
    [groupIds[index], groupIds[target]] = [groupIds[target], groupIds[index]];
    setMoveBusy(true);
    try {
      const result = await run(() =>
        api("/api/menu/item-modifier-groups/reorder", {
          method: "POST",
          body: JSON.stringify({ menuItemId: item.id, groupIds }),
        }),
      );
      if (!result.ok) setFormError(result.error ?? "");
    } finally {
      setMoveBusy(false);
    }
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
            {readOnly
              ? "شما اجازهٔ ویرایش منو را ندارید؛ این نمای فقط‌خواندنی است."
              : editing
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
                readOnly={readOnly}
                onChange={(event) => setName(event.target.value)}
                placeholder="مثلاً «لاتهٔ کارامل»"
                disabled={readOnly}
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
                disabled={readOnly}
                placeholder="انتخاب دسته…"
                ariaLabel="دستهٔ آیتم"
              />
            </Field>
            <Field label="کد کالا (SKU)" hint="در جستجوی صندوق هم پیدا می‌شود؛ اختیاری است.">
              <input
                className={inputClass}
                value={sku}
                dir="ltr"
                readOnly={readOnly}
                onChange={(event) => setSku(event.target.value)}
                placeholder="مثلاً LAT-01"
                disabled={readOnly}
              />
            </Field>
            <Field label="توضیحات">
              <textarea
                className={`${inputClass} min-h-20 py-2`}
                value={description}
                readOnly={readOnly}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="توضیح کوتاه برای منو یا صندوق"
                disabled={readOnly}
              />
            </Field>
            <MediaImageField
              label="تصویر آیتم"
              value={imageMediaId}
              onChange={setImageMediaId}
              disabled={readOnly}
            />
          </section>

          {editing ? (
            <section aria-label="قیمت فروش" className="space-y-2">
              <h3 className="text-sm font-semibold text-foreground">قیمت فروش</h3>
              <div className="flex items-center justify-between gap-3 rounded-xl border border-border/80 bg-muted/40 px-3 py-2.5">
                <span className="text-sm font-medium tabular-nums">
                  {item ? money.format(item.price, { withUnit: true }) : "—"}
                </span>
                {canEdit && onChangePrice && item ? (
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
              <Field label={`قیمت (${money.unitLabel})`} hint="مبلغ ۰ هم قابل ثبت است.">
                <PersianNumberInput
                  value={priceInput}
                  onChange={(event) => setPriceInput(event.target.value)}
                  readOnly={readOnly}
                  grouping
                  inputMode="numeric"
                  className={inputClass}
                  placeholder="مثلاً ۱۲۰٬۰۰۰"
                  aria-invalid={priceError ? true : undefined}
                  aria-describedby={priceError ? PRICE_ERROR_ID : undefined}
                />
              </Field>
              {priceError ? (
                <p id={PRICE_ERROR_ID} role="alert" className="-mt-3 mb-3 text-xs text-destructive">
                  {priceError}
                </p>
              ) : null}
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
                disabled={readOnly}
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
                    const activeOptions = activeOptionsByGroup.get(link.modifierGroupId) ?? 0;
                    const unavailableReason = !group
                      ? "گروه ناموجود است"
                      : !group.isActive
                        ? "گروه غیرفعال است"
                        : !link.isActive
                          ? "این اتصال غیرفعال است"
                          : bounds && bounds.minSelect > activeOptions
                            ? "گزینهٔ فعال کافی برای حداقل انتخاب نیست"
                            : null;
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
                              {" · "}
                              {toPersianDigits(activeOptions)} گزینهٔ فعال
                              {link.minSelectOverride !== null || link.maxSelectOverride !== null
                                ? " · اختصاصی"
                                : ""}
                              {" · "}
                              ترتیب {toPersianDigits(link.sortOrder + 1)}
                            </span>
                            <span className="mt-1 flex flex-wrap items-center gap-1">
                              <StatusBadge tone={unavailableReason ? "neutral" : "positive"}>
                                {unavailableReason ? "قابل فروش نیست" : "قابل فروش در صندلی"}
                              </StatusBadge>
                              {unavailableReason ? (
                                <span className="text-[11px] text-muted-foreground">
                                  {unavailableReason}
                                </span>
                              ) : null}
                            </span>
                          </div>
                          {canEdit ? (
                          <span className="flex shrink-0 items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`بالا بردن ${group?.name ?? ""}`}
                              disabled={index === 0 || moveBusy}
                              onClick={() => void moveLink(index, -1)}
                            >
                              <ArrowUpIcon className="size-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`پایین بردن ${group?.name ?? ""}`}
                              disabled={index === itemLinks.length - 1 || moveBusy}
                              onClick={() => void moveLink(index, 1)}
                            >
                              <ArrowDownIcon className="size-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`حذف اتصال ${group?.name ?? ""}`}
                              onClick={() => {
                                setDetachError("");
                                setConfirmDetach(link);
                              }}
                            >
                              <TrashIcon className="size-4" />
                            </Button>
                          </span>
                          ) : null}
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
                              disabled={readOnly}
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
                        ) : canEdit ? (
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
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}

              {canEdit && attachableGroups.length > 0 ? (
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
                    disabled={busy || !attachGroupId}
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
          {canEdit ? (
            <>
              {/* A save already in flight disables the CTA: a second one
                  would create a second item (issue #911). */}
              <PrimaryButton disabled={busy} onClick={() => void save()}>
                {editing ? "ذخیرهٔ تغییرات" : "افزودن آیتم"}
              </PrimaryButton>
              <SecondaryButton onClick={onClose}>انصراف</SecondaryButton>
            </>
          ) : (
            // `menu.view` only: there is nothing to save, so the Sheet is a
            // detail view that closes rather than a form the API would refuse.
            <SecondaryButton onClick={onClose}>بستن</SecondaryButton>
          )}
        </div>
      </SheetContent>

      {/*
        Rendered inside the Sheet root but in its own portal: the confirmation
        stacks above the sheet and traps focus, then hands focus back to it.
      */}
      <Dialog
        open={confirmDetach !== null}
        onOpenChange={(next) => {
          if (!next && !detachBusy) setConfirmDetach(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmDetach
                ? `قطع اتصال «${groupsById.get(confirmDetach.modifierGroupId)?.name ?? "این گروه"}»`
                : "قطع اتصال"}
            </DialogTitle>
            <DialogDescription>
              این گروه از منوی این آیتم حذف می‌شود و در سفارش‌های بعدی پیشنهاد
              نمی‌شود. سفارش‌های قبلی و اسناد فروش با همان اطلاعات ثبت‌شده
              باقی می‌مانند. خود گروه و گزینه‌هایش حذف نمی‌شوند.
            </DialogDescription>
          </DialogHeader>
          <ErrorBox>{detachError}</ErrorBox>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={detachBusy}
              onClick={() => setConfirmDetach(null)}
            >
              انصراف
            </Button>
            <Button
              variant="destructive"
              disabled={detachBusy}
              onClick={() => {
                if (!confirmDetach) return;
                setDetachError("");
                setDetachBusy(true);
                void detachGroup(confirmDetach.modifierGroupId)
                  .then((ok) => {
                    if (ok) setConfirmDetach(null);
                  })
                  .finally(() => setDetachBusy(false));
              }}
            >
              {detachBusy ? "در حال اعمال…" : "قطع کن"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
