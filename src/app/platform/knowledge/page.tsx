"use client";

/**
 * The knowledge base console — where the super-admin team authors everything
 * «مرکز آموزش» shows.
 *
 * Three tabs, one capability (`knowledge.manage` for writes; any admin reads):
 *
 *  - «مقالات»      the guides themselves: markdown body with live preview,
 *                  video/cover, sections-taught, tags, publish state
 *                  (migration 0131);
 *  - «دسته‌بندی‌ها» the category builder — the nested side-menu tree members
 *                  browse by;
 *  - «برچسب‌ها»    cross-cutting tags for filtering;
 * The article editor itself selects pages that have an «آموزش» button.
 * Legacy external links remain readable for backward compatibility.
 *
 * Categories and tags are fetched once here and handed to the articles panel
 * so its selects and chips never re-read them per row.
 */
import { useCallback, useEffect, useState } from "react";
import {
  BookOpenIcon,
  FolderTreeIcon,
  NewspaperIcon,
  TagIcon,
  RouteIcon,
} from "lucide-react";
import { api, useCan } from "../ui";
import { ArticlesPanel } from "./kb-articles-panel";
import { CategoriesPanel } from "./kb-categories-panel";
import { TagsPanel } from "./kb-tags-panel";
import { TourStudioPanel } from "./tour-studio-panel";
import type { ConsoleCategory, ConsoleTag } from "./kb-types";

type Tab = "articles" | "categories" | "tags" | "tours";

const TABS: { key: Tab; label: string; icon: typeof NewspaperIcon }[] = [
  { key: "articles", label: "مقالات", icon: NewspaperIcon },
  { key: "categories", label: "دسته‌بندی‌ها", icon: FolderTreeIcon },
  { key: "tags", label: "برچسب‌ها", icon: TagIcon },
  { key: "tours", label: "تورهای تعاملی", icon: RouteIcon },
];

export default function KnowledgePage() {
  const can = useCan();
  const canManage = can("knowledge.manage");
  const [tab, setTab] = useState<Tab>("articles");
  const [categories, setCategories] = useState<ConsoleCategory[] | null>(null);
  const [tags, setTags] = useState<ConsoleTag[] | null>(null);

  const loadTaxonomy = useCallback(async () => {
    const [cats, tgs] = await Promise.all([
      api<{ categories: ConsoleCategory[] }>("/api/platform/knowledge/categories"),
      api<{ tags: ConsoleTag[] }>("/api/platform/knowledge/tags"),
    ]);
    if (cats.ok) setCategories(cats.data.categories);
    if (tgs.ok) setTags(tgs.data.tags);
  }, []);

  useEffect(() => {
    void loadTaxonomy();
  }, [loadTaxonomy]);

  return (
    <div className="mx-auto w-full max-w-7xl">
      <div className="mb-5 flex items-start gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-sky-500/15 text-sky-700 dark:text-sky-300">
          <BookOpenIcon className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h1 className="text-xl font-bold">پایگاه دانش</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            محتوای «مرکز آموزش» را اینجا بسازید: مقاله، دسته، برچسب و تور تعاملی.
            صفحه‌های مقصد هر راهنما را در همان فرم ایجاد یا ویرایش مقاله انتخاب کنید.
            {canManage ? "" : " (فقط مشاهده — تغییر در اختیار مهندس و مدیر ارشد است.)"}
          </p>
        </div>
      </div>

      <nav aria-label="بخش‌های پایگاه دانش" className="mb-5 flex gap-1 overflow-x-auto rounded-xl border border-border bg-card p-1">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              setTab(key);
              // Back to the article manager? Re-read the taxonomy so its
              // selects reflect edits made in the other two tabs just now.
              if (key === "articles") void loadTaxonomy();
            }}
            aria-current={tab === key ? "page" : undefined}
            className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3.5 py-2 text-sm font-medium transition-colors ${
              tab === key
                ? "bg-sky-500/15 text-sky-700 dark:text-sky-300"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            <Icon className="size-4" aria-hidden="true" />
            {label}
          </button>
        ))}
      </nav>

      {tab === "articles" ? (
        <ArticlesPanel categories={categories} tags={tags} onChanged={loadTaxonomy} />
      ) : tab === "categories" ? (
        <CategoriesPanel />
      ) : tab === "tags" ? (
        <TagsPanel />
      ) : (
        <TourStudioPanel />
      )
    </div>
  );
}
