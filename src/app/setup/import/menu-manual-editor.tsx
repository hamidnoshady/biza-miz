"use client";

/**
 * #1580: The restaurant's *manual* menu editor, embedded in the existing
 * optional first-run Data Import step. File imports use that step's canonical
 * Data Transfer ImportSection; this component never parses/uploads a second
 * CSV file or creates another import engine.
 *
 * Mutations still use the existing F&B-only /api/setup/menu handlers and their
 * tenant, branch and settings permission checks.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import { api, ErrorBox, errorMessage, inputClass, PrimaryButton, SecondaryButton, SetupDataSkeleton } from "../ui";

interface MenuCategory { id: string; name: string }
interface MenuItem {
  id: string;
  category_id: string | null;
  name: string;
  price: string | number;
}

export function SetupMenuManualEditor() {
  const money = useMoney();
  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [items, setItems] = useState<MenuItem[]>([]);
  const [categoryName, setCategoryName] = useState("");
  const [itemCategory, setItemCategory] = useState("");
  const [itemName, setItemName] = useState("");
  const [itemPrice, setItemPrice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const result = await api<{ categories?: MenuCategory[]; items?: MenuItem[]; error?: string }>("/api/setup/menu");
    if (result.ok) {
      setCategories(result.data.categories ?? []);
      setItems(result.data.items ?? []);
      setError("");
    } else {
      setError(errorMessage(result.data?.error, undefined, result.status));
    }
    setLoaded(true);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function addCategory() {
    if (!categoryName.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ error?: string }>("/api/setup/menu", {
        method: "POST",
        body: JSON.stringify({ addCategory: { name: categoryName.trim() } }),
      });
      if (!result.ok) {
        setError(errorMessage(result.data?.error, undefined, result.status));
        return;
      }
      setCategoryName("");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function addItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      let price: number;
      try {
        price = money.parse(itemPrice);
      } catch {
        setError("قیمت معتبر نیست.");
        return;
      }
      const result = await api<{ error?: string }>("/api/setup/menu", {
        method: "POST",
        body: JSON.stringify({
          addItem: { categoryId: itemCategory, name: itemName.trim(), price },
        }),
      });
      if (!result.ok) {
        setError(errorMessage(result.data?.error, undefined, result.status));
        return;
      }
      setItemName("");
      setItemPrice("");
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <SetupDataSkeleton rows={3} />;

  return (
    <section className="space-y-5" aria-label="ثبت دستی منوی کافه و رستوران">
      <div className="space-y-1">
        <h3 className="font-semibold text-foreground">منوی غذا و نوشیدنی</h3>
        <p className="text-xs leading-6 text-muted-foreground">
          دسته و آیتم‌های قابل فروش را همین‌جا بسازید. برای ورود تعداد زیادی
          آیتم از فایل، گزینهٔ «فایل» در همین مرحله و موتور ورود و خروج داده را انتخاب کنید.
          ثبت منو اختیاری است؛ برای شروع فروش باید دست‌کم یک آیتم فعال داشته باشید.
        </p>
      </div>
      <ErrorBox>{error}</ErrorBox>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-border p-4">
          <h4 className="mb-3 font-medium">افزودن دسته</h4>
          <div className="flex flex-wrap gap-2">
            <input
              className={inputClass}
              value={categoryName}
              onChange={(e) => setCategoryName(e.target.value)}
              placeholder="مثلاً نوشیدنی گرم"
              aria-label="نام دستهٔ منو"
            />
            <SecondaryButton onClick={addCategory} disabled={busy || !categoryName.trim()}>
              افزودن
            </SecondaryButton>
          </div>
        </div>
        <form onSubmit={addItem} className="rounded-xl border border-border p-4">
          <h4 className="mb-3 font-medium">افزودن آیتم</h4>
          <div className="grid gap-3 sm:grid-cols-3">
            <SearchableSelect
              className={inputClass}
              value={itemCategory}
              onChange={setItemCategory}
              ariaLabel="دستهٔ منو"
              options={[
                { value: "", label: "انتخاب دسته…" },
                ...categories.map((category) => ({ value: category.id, label: category.name })),
              ]}
            />
            <input
              className={inputClass}
              value={itemName}
              onChange={(e) => setItemName(e.target.value)}
              placeholder="نام آیتم"
              aria-label="نام آیتم منو"
              required
            />
            <PersianNumberInput
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={itemPrice}
              onChange={(e) => setItemPrice(e.target.value)}
              placeholder={`قیمت (${money.unitLabel})`}
              aria-label="قیمت آیتم"
              required
            />
          </div>
          <div className="mt-3">
            <PrimaryButton disabled={busy || categories.length === 0 || !itemCategory}>
              افزودن آیتم
            </PrimaryButton>
          </div>
        </form>
      </div>
      <div>
        <h4 className="mb-3 font-medium">
          منوی فعلی — {toPersianDigits(categories.length)} دسته، {toPersianDigits(items.length)} آیتم
        </h4>
        {categories.length === 0 ? (
          <p className="text-sm text-muted-foreground">هنوز آیتمی ثبت نشده است.</p>
        ) : (
          <div className="space-y-3">
            {categories.map((category) => (
              <div key={category.id}>
                <p className="mb-1 text-sm font-medium text-foreground">{category.name}</p>
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {items.filter((item) => item.category_id === category.id).map((item) => (
                    <li key={item.id} className="flex justify-between gap-3 px-4 py-2 text-sm">
                      <span>{item.name}</span>
                      <span className="text-muted-foreground">{money.format(Number(item.price))}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
