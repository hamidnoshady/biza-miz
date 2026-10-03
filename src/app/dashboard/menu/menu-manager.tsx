"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import {
  useCallback,
  useEffect,
  useState,
  useDeferredValue,
  useMemo,
} from "react";
import { toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import {
  toRestaurantMenu,
  type MenuTreePayload,
  type RestaurantMenuCategory,
  type RestaurantMenuItem,
  type RestaurantMenuData,
  type RestaurantItemModifierGroup,
  type RestaurantModifier,
  type RestaurantModifierGroup,
} from "@/lib/restaurant-menu";
import { MenuItemImage } from "../menu-item-image";
import {
  api,
  ErrorBox,
  errorMessage,
  Field,
  inputClass,
  PrimaryButton,
  SecondaryButton,
} from "../ui";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  ChevronDown,
  ChevronDownIcon,
  ChevronUpIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { EmptyState, SectionCard } from "../page-chrome";
import { MediaImageField, mediaFileUrl } from "../media/media-picker";

/**
 * The manager edits the canonical shared model (restaurant-menu.ts) — the
 * same rows, field names and ordering the POS and the waiter screen sell
 * from. No screen-local redefinitions.
 */
type MenuData = RestaurantMenuData;
type Category = RestaurantMenuCategory;
type Item = RestaurantMenuItem;
type ModifierGroup = RestaurantModifierGroup;
type Modifier = RestaurantModifier;
type ItemModifierGroupLink = RestaurantItemModifierGroup;

interface SuggestedPrice {
  materialCost: number;
  hasRecipe: boolean;
  overheadRatePercent: number | null;
  overheadSource: "ledger" | "fallback" | "none";
  loadedCost: number;
  marginPercent: number | null;
  marginSource: "item" | "default" | "none";
  suggestedPrice: number | null;
  currentPrice: number;
}

export function MenuManager({
  /**
   * Bump to reload the menu from the server. The editor fetches once on mount,
   * so a sibling flow that changes the menu — the CSV/Excel import above —
   * needs a way to make this list reflect what it just wrote.
   */
  refreshToken = 0,
}: {
  refreshToken?: number;
}) {
  const [data, setData] = useState<MenuData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const { ok, data } = await api<MenuTreePayload>("/api/menu");
      if (ok) setData(toRestaurantMenu(data));
      else setLoadFailed(true);
    } catch {
      setLoadFailed(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  async function run(
    fn: () => Promise<{ ok: boolean; data: { error?: string } }>,
  ) {
    setBusy(true);
    setError("");
    let result: { ok: boolean; data: { error?: string } };
    try {
      result = await fn();
    } catch {
      // A rejected fetch used to leave `busy` stuck on, disabling every
      // button on the screen until the page was reloaded.
      setBusy(false);
      setError("ارتباط با سرور برقرار نشد. دوباره تلاش کنید.");
      return false;
    }
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result.data.error));
      return false;
    }
    await load();
    return true;
  }

  if (!data) {
    if (loadFailed) {
      return (
        <SectionCard title="منو">
          <ErrorBox>
            بارگذاری منو ممکن نشد. اتصال را بررسی و دوباره تلاش کنید.
          </ErrorBox>
          <SecondaryButton onClick={() => void load()}>
            تلاش دوباره
          </SecondaryButton>
        </SectionCard>
      );
    }
    return <LoadingSkeleton rows={3} />;
  }

  return (
    <div className="space-y-8">
      <ErrorBox>{error}</ErrorBox>
      <CategorySection data={data} busy={busy} run={run} />
      <ItemSection data={data} busy={busy} run={run} />
      <ModifierSection data={data} busy={busy} run={run} />
    </div>
  );
}

type Runner = (
  fn: () => Promise<{ ok: boolean; data: { error?: string } }>,
) => Promise<boolean>;

