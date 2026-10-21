"use client";

/**
 * «دسته‌بندی‌ها» tab — the category builder.
 *
 * The member side menu's tree is authored here: nested categories (parent),
 * order (sort_order), an emoji/icon, an accent tone, and an on/off switch
 * that hides a branch from members without touching its articles. The tree
 * is nested with the exact buildKbCategoryTree the member side uses, so what
 * the operator sees is what members get.
 *
 * Deleting is refused server-side while children or articles remain — the
 * 409 codes surface as the panel's own messages via errorMessage.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import {
  ChevronDownIcon,
  FolderPlusIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import { buildKbCategoryTree, suggestKbSlug, type KbCategoryNode } from "@/lib/knowledge";
import {
  api,
  Button,
  EmptyState,
  ErrorBox,
  Field,
  InfoBox,
  SkeletonRows,
  errorMessage,
  inputClass,
  selectClass,
  useCan,
} from "../ui";
import type { ConsoleCategory } from "./kb-types";

const TONES: { value: string; label: string }[] = [
  { value: "", label: "خنثی" },
  { value: "amber", label: "کهربایی" },
  { value: "emerald", label: "سبز" },
  { value: "sky", label: "آبی" },
  { value: "rose", label: "رز" },
  { value: "violet", label: "بنفش" },
];

type Editing =
  | { mode: "create"; category: null }
  | { mode: "edit"; category: ConsoleCategory };

export function CategoriesPanel() {
  const can = useCan();
  const canManage = can("knowledge.manage");
  const [rows, setRows] = useState<ConsoleCategory[] | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busyId, setBusyId] = useState("");

  const load = useCallback(async () => {
    const { ok, data } = await api<{ categories: ConsoleCategory[]; error?: string }>(
      "/api/platform/knowledge/categories",
    );
    if (ok) {
      setRows(data.categories);
      setError("");
    } else {
      setError(errorMessage(data.error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const tree = useMemo(
    () =>
      buildKbCategoryTree(
        (rows ?? []).map((r) => ({
          id: r.id,
          parentId: r.parentId,
          slug: r.slug,
          title: r.title,
          description: r.description,
          icon: r.icon,
          tone: r.tone,
          sortOrder: r.sortOrder,
        })),
      ),
    [rows],
  );

  const byId = useMemo(() => new Map((rows ?? []).map((r) => [r.id, r])), [rows]);

  async function toggleActive(row: ConsoleCategory) {
    if (!canManage || busyId) return;
    setBusyId(row.id);
    setError("");
    const { ok, data } = await api<{ error?: string }>(
      `/api/platform/knowledge/categories/${row.id}`,
      {
        method: "PUT",
        body: JSON.stringify({ ...row, isActive: !row.isActive }),
      },
    );
    setBusyId("");
    if (!ok) {
      // A refused toggle (a stale row, a cycle from another tab) must say so
      // instead of quietly reloading as if nothing happened.
      setError(errorMessage(data.error));
      return;
    }
    void load();
  }

  async function remove(row: ConsoleCategory) {
    if (busyId) return;
    if (!window.confirm(`دستهٔ «${row.title}» حذف شود؟`)) return;
    setBusyId(row.id);
    const { ok, data } = await api<{ error?: string }>(
      `/api/platform/knowledge/categories/${row.id}`,
      { method: "DELETE" },
    );
    setBusyId("");
    if (!ok) {
      // `category_has_children` / `category_has_articles` are actionable, not a
      // generic failure: the row stays exactly where it was.
      setError(errorMessage(data.error));
      return;
    }
    void load();
  }

  function renderNode(node: KbCategoryNode, depth: number) {
    const row = byId.get(node.id);
    if (!row) return null;
    return (
      <li key={node.id}>
        <div
          className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-3 py-2"
          style={{ marginInlineStart: `${depth * 22}px` }}
        >
          <span className="text-lg" aria-hidden="true">
            {row.icon || "📁"}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground">
              {row.title}
              {!row.isActive ? (
                <span className="ms-2 rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                  غیرفعال
                </span>
              ) : null}
            </p>
            <p className="text-[11px] text-muted-foreground" dir="ltr">
              {row.slug}
            </p>
          </div>
          <span className="text-[11px] text-muted-foreground">
            {row.articleCount} راهنما · ترتیب {row.sortOrder}
          </span>
          {canManage ? (
            <div className="flex items-center gap-1.5">
              <Button
                variant="ghost"
                className="h-8 px-2.5 text-xs"
                disabled={Boolean(busyId)}
                onClick={() => void toggleActive(row)}
              >
                {row.isActive ? "غیرفعال" : "فعال"}
              </Button>
              <Button
                variant="ghost"
                className="h-8 px-2.5 text-xs"
                onClick={() => setEditing({ mode: "edit", category: row })}
              >
                <span className="inline-flex items-center gap-1">
                  <PencilIcon className="size-3.5" aria-hidden="true" />
                  ویرایش
                </span>
              </Button>
              <Button
                variant="ghost"
                className="h-8 px-2.5 text-xs text-red-700 dark:text-red-300 hover:bg-red-500/10"
                disabled={Boolean(busyId)}
                onClick={() => void remove(row)}
              >
                <Trash2Icon className="size-3.5" aria-hidden="true" />
              </Button>
            </div>
          ) : null}
        </div>
        {node.children.length > 0 ? (
          <ul className="mt-1.5 space-y-1.5">
            {node.children.map((child) => renderNode(child, depth + 1))}
          </ul>
        ) : null}
      </li>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl">
      <InfoBox>
        {canManage
          ? "دسته‌ها درختِ فهرست کناری مرکز آموزش را می‌سازند؛ زیردسته، ترتیب، آیکن و رنگ هرکدام همین‌جاست. حذف فقط وقتی ممکن است که دسته نه زیردسته داشته باشد نه راهنما."
          : "ساخت دسته و تغییر آن در اختیار مهندس و مدیر ارشد است؛ شما فقط فهرست را می‌بینید."}
      </InfoBox>

      {rows === null ? null : <ErrorBox>{error}</ErrorBox>}

      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <ChevronDownIcon className="size-4 rotate-0 text-muted-foreground" aria-hidden="true" />
          درخت دسته‌بندی
        </h2>
        {canManage ? (
          <Button onClick={() => setEditing({ mode: "create", category: null })}>
            <span className="inline-flex items-center gap-1.5">
              <FolderPlusIcon className="size-4" aria-hidden="true" />
              دستهٔ جدید
            </span>
          </Button>
        ) : null}
      </div>

      {rows === null ? (
        error ? (
          <div
            role="alert"
            className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-5"
          >
            <p className="text-sm font-semibold text-foreground">فهرست دسته‌ها بارگذاری نشد</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{error}</p>
            <Button className="mt-3" variant="ghost" onClick={() => void load()}>
              تلاش دوباره
            </Button>
          </div>
        ) : (
          <SkeletonRows rows={5} />
        )
      ) : tree.length === 0 ? (
        <EmptyState
          title="هنوز دسته‌ای ساخته نشده"
          hint="با «دستهٔ جدید» شروع کنید؛ مثلاً «شروع کار» یا «فروش و سفارش»."
        />
      ) : (
        <ul className="space-y-1.5">{tree.map((node) => renderNode(node, 0))}</ul>
      )}

      {editing ? (
        <CategoryEditor
          editing={editing}
          all={rows ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

function CategoryEditor({
  editing,
  all,
  onClose,
  onSaved,
}: {
  editing: Editing;
  all: ConsoleCategory[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const cat = editing.category;
  const [title, setTitle] = useState(cat?.title ?? "");
  const [slug, setSlug] = useState(cat?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(Boolean(cat));
  const [description, setDescription] = useState(cat?.description ?? "");
  const [icon, setIcon] = useState(cat?.icon ?? "");
  const [tone, setTone] = useState(cat?.tone ?? "");
  const [parentId, setParentId] = useState(cat?.parentId ?? "");
  const [sortOrder, setSortOrder] = useState(cat?.sortOrder ?? 0);
  const [isActive, setIsActive] = useState(cat?.isActive ?? true);
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);

  // A category cannot parent itself (or a descendant of itself).
  const descendantIds = useMemo(() => {
    if (!cat) return new Set<string>([ "" ]);
    const childrenOf = new Map<string | null, ConsoleCategory[]>();
    for (const c of all) {
      const list = childrenOf.get(c.parentId) ?? [];
      list.push(c);
      childrenOf.set(c.parentId, list);
    }
    const out = new Set<string>([cat.id]);
    const walk = (id: string) => {
      for (const child of childrenOf.get(id) ?? []) {
        out.add(child.id);
        walk(child.id);
      }
    };
    walk(cat.id);
    return out;
  }, [cat, all]);

  const effectiveSlug = slug || (slugTouched ? "" : suggestKbSlug(title));

  async function save() {
    const finalSlug = slug.trim() || suggestKbSlug(title);
    setBusy(true);
    setFormError("");
    const payload = {
      title,
      slug: finalSlug,
      description,
      icon,
      tone,
      parentId: parentId || null,
      sortOrder,
      isActive,
    };
    const { ok, data } = await api<{ error?: string }>(
      cat ? `/api/platform/knowledge/categories/${cat.id}` : "/api/platform/knowledge/categories",
      { method: cat ? "PUT" : "POST", body: JSON.stringify(payload) },
    );
    setBusy(false);
    if (!ok) {
      setFormError(errorMessage(data.error));
      return;
    }
    onSaved();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4"
      role="dialog"
      aria-modal="true"
      aria-label={cat ? `ویرایش دسته ${cat.title}` : "دستهٔ جدید"}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-border bg-popover p-5">
        <h3 className="text-base font-bold text-foreground">
          {cat ? `ویرایش دستهٔ «${cat.title}»` : "دستهٔ جدید"}
        </h3>

        <div className="mt-5">
          <Field label="عنوان دسته" hint="در منوی کناری مرکز آموزش دیده می‌شود.">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className={inputClass}
              autoFocus
            />
          </Field>
          <Field
            label="نامک (slug)"
            hint="در آدرس راهنماها می‌آید؛ حروف کوچک انگلیسی و خط تیره. خالی بگذارید تا خودکار ساخته شود."
          >
            <input
              type="text"
              dir="ltr"
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                setSlugTouched(true);
              }}
              placeholder={suggestKbSlug(title) || "getting-started"}
              className={inputClass}
            />
          </Field>
          <Field label="توضیح کوتاه">
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={inputClass}
              maxLength={1000}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="آیکن (ایموجی)" hint="مثلاً 🚀 یا 📦">
              <input
                type="text"
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                className={inputClass}
                maxLength={40}
              />
            </Field>
            <Field label="رنگ تأکید">
              <select value={tone} onChange={(e) => setTone(e.target.value)} className={selectClass}>
                {TONES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="دستهٔ والد" hint="برای زیردسته‌سازی؛ خالی یعنی دستهٔ اصلی.">
            <select
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
              className={selectClass}
            >
              <option value="">— دستهٔ اصلی —</option>
              {all
                .filter((c) => !descendantIds.has(c.id))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="ترتیب نمایش" hint="عدد کوچک‌تر، بالاتر در فهرست.">
            <PersianNumberInput
              inputMode="numeric"
              allowDecimal={false}
              allowNegative={false}
              dir="ltr"
              value={sortOrder}
              onChange={(e) => setSortOrder(Number(e.target.value) || 0)}
              className={inputClass}
            />
          </Field>
          <label className="mb-4 flex cursor-pointer items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="size-4 accent-sky-500"
            />
            این دسته در مرکز آموزش دیده شود
          </label>

          {formError ? <ErrorBox>{formError}</ErrorBox> : null}

          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              انصراف
            </Button>
            <Button onClick={() => void save()} disabled={busy || !title.trim()}>
              {busy ? "در حال ذخیره…" : "ذخیره"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
