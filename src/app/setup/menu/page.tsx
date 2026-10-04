"use client";

import { SetupDataSkeleton } from "../ui";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import {
  api,
  ErrorBox,
  errorMessage,
  Field,
  InfoBox,
  inputClass,
  PrimaryButton,
  SecondaryButton,
  StepShell,
} from "../ui";
import { skipToPath, stepsFor } from "../steps";
import { useSetupIndustry } from "../industry-context";

interface Category {
  id: string;
  name: string;
}
interface Item {
  id: string;
  category_id: string | null;
  name: string;
  price: string | number;
}

export default function MenuStep() {
  const router = useRouter();
  const industry = useSetupIndustry();
  const steps = useMemo(() => stepsFor(industry), [industry]);
  // The menu (menu_items/menu_categories) is an F&B-only concept -- a
  // jewelry business landing here belongs at whatever step actually
  // follows it in their flow.
  const available = steps.some((s) => s.id === "menu");
  const money = useMoney();
  const [categories, setCategories] = useState<Category[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!available) router.replace(skipToPath("menu", steps));
  }, [available, router, steps]);

  // manual entry state
  const [newCategory, setNewCategory] = useState("");
  const [itemCategory, setItemCategory] = useState("");
  const [itemName, setItemName] = useState("");
  const [itemPrice, setItemPrice] = useState("");

  // import state
  const fileRef = useRef<HTMLInputElement>(null);
  const [importSummary, setImportSummary] = useState("");
  const [importErrors, setImportErrors] = useState<string[]>([]);

  const load = useCallback(() => {
    api<{ categories: Category[]; items: Item[] }>("/api/setup/menu").then(({ data }) => {
      if (data.categories) setCategories(data.categories);
      if (data.items) setItems(data.items);
    }).finally(() => setLoaded(true));
  }, []);
  useEffect(load, [load]);

  async function addCategory() {
    if (!newCategory.trim()) return;
    setBusy(true);
    setError("");
    try {
      const { ok, data, status } = await api<{ error?: string }>("/api/setup/menu", {
        method: "POST",
        body: JSON.stringify({ addCategory: { name: newCategory } }),
      });
      if (!ok) {
        setError(errorMessage(data.error, undefined, status));
        return;
      }
      setNewCategory("");
      load();
    } finally {
      setBusy(false);
    }
  }

  async function addItem(e: React.FormEvent) {
    e.preventDefault();
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
      const { ok, data, status } = await api<{ error?: string }>("/api/setup/menu", {
        method: "POST",
        body: JSON.stringify({ addItem: { categoryId: itemCategory, name: itemName, price } }),
      });
      if (!ok) {
        setError(errorMessage(data.error, undefined, status));
        return;
      }
      setItemName("");
      setItemPrice("");
      load();
    } finally {
      setBusy(false);
    }
  }

  async function importFile(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return setError("فایلی انتخاب نشده است.");
    setBusy(true);
    setError("");
    setImportSummary("");
    setImportErrors([]);
    const form = new FormData();
    form.append("file", file);
    try {
      const { ok, data, status } = await api<{
        error?: string;
        messages?: string[];
        createdCategories?: number;
        createdItems?: number;
        updatedItems?: number;
        errors?: string[];
      }>("/api/setup/menu/import", { method: "POST", body: form });
      if (!ok) {
        setError(errorMessage(data.error, data.messages, status));
        return;
      }
      setImportSummary(
        `${toPersianDigits(data.createdCategories ?? 0)} دسته و ${toPersianDigits(
          data.createdItems ?? 0,
        )} آیتم ساخته شد` +
          (data.updatedItems ? `، ${toPersianDigits(data.updatedItems)} آیتم به‌روزرسانی شد` : "") +
          ".",
      );
      setImportErrors(data.errors ?? []);
      if (fileRef.current) fileRef.current.value = "";
      load();
    } finally {
      setBusy(false);
    }
  }

  if (!available) return null;

  if (!loaded) return <SetupDataSkeleton rows={4} />;

  return (
    <StepShell
      step="menu"
      description="منو را دستی وارد کنید یا از فایل CSV / Excel بیاورید. قیمت‌ها به تومان وارد می‌شوند."
      showNext
    >
      <ErrorBox>{error}</ErrorBox>

      <section className="mb-8 rounded-xl border border-border p-4">
        <h2 className="mb-3 font-semibold">ورود از فایل (CSV یا Excel)</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          ستون‌های لازم: «دسته»، «نام»، «قیمت» (تومان) — ستون‌های «توضیحات» و «کد» اختیاری‌اند.{" "}
          <a className="text-primary underline underline-offset-4" href="/api/setup/menu/template">
            دانلود فایل نمونه
          </a>
        </p>
        <form onSubmit={importFile} className="flex flex-wrap items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.tsv,.txt,.xlsx"
            className="text-sm file:me-3 file:rounded-lg file:border-0 file:bg-muted file:px-4 file:py-2 file:text-sm"
          />
          <PrimaryButton disabled={busy}>ورود فایل</PrimaryButton>
        </form>
        {importSummary ? <InfoBox>{importSummary}</InfoBox> : null}
        {importErrors.length > 0 ? (
          <div className="mt-3 rounded-lg bg-primary/5 p-3 text-xs text-primary">
            {importErrors.map((e, i) => (
              <p key={i}>{e}</p>
            ))}
          </div>
        ) : null}
      </section>

      <section className="mb-8 grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-border p-4">
          <h2 className="mb-3 font-semibold">افزودن دسته</h2>
          <div className="flex gap-2">
            <input
              className={inputClass}
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              placeholder="مثلاً نوشیدنی گرم"
            />
            <SecondaryButton onClick={addCategory} disabled={busy}>
              افزودن
            </SecondaryButton>
          </div>
        </div>

        <form onSubmit={addItem} className="rounded-xl border border-border p-4">
          <h2 className="mb-3 font-semibold">افزودن آیتم</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <SearchableSelect
              className={inputClass}
              value={itemCategory}
              onChange={setItemCategory}
              ariaLabel="دسته"
              options={[
                { value: "", label: "دسته…" },
                ...categories.map((c) => ({ value: c.id, label: c.name })),
              ]}
            />
            <input
              className={inputClass}
              value={itemName}
              onChange={(e) => setItemName(e.target.value)}
              placeholder="نام آیتم"
              required
            />
            <PersianNumberInput
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={itemPrice}
              onChange={(e) => setItemPrice(e.target.value)}
              placeholder={`قیمت (${money.unitLabel})`}
              required
            />
          </div>
          <div className="mt-3">
            <PrimaryButton disabled={busy || categories.length === 0}>افزودن آیتم</PrimaryButton>
          </div>
        </form>
      </section>

      <section>
        <h2 className="mb-3 font-semibold">
          منوی فعلی — {toPersianDigits(categories.length)} دسته، {toPersianDigits(items.length)} آیتم
        </h2>
        {categories.length === 0 ? (
          <p className="text-sm text-muted-foreground">هنوز چیزی ثبت نشده است.</p>
        ) : (
          <div className="space-y-4">
            {categories.map((c) => (
              <div key={c.id}>
                <p className="mb-1 text-sm font-medium text-foreground">{c.name}</p>
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {items
                    .filter((i) => i.category_id === c.id)
                    .map((i) => (
                      <li key={i.id} className="flex justify-between px-4 py-2 text-sm">
                        <span>{i.name}</span>
                        <span className="text-muted-foreground">{money.format(Number(i.price))}</span>
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
    </StepShell>
  );
}