function CategorySection({
  data,
  busy,
  run,
}: {
  data: MenuData;
  busy: boolean;
  run: Runner;
}) {
  const [name, setName] = useState("");
  const [taxRate, setTaxRate] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  async function add() {
    if (!name.trim()) return;
    const body: Record<string, unknown> = { name };
    // An empty box means "the business's default tax", resolved server-side —
    // the same default the setup wizard applies.
    const parsed = taxRate.trim();
    if (parsed !== "") body.taxRate = Number(parsed);
    const ok = await run(() =>
      api("/api/menu/categories", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
    if (ok) {
      setName("");
      setTaxRate("");
    }
  }

  /**
   * Swaps a category with its neighbour in the stored order. The list is
   * already sorted by (sortOrder, name); trading the two rows' values is the
   * smallest edit that makes the move durable for the POS, the waiter and
   * the offline snapshot alike.
   */
  async function move(category: Category, direction: -1 | 1) {
    const siblings = data.categories;
    const index = siblings.findIndex((c) => c.id === category.id);
    const neighbour = siblings[index + direction];
    if (!neighbour) return;
    const a = await run(() =>
      api(`/api/menu/categories/${category.id}`, {
        method: "PATCH",
        body: JSON.stringify({ sortOrder: neighbour.sortOrder }),
      }),
    );
    if (!a) return;
    await run(() =>
      api(`/api/menu/categories/${neighbour.id}`, {
        method: "PATCH",
        body: JSON.stringify({ sortOrder: category.sortOrder }),
      }),
    );
  }

  return (
    <SectionCard title="دسته‌ها">
      <form
        className="mb-4 grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <Field label="نام دسته">
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="مثلاً نوشیدنی گرم"
            required
          />
        </Field>
        <Field label="نرخ مالیات (٪)" hint="خالی = پیش‌فرض کسب‌وکار">
          <PersianNumberInput
            className={inputClass}
            dir="ltr"
            inputMode="decimal"
            value={taxRate}
            onChange={(e) => setTaxRate(e.target.value)}
            placeholder="پیش‌فرض"
          />
        </Field>
        <div className="mb-4 flex items-end">
          <SecondaryButton onClick={add} disabled={busy}>
            افزودن
          </SecondaryButton>
        </div>
      </form>
      <ul className="divide-y divide-border">
        {data.categories.map((c, index) =>
          editingId === c.id ? (
            <EditCategoryRow
              key={c.id}
              category={c}
              busy={busy}
              run={run}
              onDone={() => setEditingId(null)}
            />
          ) : (
            <li
              key={c.id}
              className="flex min-w-0 flex-col gap-2 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
            >
              <span
                className={`min-w-0 break-words ${c.isActive ? "" : "text-muted-foreground line-through"}`}
              >
                {c.name}{" "}
                <span className="text-xs text-muted-foreground">
                  (مالیات {toPersianDigits(c.taxRate)}٪)
                </span>
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex items-center">
                  <button
                    type="button"
                    aria-label={"جابه‌جایی " + c.name + " به بالا"}
                    title="جابه‌جایی به بالا"
                    disabled={busy || index === 0}
                    onClick={() => void move(c, -1)}
                    className="flex size-9 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45 disabled:opacity-40"
                  >
                    <ChevronUpIcon className="size-4" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label={"جابه‌جایی " + c.name + " به پایین"}
                    title="جابه‌جایی به پایین"
                    disabled={busy || index === data.categories.length - 1}
                    onClick={() => void move(c, 1)}
                    className="flex size-9 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45 disabled:opacity-40"
                  >
                    <ChevronDownIcon className="size-4" aria-hidden="true" />
                  </button>
                </span>
                <SecondaryButton
                  disabled={busy}
                  onClick={() => setEditingId(c.id)}
                >
                  ویرایش
                </SecondaryButton>
                <SecondaryButton
                  disabled={busy}
                  onClick={() =>
                    run(() =>
                      api(`/api/menu/categories/${c.id}`, {
                        method: "PATCH",
                        body: JSON.stringify({ isActive: !c.isActive }),
                      }),
                    )
                  }
                >
                  {c.isActive ? "غیرفعال" : "فعال"}
                </SecondaryButton>
                <SecondaryButton
                  disabled={busy}
                  onClick={() => {
                    if (
                      !window.confirm(
                        `دستهٔ «${c.name}» حذف شود؟ اگر آیتمی داشته باشد، به‌جای حذف غیرفعال می‌شود.`,
                      )
                    )
                      return;
                    void run(() =>
                      api(`/api/menu/categories/${c.id}`, { method: "DELETE" }),
                    );
                  }}
                >
                  حذف
                </SecondaryButton>
              </div>
            </li>
          ),
        )}
        {data.categories.length === 0 ? (
          <p className="text-sm text-muted-foreground">دسته‌ای ثبت نشده است.</p>
        ) : null}
      </ul>
    </SectionCard>
  );
}

function EditCategoryRow({
  category,
  busy,
  run,
  onDone,
}: {
  category: Category;
  busy: boolean;
  run: Runner;
  onDone: () => void;
}) {
  const [name, setName] = useState(category.name);
  const [taxRate, setTaxRate] = useState(String(category.taxRate));

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    const rate = taxRate.trim();
    if (
      rate !== "" &&
      (Number.isNaN(Number(rate)) || Number(rate) < 0 || Number(rate) > 100)
    ) {
      return;
    }
    // Only the fields the operator actually changed are sent, so saving a
    // rename can never reset a category-specific tax rate back to the
    // business default.
    const body: Record<string, unknown> = { name };
    if (rate !== "") body.taxRate = Number(rate);
    const ok = await run(() =>
      api(`/api/menu/categories/${category.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    );
    if (ok) onDone();
  }

  return (
    <li className="py-3">
      <form
        onSubmit={save}
        className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_auto]"
      >
        <Field label="نام دسته">
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
          />
        </Field>
        <Field label="نرخ مالیات (٪)" hint="فقط با تغییر مقدار ذخیره می‌شود">
          <PersianNumberInput
            className={inputClass}
            dir="ltr"
            inputMode="decimal"
            value={taxRate}
            onChange={(e) => setTaxRate(e.target.value)}
          />
        </Field>
        <div className="mb-4 flex items-end gap-2">
          <div className="w-full sm:w-40">
            <PrimaryButton disabled={busy}>ذخیره</PrimaryButton>
          </div>
          <SecondaryButton disabled={busy} onClick={onDone}>
            انصراف
          </SecondaryButton>
        </div>
      </form>
    </li>
  );
}

function ItemSection({
  data,
  busy,
  run,
}: {
  data: MenuData;
  busy: boolean;
  run: Runner;
}) {
  const money = useMoney();
  const [categoryId, setCategoryId] = useState("");
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [description, setDescription] = useState("");
  const [sku, setSku] = useState("");
  const [imageMediaId, setImageMediaId] = useState<string | null>(null);
  const [formError, setFormError] = useState("");
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(
    () => new Set(),
  );

  function toggleCategory(id: string) {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    // The category combobox is not a native control, so the browser's
    // `required` validation cannot cover it — and without this check an empty
    // category reached the API and came back as a generic «فیلدهای الزامی را
    // پر کنید» that named nothing.
    if (!categoryId) {
      setFormError("دستهٔ آیتم را انتخاب کنید.");
      return;
    }
    if (!name.trim()) {
      setFormError("نام آیتم را بنویسید.");
      return;
    }
    let priceRial: number;
    try {
      priceRial = money.parse(price);
    } catch {
      setFormError("قیمت معتبر نیست.");
      return;
    }
    setFormError("");
    // Everything a normal item needs travels in the same POST — an owner
    // never has to save, reopen and re-edit just to attach a photo or a code.
    const ok = await run(() =>
      api("/api/menu/items", {
        method: "POST",
        body: JSON.stringify({
          categoryId,
          name,
          price: priceRial,
          description: description.trim() || null,
          sku: sku.trim() || null,
          imageMediaId,
        }),
      }),
    );
    if (ok) {
      setName("");
      setPrice("");
      setDescription("");
      setSku("");
      setImageMediaId(null);
    }
  }

  const activeCategories = data.categories.filter((c) => c.isActive);

  // ⚡ Bolt: Extract expensive O(n) string computations (like lowercase)
  // out of the hot rendering loop. This memoizes the normalized text based on the
  // data.items array instead of per-keystroke.
  const searchableItems = useMemo(() => {
    return data.items.map((i) => {
      return {
        item: i,
        nameLower: i.name.toLowerCase(),
        skuLower: i.sku ? i.sku.toLowerCase() : "",
      };
    });
  }, [data.items]);

  // ⚡ Bolt: Filter the pre-computed strings with a fast .includes() check
  const filteredItems = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    if (!q) return data.items;
    return searchableItems
      .filter(
        (si) =>
          si.nameLower.includes(q) || (si.skuLower && si.skuLower.includes(q)),
      )
      .map((si) => si.item);
  }, [searchableItems, deferredQuery, data.items]);

  // ⚡ Bolt: Extract grouping logic into a useMemo map to prevent O(N*C) operations
  // during render. Instead of filtering the whole array for every category,
  // we group them once in O(N) and do an O(1) map lookup during render.
  const itemsByCategory = useMemo(() => {
    const map = new Map<string, Item[]>();
    for (const item of filteredItems) {
      if (!item.categoryId) continue;
      let arr = map.get(item.categoryId);
      if (!arr) {
        arr = [];
        map.set(item.categoryId, arr);
      }
      arr.push(item);
    }
    return map;
  }, [filteredItems]);

  // `menu_items.category_id` is nullable (categories delete with ON DELETE SET
  // NULL), and such rows used to disappear from this list entirely — alive in
  // the database, sellable by no screen, fixable nowhere.
  const uncategorizedItems = useMemo(
    () => filteredItems.filter((item) => !item.categoryId),
    [filteredItems],
  );

  // ⚡ Bolt: Pre-group item modifiers to avoid O(N^2) filtering inside each ItemRow
  const linksByItem = useMemo(() => {
    const map = new Map<string, ItemModifierGroupLink[]>();
    for (const link of data.itemModifierGroups) {
      let arr = map.get(link.menuItemId);
      if (!arr) {
        arr = [];
        map.set(link.menuItemId, arr);
      }
      arr.push(link);
    }
    return map;
  }, [data.itemModifierGroups]);

  const groupsById = useMemo(
    () => new Map(data.modifierGroups.map((g) => [g.id, g])),
    [data.modifierGroups],
  );

  const categoriesById = useMemo(
    () => new Map(data.categories.map((c) => [c.id, c])),
    [data.categories],
  );

  return (
    <SectionCard title="آیتم‌ها">
      <form
        onSubmit={add}
        className="mb-4 grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4"
      >
        <Field
          label="دسته"
          hint={
            activeCategories.length === 0
              ? "ابتدا در بخش «دسته‌ها» یک دستهٔ فعال بسازید."
              : undefined
          }
        >
          <SearchableSelect
            value={categoryId}
            onChange={setCategoryId}
            options={[
              { value: "", label: "دسته را انتخاب کنید…" },
              ...activeCategories.map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
        </Field>
        <Field label="نام آیتم">
          <input
            className={inputClass}
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </Field>
        <Field label={`قیمت (${money.unitLabel})`}>
          <PersianNumberInput
            className={inputClass}
            dir="ltr"
            inputMode="numeric"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            required
          />
        </Field>
        <Field label="کد کالا (اختیاری)" hint="در جستجوی صندوق قابل یافتن است">
          <input
            className={inputClass}
            dir="ltr"
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            placeholder="مثلاً ESP-1"
          />
        </Field>
        <Field label="توضیحات (اختیاری)">
          <input
            className={inputClass}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <div className="sm:col-span-2 xl:col-span-3">
          <MediaImageField
            label="تصویر آیتم"
            value={imageMediaId}
            onChange={setImageMediaId}
            disabled={busy}
          />
        </div>
        <div className="mb-4 flex items-end">
          <PrimaryButton
            disabled={busy || activeCategories.length === 0 || !categoryId}
          >
            افزودن آیتم
          </PrimaryButton>
        </div>
      </form>
      <ErrorBox>{formError}</ErrorBox>

      <div className="relative mb-4">
        <SearchIcon
          aria-hidden="true"
          className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          className={`${inputClass} ps-9 pe-9`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="جستجوی نام یا کد کالا…"
          aria-label="جستجوی آیتم"
          type="search"
        />
        {query ? (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="پاک کردن جستجو"
            title="پاک کردن جستجو"
            className="absolute end-2 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <XIcon className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {data.items.length === 0 ? (
        <EmptyState>هنوز آیتمی ثبت نشده است.</EmptyState>
      ) : filteredItems.length === 0 ? (
        <EmptyState>آیتمی با این جستجو پیدا نشد.</EmptyState>
      ) : (
        <div className="space-y-4">
          {data.categories.map((c) => {
            const items = itemsByCategory.get(c.id) ?? [];
            if (items.length === 0) return null;
            const isCollapsed = collapsedCategories.has(c.id);
            return (
              <div key={c.id}>
                <button
                  type="button"
                  onClick={() => toggleCategory(c.id)}
                  className="mb-1 flex items-center gap-1.5 text-sm font-medium text-foreground"
                  aria-expanded={!isCollapsed}
                >
                  <ChevronDown
                    className={`size-4 text-muted-foreground transition-transform ${isCollapsed ? "-rotate-90" : ""}`}
                    aria-hidden="true"
                  />
                  {c.name}
                  <span className="text-xs font-normal text-muted-foreground">
                    ({toPersianDigits(items.length)})
                  </span>
                </button>
                {isCollapsed ? null : (
                  <ul className="divide-y divide-border/80 rounded-xl border border-border/80">
                    {items.map((i) => (
                      <ItemRow
                        key={i.id}
                        item={i}
                        categories={data.categories}
                        categoriesById={categoriesById}
                        groups={data.modifierGroups}
                        groupsById={groupsById}
                        links={data.itemModifierGroups}
                        itemLinks={linksByItem.get(i.id) ?? []}
                        siblings={items}
                        busy={busy}
                        run={run}
                      />
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
          {uncategorizedItems.length > 0 ? (
            <div>
              <p className="mb-1 text-sm font-medium text-muted-foreground">
                بدون دسته
                <span className="ms-1 text-xs font-normal">
                  ({toPersianDigits(uncategorizedItems.length)})
                </span>
              </p>
              <ul className="divide-y divide-border/80 rounded-xl border border-dashed border-border">
                {uncategorizedItems.map((i) => (
                  <ItemRow
                    key={i.id}
                    item={i}
                    categories={data.categories}
                    categoriesById={categoriesById}
                    groups={data.modifierGroups}
                    groupsById={groupsById}
                    links={data.itemModifierGroups}
                    itemLinks={linksByItem.get(i.id) ?? []}
                    siblings={uncategorizedItems}
                    busy={busy}
                    run={run}
                  />
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}

function ItemRow({
  item,
  categories,
  categoriesById,
  groups,
  groupsById,
  links,
  itemLinks,
  siblings,
  busy,
  run,
}: {
  item: Item;
  categories: Category[];
  categoriesById: Map<string, Category>;
  groups: ModifierGroup[];
  groupsById: Map<string, ModifierGroup>;
  links: ItemModifierGroupLink[];
  itemLinks: ItemModifierGroupLink[];
  siblings: Item[];
  busy: boolean;
  run: Runner;
}) {
  const [editing, setEditing] = useState(false);
  const [showingModifiers, setShowingModifiers] = useState(false);
  const [showingPricing, setShowingPricing] = useState(false);
  const money = useMoney();

  // ⚡ Bolt: Replace O(N*C) render-loop filtering across all menu groups
  // with an O(1) Map lookup based on the item's pre-filtered links.
  const activeGroupNames = useMemo(() => {
    return itemLinks
      .filter((l) => l.isActive)
      .map((l) => groupsById.get(l.modifierGroupId)?.name)
      .filter((name): name is string => Boolean(name));
  }, [itemLinks, groupsById]);

  const categoryName = item.categoryId
    ? (categoriesById.get(item.categoryId)?.name ?? "—")
    : "—";

  async function move(direction: -1 | 1) {
    const index = siblings.findIndex((s) => s.id === item.id);
    const neighbour = siblings[index + direction];
    if (!neighbour) return;
    const a = await run(() =>
      api(`/api/menu/items/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ sortOrder: neighbour.sortOrder }),
      }),
    );
    if (!a) return;
    await run(() =>
      api(`/api/menu/items/${neighbour.id}`, {
        method: "PATCH",
        body: JSON.stringify({ sortOrder: item.sortOrder }),
      }),
    );
  }

  if (editing) {
    return (
      <EditItemRow
        item={item}
        categories={categories}
        busy={busy}
        run={run}
        onDone={() => setEditing(false)}
      />
    );
  }

  return (
    <li className="px-2 py-3 text-sm">
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <MenuItemImage
            mediaId={item.imageMediaId}
            alt=""
            className="size-12 shrink-0 rounded-xl"
          />
          <div className="min-w-0">
            <p
              className={`flex items-center gap-2 ${item.isActive ? "" : "text-muted-foreground"}`}
            >
              <span
                className={`truncate font-medium ${item.isActive ? "" : "line-through"}`}
              >
                {item.name}
              </span>
              {item.sku ? (
                <span
                  dir="ltr"
                  className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-mono text-muted-foreground"
                >
                  {item.sku}
                </span>
              ) : null}
            </p>
            <p className="text-xs text-muted-foreground">
              {categoryName} · {money.format(item.price)}
              {item.targetMarginPercent != null
                ? ` · حاشیهٔ سود ${toPersianDigits(item.targetMarginPercent)}٪`
                : ""}
            </p>
            {activeGroupNames.length > 0 ? (
              <p className="truncate text-xs text-muted-foreground">
                افزودنی‌ها: {activeGroupNames.join("، ")}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <span className="flex items-center">
            <button
              type="button"
              aria-label={"جابه‌جایی " + item.name + " به بالا"}
              title="جابه‌جایی به بالا"
              disabled={busy || siblings.indexOf(item) === 0}
              onClick={() => void move(-1)}
              className="flex size-9 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45 disabled:opacity-40"
            >
              <ChevronUpIcon className="size-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label={"جابه‌جایی " + item.name + " به پایین"}
              title="جابه‌جایی به پایین"
              disabled={busy || siblings.indexOf(item) === siblings.length - 1}
              onClick={() => void move(1)}
              className="flex size-9 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45 disabled:opacity-40"
            >
              <ChevronDownIcon className="size-4" aria-hidden="true" />
            </button>
          </span>
          <SecondaryButton onClick={() => setEditing(true)} disabled={busy}>
            ویرایش
          </SecondaryButton>
          <SecondaryButton
            onClick={() => setShowingModifiers((v) => !v)}
            disabled={busy}
            aria-expanded={showingModifiers}
          >
            افزودنی‌ها
          </SecondaryButton>
          <SecondaryButton
            onClick={() => setShowingPricing((v) => !v)}
            disabled={busy}
            aria-expanded={showingPricing}
          >
            قیمت پیشنهادی
          </SecondaryButton>
          <SecondaryButton
            disabled={busy}
            onClick={() =>
              run(() =>
                api(`/api/menu/items/${item.id}`, {
                  method: "PATCH",
                  body: JSON.stringify({ isActive: !item.isActive }),
                }),
              )
            }
          >
            {item.isActive ? "غیرفعال" : "فعال"}
          </SecondaryButton>
          <SecondaryButton
            disabled={busy}
            onClick={() => {
              if (!window.confirm(`آیتم «${item.name}» حذف شود؟`)) return;
              void run(() =>
                api(`/api/menu/items/${item.id}`, { method: "DELETE" }),
              );
            }}
          >
            حذف
          </SecondaryButton>
        </div>
      </div>
      {showingModifiers ? (
        <ItemModifierGroupsPanel
          item={item}
          groups={groups}
          itemLinks={itemLinks}
          busy={busy}
          run={run}
        />
      ) : null}
      {showingPricing ? (
        <PricingPanel item={item} run={run} busy={busy} />
      ) : null}
    </li>
  );
}

function EditItemRow({
  item,
  categories,
  busy,
  run,
  onDone,
}: {
  item: Item;
  categories: Category[];
  busy: boolean;
  run: Runner;
  onDone: () => void;
}) {
  const money = useMoney();
  const [categoryId, setCategoryId] = useState(item.categoryId ?? "");
  const [name, setName] = useState(item.name);
  const [price, setPrice] = useState(String(money.toInput(item.price)));
  const [description, setDescription] = useState(item.description ?? "");
  const [sku, setSku] = useState(item.sku ?? "");
  const [imageMediaId, setImageMediaId] = useState(item.imageMediaId);
  const [confirmSkuChange, setConfirmSkuChange] = useState(false);

  const skuChanged = sku.trim() !== (item.sku ?? "");

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!categoryId) return;
    if (!name.trim()) return;
    let priceRial: number;
    try {
      priceRial = money.parse(price);
    } catch {
      return;
    }
    if (skuChanged && !confirmSkuChange) return;
    // Core fields always travel together (they are all visible in this
    // form), but the photo and the SKU are only sent when they actually
    // changed — renaming an item must not silently drop its photo or
    // overwrite a code someone else fixed in another tab.
    const body: Record<string, unknown> = {
      categoryId,
      name,
      price: priceRial,
      description: description.trim() || null,
    };
    if (skuChanged) body.sku = sku.trim() || null;
    if (imageMediaId !== item.imageMediaId) body.imageMediaId = imageMediaId;
    const ok = await run(() =>
      api(`/api/menu/items/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    );
    if (ok) onDone();
  }

  return (
    <li className="border-b border-border/80 py-3">
      <form
        onSubmit={save}
        className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4"
      >
        <Field label="دسته">
          <SearchableSelect
            value={categoryId}
            onChange={setCategoryId}
            options={[
              ...categories.map((c) => ({ value: c.id, label: c.name })),
              // A category may have been deleted while this row was open; the
              // item keeps its old id (NULL in the tree) until it is re-filed.
              ...(categoryId && !categories.some((c) => c.id === categoryId)
                ? [{ value: categoryId, label: "بدون دسته" }]
                : []),
            ]}
          />
        </Field>
        <Field label="نام آیتم">
          <input
            className={inputClass}
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
          />
        </Field>
        <Field label={`قیمت (${money.unitLabel})`}>
          <PersianNumberInput
            className={inputClass}
            dir="ltr"
            inputMode="numeric"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            required
          />
        </Field>
        <Field label="کد کالا (اختیاری)">
          <input
            className={inputClass}
            dir="ltr"
            value={sku}
            onChange={(e) => setSku(e.target.value)}
          />
        </Field>
        <Field label="توضیحات">
          <input
            className={inputClass}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <div className="sm:col-span-2 xl:col-span-2">
          <MediaImageField
            label="تصویر آیتم"
            value={imageMediaId}
            onChange={setImageMediaId}
            disabled={busy}
          />
        </div>
        {skuChanged ? (
          <div className="sm:col-span-2 xl:col-span-4">
            <label className="flex items-start gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={confirmSkuChange}
                onChange={(e) => setConfirmSkuChange(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                کد کالا تغییر می‌کند؛ اگر این کد روی برگه‌های چاپی یا بارکد خوان
                استفاده شده، ثبت قبلی معتبر نخواهد بود.
              </span>
            </label>
          </div>
        ) : null}
        <div className="mb-4 flex items-end gap-2">
          <PrimaryButton disabled={busy}>ذخیره</PrimaryButton>
          <SecondaryButton disabled={busy} onClick={onDone}>
            انصراف
          </SecondaryButton>
        </div>
      </form>
    </li>
  );
}

/**
 * Per-item configuration of modifier groups: attach/detach, the effective
 * selection bounds (link override ?? group default, exactly as
 * resolveModifierSelection computes them at the counter) and the per-item
 * on/off switch from migration 0165.
 */
function ItemModifierGroupsPanel({
  item,
  groups,
  itemLinks,
  busy,
  run,
}: {
  item: Item;
  groups: ModifierGroup[];
  itemLinks: ItemModifierGroupLink[];
  busy: boolean;
  run: Runner;
}) {
  async function attach(groupId: string) {
    await run(() =>
      api("/api/menu/item-modifier-groups", {
        method: "POST",
        body: JSON.stringify({ menuItemId: item.id, modifierGroupId: groupId }),
      }),
    );
  }

  async function detach(groupId: string) {
    await run(() =>
      api(
        `/api/menu/item-modifier-groups?menuItemId=${encodeURIComponent(item.id)}&modifierGroupId=${encodeURIComponent(groupId)}`,
        { method: "DELETE" },
      ),
    );
  }

  async function patchLink(groupId: string, patch: Record<string, unknown>) {
    await run(() =>
      api("/api/menu/item-modifier-groups", {
        method: "PATCH",
        body: JSON.stringify({
          menuItemId: item.id,
          modifierGroupId: groupId,
          ...patch,
        }),
      }),
    );
  }

  return (
    <div className="mt-3 space-y-2 rounded-xl border border-border/80 bg-muted/30 p-3">
      <p className="text-xs font-medium text-muted-foreground">
        گروه‌های افزودنی این آیتم — بردار «مقدار پیش‌فرض گروه» را می‌توانید برای
        همین آیتم محدودتر کنید.
      </p>
      {groups.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          هنوز گروه افزودنی‌ای در بخش «افزودنی‌ها» نساخته‌اید.
        </p>
      ) : (
        <ul className="space-y-2">
          {groups.map((group) => {
            const link = itemLinks.find((l) => l.modifierGroupId === group.id);
            const effectiveMin = link?.minSelectOverride ?? group.minSelect;
            const effectiveMax = link?.maxSelectOverride ?? group.maxSelect;
            return (
              <ItemGroupLinkRow
                key={group.id}
                group={group}
                link={link}
                effectiveMin={effectiveMin}
                effectiveMax={effectiveMax}
                busy={busy}
                onAttach={() => void attach(group.id)}
                onDetach={() => void detach(group.id)}
                onPatch={(patch) => void patchLink(group.id, patch)}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ItemGroupLinkRow({
  group,
  link,
  effectiveMin,
  effectiveMax,
  busy,
  onAttach,
  onDetach,
  onPatch,
}: {
  group: ModifierGroup;
  link: ItemModifierGroupLink | undefined;
  effectiveMin: number;
  effectiveMax: number;
  busy: boolean;
  onAttach: () => void;
  onDetach: () => void;
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  const [minOverride, setMinOverride] = useState(
    link?.minSelectOverride === null || link?.minSelectOverride === undefined
      ? ""
      : String(link.minSelectOverride),
  );
  const [maxOverride, setMaxOverride] = useState(
    link?.maxSelectOverride === null || link?.maxSelectOverride === undefined
      ? ""
      : String(link.maxSelectOverride),
  );

  // Re-seed the inputs when the link row itself changes (detach → attach,
  // or a save that reloads the tree).
  const linkKey = link ? `${link.menuItemId}:${link.modifierGroupId}` : "none";
  const [lastLinkKey, setLastLinkKey] = useState(linkKey);
  if (lastLinkKey !== linkKey) {
    setLastLinkKey(linkKey);
    setMinOverride(
      link?.minSelectOverride === null || link?.minSelectOverride === undefined
        ? ""
        : String(link.minSelectOverride),
    );
    setMaxOverride(
      link?.maxSelectOverride === null || link?.maxSelectOverride === undefined
        ? ""
        : String(link.maxSelectOverride),
    );
  }

  function saveOverrides() {
    const patch: Record<string, unknown> = {};
    if (minOverride.trim() === "") patch.minSelectOverride = null;
    else patch.minSelectOverride = Number(minOverride);
    if (maxOverride.trim() === "") patch.maxSelectOverride = null;
    else patch.maxSelectOverride = Number(maxOverride);
    onPatch(patch);
  }

  return (
    <li className="rounded-lg border border-border/70 bg-background p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex min-w-0 items-center gap-2 text-sm">
          <input
            type="checkbox"
            aria-label={`افزودن گروه ${group.name} به این آیتم`}
            checked={Boolean(link)}
            disabled={busy}
            onChange={(event) =>
              event.target.checked ? onAttach() : onDetach()
            }
          />
          <span
            className={`truncate ${group.isActive ? "" : "text-muted-foreground"}`}
          >
            {group.name}
          </span>
          {!group.isActive ? (
            <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              گروه غیرفعال است
            </span>
          ) : null}
        </label>
        {link ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">
              پیش‌فرض گروه: {toPersianDigits(group.minSelect)}–
              {toPersianDigits(group.maxSelect)}
              {effectiveMin !== group.minSelect ||
              effectiveMax !== group.maxSelect ? (
                <>
                  {" "}
                  · مؤثر: {toPersianDigits(effectiveMin)}–
                  {toPersianDigits(effectiveMax)}
                </>
              ) : null}
            </span>
            <SecondaryButton
              disabled={busy}
              onClick={() => onPatch({ isActive: !link.isActive })}
            >
              {link.isActive ? "غیرفعال برای این آیتم" : "فعال برای این آیتم"}
            </SecondaryButton>
          </div>
        ) : null}
      </div>
      {link ? (
        <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <label className="text-xs text-muted-foreground">
            حداقل انتخاب (اختیاری)
            <PersianNumberInput
              className={`${inputClass} mt-1`}
              dir="ltr"
              inputMode="numeric"
              value={minOverride}
              onChange={(e) => setMinOverride(e.target.value)}
              placeholder={`پیش‌فرض: ${toPersianDigits(group.minSelect)}`}
              disabled={busy}
            />
          </label>
          <label className="text-xs text-muted-foreground">
            حداکثر انتخاب (اختیاری)
            <PersianNumberInput
              className={`${inputClass} mt-1`}
              dir="ltr"
              inputMode="numeric"
              value={maxOverride}
              onChange={(e) => setMaxOverride(e.target.value)}
              placeholder={`پیش‌فرض: ${toPersianDigits(group.maxSelect)}`}
              disabled={busy}
            />
          </label>
          <div className="mb-4 flex items-end">
            <SecondaryButton disabled={busy} onClick={saveOverrides}>
              ذخیرهٔ محدودیت‌ها
            </SecondaryButton>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function PricingPanel({
  item,
  busy,
  run,
}: {
  item: Item;
  busy: boolean;
  run: Runner;
}) {
  const money = useMoney();
  const [suggestion, setSuggestion] = useState<SuggestedPrice | null>(null);
  const [loading, setLoading] = useState(true);
  const [marginError, setMarginError] = useState("");
  const [marginInput, setMarginInput] = useState(
    item.targetMarginPercent != null ? String(item.targetMarginPercent) : "",
  );

  const load = useCallback(() => {
    setLoading(true);
    void api<{ suggestion: SuggestedPrice }>(
      `/api/menu/items/${item.id}/suggested-price`,
    )
      .then(({ ok, data }) => setSuggestion(ok ? data.suggestion : null))
      .catch(() => setSuggestion(null))
      .finally(() => setLoading(false));
  }, [item.id]);

  useEffect(() => {
    load();
  }, [load, item.price, item.targetMarginPercent]);

  async function saveMargin() {
    const trimmed = marginInput.trim();
    const value = trimmed === "" ? null : Number(trimmed);
    if (
      value !== null &&
      (!Number.isFinite(value) || value < 0 || value >= 100)
    ) {
      // Used to return silently, so an out-of-range margin just refused to save.
      setMarginError("حاشیه سود باید عددی بین ۰ تا ۱۰۰ باشد.");
      return;
    }
    setMarginError("");
    await run(() =>
      api(`/api/menu/items/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ targetMarginPercent: value }),
      }),
    );
  }

  async function applySuggestedPrice() {
    if (suggestion?.suggestedPrice == null) return;
    await run(() =>
      api(`/api/menu/items/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ price: suggestion.suggestedPrice }),
      }),
    );
  }

  return (
    <div className="mt-2 space-y-2 rounded-xl border border-border/80 bg-muted/60 p-3 text-xs">
      {loading ? (
        <LoadingSkeleton rows={2} compact label="در حال محاسبه قیمت پیشنهادی" />
      ) : !suggestion ? (
        <p className="text-muted-foreground">محاسبه ممکن نشد.</p>
      ) : (
        <>
          {!suggestion.hasRecipe ? (
            <p className="text-muted-foreground">
              دستورالعمل مصرف (رسپی) این آیتم ثبت نشده؛ بهای مواد قابل محاسبه
              نیست.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
              <span className="text-muted-foreground">
                بهای مواد: {money.format(suggestion.materialCost)}
              </span>
              <span className="text-muted-foreground">
                سربار:{" "}
                {suggestion.overheadRatePercent != null
                  ? `${toPersianDigits(Math.round(suggestion.overheadRatePercent))}٪ (${
                      suggestion.overheadSource === "ledger"
                        ? "بر اساس دفتر"
                        : "برآورد دستی"
                    })`
                  : "بدون داده"}
              </span>
              <span className="text-muted-foreground">
                بهای تمام‌شده: {money.format(suggestion.loadedCost)}
              </span>
              <span className="text-muted-foreground">
                حاشیه سود:{" "}
                {suggestion.marginPercent != null
                  ? `${toPersianDigits(suggestion.marginPercent)}٪ (${
                      suggestion.marginSource === "item" ? "اختصاصی" : "پیش‌فرض"
                    })`
                  : "تعیین‌نشده"}
              </span>
            </div>
          )}
          {suggestion.hasRecipe && suggestion.suggestedPrice != null ? (
            <div className="flex flex-col gap-2 rounded-xl bg-card px-2 py-1.5 sm:flex-row sm:items-center sm:justify-between">
              <span className="font-medium">
                قیمت پیشنهادی: {money.format(suggestion.suggestedPrice)}
              </span>
              <SecondaryButton disabled={busy} onClick={applySuggestedPrice}>
                اعمال قیمت
              </SecondaryButton>
            </div>
          ) : suggestion.hasRecipe ? (
            <p className="text-muted-foreground">
              برای پیشنهاد قیمت، ابتدا هدف حاشیه سود را (در تنظیمات یا برای همین
              آیتم) مشخص کنید.
            </p>
          ) : null}
        </>
      )}

      <div className="grid min-w-0 gap-2 border-t border-border/80 pt-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <Field label="حاشیه سود اختصاصی این آیتم (درصد)">
          <PersianNumberInput
            className={inputClass}
            dir="ltr"
            inputMode="decimal"
            value={marginInput}
            onChange={(e) => setMarginInput(e.target.value)}
            placeholder="پیش‌فرض"
          />
          {marginError ? (
            <span className="mt-1 block text-xs text-destructive">
              {marginError}
            </span>
          ) : null}
        </Field>
        <div className="mb-4 flex items-end">
          <SecondaryButton disabled={busy} onClick={saveMargin}>
            ذخیره
          </SecondaryButton>
        </div>
      </div>
    </div>
  );
}

function ModifierSection({
  data,
  busy,
  run,
}: {
  data: MenuData;
  busy: boolean;
  run: Runner;
}) {
  const [groupName, setGroupName] = useState("");
  const [minSelect, setMinSelect] = useState("0");
  const [maxSelect, setMaxSelect] = useState("1");
  const [formError, setFormError] = useState("");

  async function addGroup() {
    const min = Number(minSelect);
    const max = Number(maxSelect);
    if (!groupName.trim()) {
      setFormError("نام گروه را بنویسید.");
      return;
    }
    // Mirrors resolveSelectionBounds server-side. Without this, min > max was
    // sent to the API and came back as «فیلدهای الزامی را پر کنید» — the
    // fields were filled; the range was just impossible.
    if (
      !Number.isInteger(min) ||
      !Number.isInteger(max) ||
      min < 0 ||
      max < 1 ||
      min > max
    ) {
      setFormError(
        "«حداقل انتخاب» نمی‌تواند از «حداکثر انتخاب» بیشتر باشد و حداکثر باید دست‌کم ۱ باشد.",
      );
      return;
    }
    setFormError("");
    const ok = await run(() =>
      api("/api/menu/modifier-groups", {
        method: "POST",
        body: JSON.stringify({
          name: groupName,
          minSelect: min,
          maxSelect: max,
        }),
      }),
    );
    if (ok) {
      setGroupName("");
      setMinSelect("0");
      setMaxSelect("1");
    }
  }

  // ⚡ Bolt: Pre-group modifiers by group to avoid O(N^2) filtering in ModifierGroupRow
  const modifiersByGroup = useMemo(() => {
    const map = new Map<string, Modifier[]>();
    for (const modifier of data.modifiers) {
      let arr = map.get(modifier.groupId);
      if (!arr) {
        arr = [];
        map.set(modifier.groupId, arr);
      }
      arr.push(modifier);
    }
    return map;
  }, [data.modifiers]);

  return (
    <SectionCard title="گروه‌های افزودنی">
      <form
        className="mb-4 grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4"
        onSubmit={(event) => {
          event.preventDefault();
          void addGroup();
        }}
      >
        <Field label="نام گروه">
          <input
            className={inputClass}
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            placeholder="مثلاً نوع شیر"
            required
          />
        </Field>
        <Field label="حداقل انتخاب">
          <PersianNumberInput
            className={inputClass}
            dir="ltr"
            inputMode="numeric"
            value={minSelect}
            onChange={(e) => setMinSelect(e.target.value)}
          />
        </Field>
        <Field label="حداکثر انتخاب">
          <PersianNumberInput
            className={inputClass}
            dir="ltr"
            inputMode="numeric"
            value={maxSelect}
            onChange={(e) => setMaxSelect(e.target.value)}
          />
        </Field>
        <div className="mb-4 flex items-end">
          <SecondaryButton onClick={addGroup} disabled={busy}>
            افزودن گروه
          </SecondaryButton>
        </div>
      </form>
      <ErrorBox>{formError}</ErrorBox>

      <div className="space-y-4">
        {data.modifierGroups.map((g) => (
          <ModifierGroupRow
            key={g.id}
            group={g}
            groups={data.modifierGroups}
            modifiers={modifiersByGroup.get(g.id) ?? []}
            busy={busy}
            run={run}
          />
        ))}
        {data.modifierGroups.length === 0 ? (
          <p className="text-sm text-muted-foreground">گروهی ثبت نشده است.</p>
        ) : null}
      </div>
    </SectionCard>
  );
}

function ModifierGroupRow({
  group,
  groups,
  modifiers,
  busy,
  run,
}: {
  group: ModifierGroup;
  /** Every group of the branch — the edit row lets an addon be moved to any of them. */
  groups: ModifierGroup[];
  modifiers: Modifier[];
  busy: boolean;
  run: Runner;
}) {
  const money = useMoney();
  const [modifierName, setModifierName] = useState("");
  const [modifierDelta, setModifierDelta] = useState("0");
  const [addModifierError, setAddModifierError] = useState("");
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState("");
  const [editName, setEditName] = useState(group.name);
  const [editMin, setEditMin] = useState(String(group.minSelect));
  const [editMax, setEditMax] = useState(String(group.maxSelect));

  async function addModifier() {
    if (!modifierName.trim()) {
      setAddModifierError("نام افزودنی را بنویسید.");
      return;
    }
    let deltaRial: number;
    try {
      deltaRial = money.parse(modifierDelta || "0");
    } catch {
      setAddModifierError("مبلغ اضافه معتبر نیست.");
      return;
    }
    setAddModifierError("");
    const ok = await run(() =>
      api("/api/menu/modifiers", {
        method: "POST",
        body: JSON.stringify({
          groupId: group.id,
          name: modifierName,
          priceDelta: deltaRial,
        }),
      }),
    );
    if (ok) {
      setModifierName("");
      setModifierDelta("0");
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const min = Number(editMin);
    const max = Number(editMax);
    if (!editName.trim()) {
      setEditError("نام گروه را بنویسید.");
      return;
    }
    if (
      !Number.isInteger(min) ||
      !Number.isInteger(max) ||
      min < 0 ||
      max < 1 ||
      min > max
    ) {
      setEditError(
        "«حداقل انتخاب» نمی‌تواند از «حداکثر انتخاب» بیشتر باشد و حداکثر باید دست‌کم ۱ باشد.",
      );
      return;
    }
    setEditError("");
    const ok = await run(() =>
      api(`/api/menu/modifier-groups/${group.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: editName.trim(),
          minSelect: min,
          maxSelect: max,
        }),
      }),
    );
    if (ok) setEditing(false);
  }

  function removeGroup() {
    if (
      !window.confirm(
        `گروه افزودنی «${group.name}» و همهٔ افزودنی‌هایش حذف شود؟`,
      )
    )
      return;
    void run(() =>
      api(`/api/menu/modifier-groups/${group.id}`, { method: "DELETE" }),
    );
  }

  /** Swap sort_order with the neighbouring group — the POS shows this order. */
  async function moveGroup(direction: -1 | 1) {
    const index = groups.findIndex((g) => g.id === group.id);
    const neighbour = groups[index + direction];
    if (!neighbour) return;
    const first = await run(() =>
      api(`/api/menu/modifier-groups/${group.id}`, {
        method: "PATCH",
        body: JSON.stringify({ sortOrder: neighbour.sortOrder }),
      }),
    );
    if (!first) return;
    await run(() =>
      api(`/api/menu/modifier-groups/${neighbour.id}`, {
        method: "PATCH",
        body: JSON.stringify({ sortOrder: group.sortOrder }),
      }),
    );
  }

  return (
    <div className="min-w-0 rounded-xl border border-border/80 p-3">
      {editing ? (
        <form
          className="mb-2 grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3"
          onSubmit={save}
        >
          <Field label="نام گروه">
            <input
              className={inputClass}
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              required
            />
          </Field>
          <Field label="حداقل انتخاب">
            <PersianNumberInput
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={editMin}
              onChange={(e) => setEditMin(e.target.value)}
              required
            />
          </Field>
          <Field label="حداکثر انتخاب">
            <PersianNumberInput
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={editMax}
              onChange={(e) => setEditMax(e.target.value)}
              required
            />
          </Field>
          <div className="flex items-end gap-2">
            <PrimaryButton disabled={busy}>ذخیره</PrimaryButton>
            <SecondaryButton disabled={busy} onClick={() => setEditing(false)}>
              انصراف
            </SecondaryButton>
          </div>
          <div className="sm:col-span-2 xl:col-span-3">
            <ErrorBox>{editError}</ErrorBox>
          </div>
        </form>
      ) : (
        <div className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
          <p
            className={`text-sm font-medium ${group.isActive ? "" : "text-muted-foreground"}`}
          >
            <span className={group.isActive ? "" : "line-through"}>
              {group.name}
            </span>{" "}
            <span className="text-xs text-muted-foreground">
              (انتخاب {toPersianDigits(group.minSelect)} تا{" "}
              {toPersianDigits(group.maxSelect)})
            </span>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center">
              <button
                type="button"
                aria-label={"جابه‌جایی " + group.name + " به بالا"}
                title="جابه‌جایی به بالا"
                disabled={
                  busy || groups.findIndex((g) => g.id === group.id) === 0
                }
                onClick={() => void moveGroup(-1)}
                className="flex size-9 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45 disabled:opacity-40"
              >
                <ChevronUpIcon className="size-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={"جابه‌جایی " + group.name + " به پایین"}
                title="جابه‌جایی به پایین"
                disabled={
                  busy ||
                  groups.findIndex((g) => g.id === group.id) ===
                    groups.length - 1
                }
                onClick={() => void moveGroup(1)}
                className="flex size-9 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45 disabled:opacity-40"
              >
                <ChevronDownIcon className="size-4" aria-hidden="true" />
              </button>
            </span>
            <SecondaryButton
              disabled={busy}
              onClick={() => {
                setEditName(group.name);
                setEditMin(String(group.minSelect));
                setEditMax(String(group.maxSelect));
                setEditError("");
                setEditing(true);
              }}
            >
              ویرایش
            </SecondaryButton>
            <SecondaryButton
              disabled={busy}
              onClick={() =>
                run(() =>
                  api(`/api/menu/modifier-groups/${group.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ isActive: !group.isActive }),
                  }),
                )
              }
            >
              {group.isActive ? "غیرفعال" : "فعال"}
            </SecondaryButton>
            <SecondaryButton disabled={busy} onClick={removeGroup}>
              حذف
            </SecondaryButton>
          </div>
        </div>
      )}
      <ul className="mb-2 divide-y divide-border">
        {modifiers.map((m) => (
          <ModifierRow
            key={m.id}
            modifier={m}
            groups={groups}
            siblings={modifiers}
            busy={busy}
            run={run}
          />
        ))}
        {modifiers.length === 0 ? (
          <p className="py-1 text-xs text-muted-foreground">
            افزودنی‌ای ثبت نشده است.
          </p>
        ) : null}
      </ul>
      <form
        className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3"
        onSubmit={(event) => {
          event.preventDefault();
          void addModifier();
        }}
      >
        <Field label="نام افزودنی">
          <input
            className={inputClass}
            value={modifierName}
            onChange={(e) => setModifierName(e.target.value)}
            required
          />
        </Field>
        <Field label={`مبلغ اضافه (${money.unitLabel})`}>
          <PersianNumberInput
            className={inputClass}
            dir="ltr"
            inputMode="numeric"
            value={modifierDelta}
            onChange={(e) => setModifierDelta(e.target.value)}
          />
        </Field>
        <div className="mb-4 flex items-end">
          <SecondaryButton onClick={addModifier} disabled={busy}>
            افزودن
          </SecondaryButton>
        </div>
        <div className="sm:col-span-2 xl:col-span-3">
          <ErrorBox>{addModifierError}</ErrorBox>
        </div>
      </form>
    </div>
  );
}

function ModifierRow({
  modifier,
  groups,
  siblings,
  busy,
  run,
}: {
  modifier: Modifier;
  groups: ModifierGroup[];
  /** Same-group addons in display order — for the up/down reorder buttons. */
  siblings: Modifier[];
  busy: boolean;
  run: Runner;
}) {
  const money = useMoney();
  const [editing, setEditing] = useState(false);

  /** Swap sort_order with the neighbouring addon inside this group. */
  async function move(direction: -1 | 1) {
    const index = siblings.findIndex((m) => m.id === modifier.id);
    const neighbour = siblings[index + direction];
    if (!neighbour) return;
    const first = await run(() =>
      api(`/api/menu/modifiers/${modifier.id}`, {
        method: "PATCH",
        body: JSON.stringify({ sortOrder: neighbour.sortOrder }),
      }),
    );
    if (!first) return;
    await run(() =>
      api(`/api/menu/modifiers/${neighbour.id}`, {
        method: "PATCH",
        body: JSON.stringify({ sortOrder: modifier.sortOrder }),
      }),
    );
  }

  if (editing) {
    return (
      <EditModifierRow
        modifier={modifier}
        groups={groups}
        busy={busy}
        run={run}
        onDone={() => setEditing(false)}
      />
    );
  }

  return (
    <li className="flex min-w-0 flex-col gap-2 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
      <span
        className={`min-w-0 break-words ${modifier.isActive ? "" : "text-muted-foreground line-through"}`}
      >
        {modifier.name}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">
          {money.format(modifier.priceDelta)}
        </span>
        <span className="flex items-center">
          <button
            type="button"
            aria-label={"جابه‌جایی " + modifier.name + " به بالا"}
            title="جابه‌جایی به بالا"
            disabled={
              busy || siblings.findIndex((m) => m.id === modifier.id) === 0
            }
            onClick={() => void move(-1)}
            className="flex size-9 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45 disabled:opacity-40"
          >
            <ChevronUpIcon className="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={"جابه‌جایی " + modifier.name + " به پایین"}
            title="جابه‌جایی به پایین"
            disabled={
              busy ||
              siblings.findIndex((m) => m.id === modifier.id) ===
                siblings.length - 1
            }
            onClick={() => void move(1)}
            className="flex size-9 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45 disabled:opacity-40"
          >
            <ChevronDownIcon className="size-4" aria-hidden="true" />
          </button>
        </span>
        <SecondaryButton disabled={busy} onClick={() => setEditing(true)}>
          ویرایش
        </SecondaryButton>
        <SecondaryButton
          disabled={busy}
          onClick={() =>
            run(() =>
              api(`/api/menu/modifiers/${modifier.id}`, {
                method: "PATCH",
                body: JSON.stringify({ isActive: !modifier.isActive }),
              }),
            )
          }
        >
          {modifier.isActive ? "غیرفعال" : "فعال"}
        </SecondaryButton>
        <SecondaryButton
          disabled={busy}
          onClick={() => {
            if (
              !window.confirm(
                `افزودنی «${modifier.name}» حذف شود؟ افزودنی که در سفارش استفاده شده باشد غیرفعال می‌شود.`,
              )
            )
              return;
            void run(() =>
              api(`/api/menu/modifiers/${modifier.id}`, { method: "DELETE" }),
            );
          }}
        >
          حذف
        </SecondaryButton>
      </div>
    </li>
  );
}

function EditModifierRow({
  modifier,
  groups,
  busy,
  run,
  onDone,
}: {
  modifier: Modifier;
  groups: ModifierGroup[];
  busy: boolean;
  run: Runner;
  onDone: () => void;
}) {
  const money = useMoney();
  const [groupId, setGroupId] = useState(modifier.groupId);
  const [name, setName] = useState(modifier.name);
  const [delta, setDelta] = useState(
    String(money.toInput(modifier.priceDelta)),
  );
  const [formError, setFormError] = useState("");
  const moved = groupId !== modifier.groupId;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!groupId) {
      setFormError("گروه افزودنی را انتخاب کنید.");
      return;
    }
    if (!name.trim()) {
      setFormError("نام افزودنی را بنویسید.");
      return;
    }
    let deltaRial: number;
    try {
      deltaRial = money.parse(delta);
    } catch {
      setFormError("مبلغ اضافه معتبر نیست.");
      return;
    }
    setFormError("");
    const ok = await run(() =>
      api(`/api/menu/modifiers/${modifier.id}`, {
        method: "PATCH",
        body: JSON.stringify({ groupId, name, priceDelta: deltaRial }),
      }),
    );
    if (ok) onDone();
  }

  return (
    <li className="py-2">
      <form
        onSubmit={save}
        className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3"
      >
        <Field label="گروه افزودنی">
          <SearchableSelect
            value={groupId}
            onChange={setGroupId}
            options={groups.map((group) => ({
              value: group.id,
              label: group.name,
            }))}
          />
        </Field>
        <Field label="نام افزودنی">
          <input
            className={inputClass}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </Field>
        <Field label={`مبلغ اضافه (${money.unitLabel})`}>
          <PersianNumberInput
            className={inputClass}
            dir="ltr"
            inputMode="numeric"
            value={delta}
            onChange={(event) => setDelta(event.target.value)}
            required
          />
        </Field>
        <div className="flex items-end gap-2">
          <PrimaryButton disabled={busy}>ذخیره</PrimaryButton>
          <SecondaryButton onClick={onDone} disabled={busy}>
            انصراف
          </SecondaryButton>
        </div>
        <div className="sm:col-span-2 xl:col-span-3">
          <ErrorBox>{formError}</ErrorBox>
        </div>
        {moved ? (
          <p className="text-xs text-muted-foreground sm:col-span-2 xl:col-span-3">
            این افزودنی به گروه دیگری منتقل می‌شود و از این پس روی آیتم‌های همان
            گروه نمایش داده می‌شود. سفارش‌های ثبت‌شده تغییری نمی‌کنند.
          </p>
        ) : null}
      </form>
    </li>
  );
}
