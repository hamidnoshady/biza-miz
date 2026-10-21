"use client";

/**
 * «مقالات» tab — where the knowledge base's guides are written.
 *
 * Filters (search, category, status, section, tag) drive GET
 * /api/platform/knowledge/articles; the editor modal carries every field of
 * an article — title, slug (auto-suggested), category, tags, the dashboard
 * pages it teaches, video and cover URLs, ordering, status — plus the
 * markdown body with a tiny insertion toolbar and a live preview rendered by
 * the exact KbMarkdown members read (theme-aware `auto` tone), so what the
 * operator writes is what «مرکز آموزش» shows in either selected theme.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import {
  BookOpenIcon,
  EyeIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import { KNOWLEDGE_PAGES, KNOWLEDGE_SECTIONS } from "@/lib/knowledge-base";
import { suggestKbSlug } from "@/lib/knowledge";
import { formatPersianNumber } from "@/lib/digits";
import { KbMarkdown } from "@/components/knowledge/kb-markdown";
import {
  api,
  Button,
  EmptyState,
  ErrorBox,
  Field,
  InfoBox,
  SkeletonRows,
  errorMessage,
  fmtDate,
  inputClass,
  selectClass,
  useCan,
} from "../ui";
import type { ConsoleArticle, ConsoleCategory, ConsoleTag } from "./kb-types";

interface Filters {
  q: string;
  status: string;
  categoryId: string;
  section: string;
  tagId: string;
}

const EMPTY_FILTERS: Filters = {
  q: "",
  status: "",
  categoryId: "",
  section: "",
  tagId: "",
};

const PAGE_GROUPS = [...new Set(KNOWLEDGE_PAGES.map((page) => page.group))];

function assignmentLabel(key: string): string {
  return KNOWLEDGE_PAGES.find((page) => page.key === key)?.label ??
    KNOWLEDGE_SECTIONS.find((section) => section.key === key)?.label ??
    key;
}

export function ArticlesPanel({
  categories,
  tags,
  onChanged,
}: {
  categories: ConsoleCategory[] | null;
  tags: ConsoleTag[] | null;
  onChanged: () => void;
}) {
  const can = useCan();
  const canManage = can("knowledge.manage");
  const [rows, setRows] = useState<ConsoleArticle[] | null>(null);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState("");
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  // `filters.q` is the draft the operator types; `query` is the debounced
  // value the request uses. Only the latter is in the fetch effect, so one
  // keystroke produces at most one request — never the old "effect fetch +
  // separate debounced load" pair that let a stale response win.
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<ConsoleArticle | "new" | null>(null);
  const [busyId, setBusyId] = useState("");
  const requestId = useRef(0);

  useEffect(() => {
    const trimmed = filters.q.trim();
    if (!trimmed) {
      setQuery("");
      setPage(1);
      return;
    }
    const timer = setTimeout(() => {
      setQuery(trimmed);
      setPage(1);
    }, 350);
    return () => clearTimeout(timer);
  }, [filters.q]);

  useEffect(() => {
    const controller = new AbortController();
    const id = ++requestId.current;
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (filters.status) params.set("status", filters.status);
    if (filters.categoryId) params.set("category", filters.categoryId);
    if (filters.section) params.set("section", filters.section);
    if (filters.tagId) params.set("tag", filters.tagId);
    params.set("page", String(page));
    params.set("limit", "50");

    setLoading(true);
    void api<{
      articles: ConsoleArticle[];
      total: number;
      page: number;
      pageSize: number;
      totalPages: number;
      error?: string;
    }>(`/api/platform/knowledge/articles?${params.toString()}`, {
      signal: controller.signal,
    }).then(({ ok, data, aborted }) => {
      if (aborted || id !== requestId.current) return;
      setLoading(false);
      if (!ok) {
        setError(errorMessage(data.error));
        // Never leave the skeleton up forever: an error is a rendered state.
        setRows((previous) => previous ?? []);
        return;
      }
      setError("");
      setRows(data.articles);
      setTotal(data.total);
      setTotalPages(data.totalPages);
      // A filter change can leave the old page beyond the new last page.
      if (data.totalPages >= 1 && page > data.totalPages) setPage(data.totalPages);
    });
    return () => controller.abort();
  }, [query, filters.status, filters.categoryId, filters.section, filters.tagId, page, refreshKey]);

  const setFilter = (patch: Partial<Filters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
    // Free text is debounced above; every other filter applies immediately and
    // returns to the first page.
    if (typeof patch.q !== "string") setPage(1);
  };

  const categoryTitle = useMemo(() => {
    const map = new Map((categories ?? []).map((c) => [c.id, c.title]));
    return (id: string | null) => (id ? (map.get(id) ?? "—") : "بدون دسته");
  }, [categories]);

  async function remove(row: ConsoleArticle) {
    if (!window.confirm(`راهنمای «${row.title}» برای همیشه حذف شود؟`)) return;
    setBusyId(row.id);
    const { ok, data } = await api<{ error?: string }>(
      `/api/platform/knowledge/articles/${row.id}`,
      { method: "DELETE" },
    );
    setBusyId("");
    if (!ok) setError(errorMessage(data.error));
    setRefreshKey((value) => value + 1);
    onChanged();
  }

  async function quickToggleStatus(row: ConsoleArticle) {
    if (!canManage) return;
    setBusyId(row.id);
    const { ok, data } = await api<{ error?: string }>(
      `/api/platform/knowledge/articles/${row.id}`,
      {
        method: "PUT",
        body: JSON.stringify({
          slug: row.slug,
          categoryId: row.categoryId,
          sectionKeys: row.sectionKeys,
          title: row.title,
          summary: row.summary,
          bodyMd: row.bodyMd,
          videoUrl: row.videoUrl,
          coverImageUrl: row.coverImageUrl,
          status: row.status === "published" ? "draft" : "published",
          sortOrder: row.sortOrder,
          tagIds: row.tagIds,
          // The row came from the list; if another editor saved meanwhile this
          // returns 409 instead of clobbering their version.
          expectedVersion: row.version,
        }),
      },
    );
    setBusyId("");
    if (!ok) setError(errorMessage(data.error));
    setRefreshKey((value) => value + 1);
    onChanged();
  }

  return (
    <div className="mx-auto w-full max-w-6xl">
      <InfoBox>
        هر راهنما با متن (مارک‌داون)، تصویر، ویدیو و کد نوشته می‌شود؛ تیترهایش
        خودکار لنگر می‌گیرند و اعضا در مرکز آموزش جست‌وجوشان می‌کنند. راهنمای
        «منتشرشده» برای همهٔ کسب‌وکارها فعال است.
      </InfoBox>

      {error ? (
        <div className="flex flex-wrap items-center gap-2">
          <ErrorBox>{error}</ErrorBox>
          <button
            type="button"
            onClick={() => setRefreshKey((value) => value + 1)}
            className="mb-4 rounded-lg border border-border/80 px-3 py-1.5 text-xs font-medium text-foreground/80 transition-colors hover:bg-muted"
          >
            تلاش دوباره
          </button>
        </div>
      ) : null}

      {/* Filter toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            value={filters.q}
            onChange={(e) => setFilter({ q: e.target.value })}
            placeholder="جست‌وجو در عنوان و متن…"
            aria-label="جست‌وجو در عنوان و متن"
            className={`${inputClass} ps-9`}
          />
        </div>
        <select
          value={filters.status}
          onChange={(e) => setFilter({ status: e.target.value })}
          className={`${selectClass} w-auto`}
          aria-label="وضعیت"
        >
          <option value="">همهٔ وضعیت‌ها</option>
          <option value="published">منتشرشده</option>
          <option value="draft">پیش‌نویس</option>
        </select>
        <select
          value={filters.categoryId}
          onChange={(e) => setFilter({ categoryId: e.target.value })}
          className={`${selectClass} w-auto`}
          aria-label="دسته"
        >
          <option value="">همهٔ دسته‌ها</option>
          {(categories ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
        <select
          value={filters.section}
          onChange={(e) => setFilter({ section: e.target.value })}
          className={`${selectClass} w-auto`}
          aria-label="صفحهٔ راهنما"
        >
          <option value="">همهٔ صفحه‌ها</option>
          {PAGE_GROUPS.map((group) => (
            <optgroup key={group} label={group}>
              {KNOWLEDGE_PAGES.filter((page) => page.group === group).map((page) => (
                <option key={page.key} value={page.key}>{page.label}</option>
              ))}
            </optgroup>
          ))}
          <optgroup label="اتصال‌های قدیمی">
            {KNOWLEDGE_SECTIONS.map((section) => (
              <option key={section.key} value={section.key}>{section.label}</option>
            ))}
          </optgroup>
        </select>
        <select
          value={filters.tagId}
          onChange={(e) => setFilter({ tagId: e.target.value })}
          className={`${selectClass} w-auto`}
          aria-label="برچسب"
        >
          <option value="">همهٔ برچسب‌ها</option>
          {(tags ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              #{t.label}
            </option>
          ))}
        </select>
        <span className="shrink-0 text-xs text-muted-foreground" aria-live="polite">
          {rows === null ? "…" : `${formatPersianNumber(total)} راهنما`}
          {loading && rows !== null ? " — در حال به‌روزرسانی…" : ""}
        </span>
        {canManage ? (
          <Button onClick={() => setEditing("new")} className="ms-auto">
            <span className="inline-flex items-center gap-1.5">
              <PlusIcon className="size-4" aria-hidden="true" />
              راهنمای جدید
            </span>
          </Button>
        ) : null}
      </div>

      {rows === null ? (
        <SkeletonRows rows={6} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="راهنمایی پیدا نشد"
          hint="فیلترها را تغییر دهید یا یک راهنمای جدید بنویسید."
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="min-w-[860px] w-full text-sm">
            <thead className="bg-card text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-start font-medium">راهنما</th>
                <th className="px-4 py-3 text-start font-medium">دسته</th>
                <th className="px-4 py-3 text-start font-medium">صفحه‌ها</th>
                <th className="px-4 py-3 text-start font-medium">وضعیت</th>
                <th className="px-4 py-3 text-start font-medium">
                  به‌روزرسانی
                </th>
                {canManage ? (
                  <th className="px-4 py-3 text-start font-medium">عملیات</th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-border align-top">
                  <td className="max-w-[260px] px-4 py-3">
                    <p className="font-medium text-foreground">
                      {row.videoUrl ? (
                        <EyeIcon
                          className="me-1 inline size-3.5 text-muted-foreground"
                          aria-hidden="true"
                        />
                      ) : null}
                      {row.title}
                    </p>
                    <p
                      className="mt-0.5 truncate text-[11px] text-muted-foreground"
                      dir="rtl"
                    >
                      /knowledge/a/{row.slug}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {categoryTitle(row.categoryId)}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {row.sectionKeys.length
                      ? row.sectionKeys.map(assignmentLabel).join("، ")
                      : "—"}
                  </td>
                  <td className="px-4 py-3">
                    {row.status === "published" ? (
                      <span className="inline-block rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                        منتشرشده
                      </span>
                    ) : (
                      <span className="inline-block rounded-full border border-amber-500/30 bg-amber-500/15 px-2.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                        پیش‌نویس
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {fmtDate(row.updatedAt)}
                  </td>
                  {canManage ? (
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <Button
                          variant="ghost"
                          className="h-8 px-3 text-xs"
                          onClick={() => setEditing(row)}
                        >
                          <span className="inline-flex items-center gap-1.5">
                            <PencilIcon
                              className="size-3.5"
                              aria-hidden="true"
                            />
                            ویرایش
                          </span>
                        </Button>
                        <Button
                          variant="ghost"
                          className="h-8 px-3 text-xs"
                          disabled={busyId === row.id}
                          onClick={() => void quickToggleStatus(row)}
                        >
                          {row.status === "published"
                            ? "پیش‌نویس شود"
                            : "انتشار"}
                        </Button>
                        <Button
                          variant="ghost"
                          className="h-8 px-2 text-xs text-red-700 dark:text-red-300 hover:bg-red-500/10"
                          disabled={busyId === row.id}
                          onClick={() => void remove(row)}
                        >
                          <Trash2Icon className="size-3.5" aria-hidden="true" />
                        </Button>
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows !== null && rows.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            صفحهٔ {formatPersianNumber(page)} از {formatPersianNumber(totalPages)}
          </span>
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              className="h-8 px-3 text-xs"
              disabled={page <= 1 || loading}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              صفحهٔ قبل
            </Button>
            <Button
              variant="ghost"
              className="h-8 px-3 text-xs"
              disabled={page >= totalPages || loading}
              onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
            >
              صفحهٔ بعد
            </Button>
          </div>
        </div>
      ) : null}

      {editing ? (
        <ArticleEditor
          article={editing === "new" ? null : editing}
          categories={categories ?? []}
          tags={tags ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setRefreshKey((value) => value + 1);
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The editor modal
// ---------------------------------------------------------------------------

type Insert =
  | { kind: "wrap"; before: string; after: string; placeholder: string }
  | { kind: "block"; text: string };

const TOOLBAR: { label: string; title: string; insert: Insert }[] = [
  {
    label: "تیتر۲",
    title: "تیتر سطح ۲ (لنگردار)",
    insert: { kind: "block", text: "\n## تیتر جدید\n" },
  },
  {
    label: "تیتر۳",
    title: "تیتر سطح ۳",
    insert: { kind: "block", text: "\n### زیرتیتر\n" },
  },
  {
    label: "پ",
    title: "پررنگ",
    insert: {
      kind: "wrap",
      before: "**",
      after: "**",
      placeholder: "متن پررنگ",
    },
  },
  {
    label: "• لیست",
    title: "فهرست نشانه‌دار",
    insert: { kind: "block", text: "\n- مورد اول\n- مورد دوم\n" },
  },
  {
    label: "1. لیست",
    title: "فهرست شماره‌دار",
    insert: { kind: "block", text: "\n1. قدم اول\n2. قدم دوم\n" },
  },
  {
    label: "کد",
    title: "بلوک کد",
    insert: { kind: "block", text: "\n```\nکد اینجا\n```\n" },
  },
  {
    label: "تصویر",
    title: "تصویر",
    insert: {
      kind: "block",
      text: "\n![توضیح تصویر](https://example.com/image.png)\n",
    },
  },
  {
    label: "پیوند",
    title: "پیوند",
    insert: {
      kind: "wrap",
      before: "[",
      after: "](https://example.com)",
      placeholder: "متن پیوند",
    },
  },
  {
    label: "نکته",
    title: "نقل‌قول/نکته",
    insert: { kind: "block", text: "\n> نکتهٔ مهم اینجا\n" },
  },
];

function ArticleEditor({
  article,
  categories,
  tags,
  onClose,
  onSaved,
}: {
  article: ConsoleArticle | null;
  categories: ConsoleCategory[];
  tags: ConsoleTag[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(article?.title ?? "");
  const [slug, setSlug] = useState(article?.slug ?? "");
  const [summary, setSummary] = useState(article?.summary ?? "");
  const [bodyMd, setBodyMd] = useState(article?.bodyMd ?? "");
  const [categoryId, setCategoryId] = useState(article?.categoryId ?? "");
  const [sectionKeys, setSectionKeys] = useState<string[]>(
    article?.sectionKeys ?? [],
  );
  const [pageQuery, setPageQuery] = useState("");
  const visiblePages = KNOWLEDGE_PAGES.filter((page) =>
    `${page.label} ${page.route} ${page.group}`
      .toLocaleLowerCase("fa")
      .includes(pageQuery.trim().toLocaleLowerCase("fa")),
  );
  // Old section assignments still work as a fallback; preserve them when editing.
  const legacyKeys = sectionKeys.filter((key) =>
    KNOWLEDGE_SECTIONS.some((section) => section.key === key),
  );
  const [tagIds, setTagIds] = useState<string[]>(article?.tagIds ?? []);
  const [videoUrl, setVideoUrl] = useState(article?.videoUrl ?? "");
  const [coverImageUrl, setCoverImageUrl] = useState(
    article?.coverImageUrl ?? "",
  );
  const [sortOrder, setSortOrder] = useState(article?.sortOrder ?? 0);
  const [status, setStatus] = useState<"draft" | "published">(
    article?.status ?? "draft",
  );
  const [showPreview, setShowPreview] = useState(true);
  const [formError, setFormError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  // The values the editor opened with. `dirty` drives the close confirmation
  // and the beforeunload warning; the version is the optimistic-lock token.
  const baseline = useRef({
    title: article?.title ?? "",
    slug: article?.slug ?? "",
    summary: article?.summary ?? "",
    bodyMd: article?.bodyMd ?? "",
    categoryId: article?.categoryId ?? "",
    sectionKeys: (article?.sectionKeys ?? []).join("\u0000"),
    tagIds: (article?.tagIds ?? []).join("\u0000"),
    videoUrl: article?.videoUrl ?? "",
    coverImageUrl: article?.coverImageUrl ?? "",
    sortOrder: article?.sortOrder ?? 0,
    status: article?.status ?? "draft",
  });
  const dirty =
    title !== baseline.current.title ||
    slug !== baseline.current.slug ||
    summary !== baseline.current.summary ||
    bodyMd !== baseline.current.bodyMd ||
    categoryId !== baseline.current.categoryId ||
    sectionKeys.join("\u0000") !== baseline.current.sectionKeys ||
    tagIds.join("\u0000") !== baseline.current.tagIds ||
    videoUrl !== baseline.current.videoUrl ||
    coverImageUrl !== baseline.current.coverImageUrl ||
    sortOrder !== baseline.current.sortOrder ||
    status !== baseline.current.status;

  const requestClose = useCallback(() => {
    if (busy) return;
    if (dirty && !window.confirm("تغییرات ذخیره‌نشده از دست می‌رود. ویرایشگر بسته شود؟")) return;
    onClose();
  }, [busy, dirty, onClose]);

  // Escape closes (with the same unsaved-changes confirmation), and a browser
  // refresh/tab close while dirty asks first.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      requestClose();
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [dirty, requestClose]);

  const autoSlug = suggestKbSlug(title);

  function insertIntoBody(insert: Insert) {
    const el = bodyRef.current;
    if (!el) return;
    const { selectionStart: start, selectionEnd: end, value } = el;
    let next: string;
    let caret: number;
    if (insert.kind === "wrap") {
      const selected = value.slice(start, end) || insert.placeholder;
      next =
        value.slice(0, start) +
        insert.before +
        selected +
        insert.after +
        value.slice(end);
      caret =
        start + insert.before.length + selected.length + insert.after.length;
    } else {
      next = value.slice(0, start) + insert.text + value.slice(end);
      caret = start + insert.text.length;
    }
    setBodyMd(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  }

  function toggleList(list: string[], value: string): string[] {
    return list.includes(value)
      ? list.filter((v) => v !== value)
      : [...list, value];
  }

  async function save() {
    setBusy(true);
    setFormError("");
    setConflict(false);
    const payload = {
      title,
      slug: slug.trim() || autoSlug,
      summary,
      bodyMd,
      categoryId: categoryId || null,
      sectionKeys,
      tagIds,
      videoUrl,
      coverImageUrl,
      sortOrder,
      status,
      // Only on update: the version the record was loaded with. A concurrent
      // save answers 409 version_conflict instead of being overwritten.
      expectedVersion: article?.version,
    };
    const { ok, data } = await api<{ error?: string; version?: number }>(
      article
        ? `/api/platform/knowledge/articles/${article.id}`
        : "/api/platform/knowledge/articles",
      { method: article ? "PUT" : "POST", body: JSON.stringify(payload) },
    );
    setBusy(false);
    if (!ok) {
      setFormError(errorMessage(data.error));
      setConflict(data.error === "version_conflict");
      return;
    }
    onSaved();
  }

  const effectiveSlug = slug.trim() || autoSlug || "…";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-2 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={article ? `ویرایش ${article.title}` : "راهنمای جدید"}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div className="flex max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-border bg-popover">
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3.5">
          <BookOpenIcon
            className="size-5 text-sky-700 dark:text-sky-300"
            aria-hidden="true"
          />
          <h3 className="text-base font-bold text-foreground">
            {article ? `ویرایش «${article.title}»` : "راهنمای جدید"}
          </h3>
          <span className="me-auto text-[11px] text-muted-foreground" dir="ltr">
            /knowledge/a/{effectiveSlug}
          </span>
          <Button
            variant="ghost"
            className="h-8 px-3 text-xs"
            onClick={() => setShowPreview((v) => !v)}
          >
            <span className="inline-flex items-center gap-1.5">
              <EyeIcon className="size-3.5" aria-hidden="true" />
              {showPreview ? "بستن پیش‌نمایش" : "پیش‌نمایش زنده"}
            </span>
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="grid gap-4 lg:grid-cols-2">
            {/* ------------------------- left: fields ------------------------- */}
            <div>
              <Field
                label="عنوان راهنما"
                hint="تیتر اصلی صفحه؛ مثل «راهنمای کامل صندوق فروش»."
              >
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className={inputClass}
                  autoFocus={!article}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label="نامک (slug)"
                  hint={
                    autoSlug
                      ? `پیشنهاد خودکار: ${autoSlug}`
                      : "حروف کوچک انگلیسی و خط تیره."
                  }
                >
                  <input
                    type="text"
                    dir="ltr"
                    value={slug}
                    onChange={(e) => setSlug(e.target.value)}
                    placeholder={autoSlug || "pos-basics"}
                    className={inputClass}
                  />
                </Field>
                <Field label="ترتیب در دسته">
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
              </div>
              <Field
                label="خلاصه"
                hint="زیر عنوان و در کارت‌ها/جست‌وجو دیده می‌شود."
              >
                <textarea
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  rows={2}
                  maxLength={1000}
                  className={`${inputClass} h-auto py-2 leading-6`}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="دسته">
                  <select
                    value={categoryId}
                    onChange={(e) => setCategoryId(e.target.value)}
                    className={selectClass}
                  >
                    <option value="">— بدون دسته —</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.title}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="وضعیت">
                  <select
                    value={status}
                    onChange={(e) =>
                      setStatus(
                        e.target.value === "published" ? "published" : "draft",
                      )
                    }
                    className={selectClass}
                  >
                    <option value="draft">پیش‌نویس</option>
                    <option value="published">منتشرشده</option>
                  </select>
                </Field>
              </div>
              <Field
                label="آدرس ویدیو (اختیاری)"
                hint="فایل مستقیم (mp4/webm/ogg) پخش‌کننده می‌گیرد؛ صفحهٔ یوتیوب، آپارات یا ویمئو در قاب تعبیه می‌شود. لینک سایت‌های دیگر پذیرفته نیست."
              >
                <input
                  type="url"
                  dir="ltr"
                  value={videoUrl}
                  onChange={(e) => setVideoUrl(e.target.value)}
                  placeholder="https://www.aparat.com/v/…"
                  className={inputClass}
                />
              </Field>
              <Field label="آدرس تصویر کاور (اختیاری)">
                <input
                  type="url"
                  dir="ltr"
                  value={coverImageUrl}
                  onChange={(e) => setCoverImageUrl(e.target.value)}
                  placeholder="https://cdn.example.com/cover.png"
                  className={inputClass}
                />
              </Field>

              {/* A plain labelled group, not <Field>: Field wraps its children in a
                   <label>, which gave every chip the whole group text as its name (F26). */}
               <div className="mb-4" role="group" aria-labelledby="kb-sections-label">
                 <span id="kb-sections-label" className="mb-1 block text-sm font-medium text-foreground">
                   نمایش راهنما در صفحه‌ها
                 </span>
                 <span className="mb-2 block text-xs text-muted-foreground">
                   از صفحه‌هایی که دکمهٔ «آموزش» دارند انتخاب کنید. یک راهنما می‌تواند چند مقصد داشته باشد.
                 </span>
                 <input
                   type="search"
                   value={pageQuery}
                   onChange={(e) => setPageQuery(e.target.value)}
                   className={`${inputClass} mb-2`}
                   placeholder="جست‌وجوی نام یا مسیر صفحه…"
                   aria-label="جست‌وجوی صفحه‌های دارای آموزش"
                 />
                 <div className="max-h-52 space-y-3 overflow-y-auto rounded-lg border border-border p-2">
                   {PAGE_GROUPS.map((group) => {
                     const pages = visiblePages.filter((page) => page.group === group);
                     if (!pages.length) return null;
                     return (
                       <div key={group}>
                         <p className="mb-1 text-xs font-semibold text-foreground/70">{group}</p>
                         <div className="flex flex-wrap gap-1.5">
                           {pages.map((page) => {
                             const on = sectionKeys.includes(page.key);
                             return (
                               <button
                                 key={page.key}
                                 type="button"
                                 aria-pressed={on}
                                 aria-label={`${page.label} — ${page.route}`}
                                 title={page.route}
                                 onClick={() => setSectionKeys((prev) => toggleList(prev, page.key))}
                                 className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                                   on
                                     ? "border-sky-400/50 bg-sky-500/20 text-sky-800 dark:text-sky-200"
                                     : "border-border bg-muted text-muted-foreground hover:text-foreground"
                                 }`}
                               >
                                 {page.label}
                               </button>
                             );
                           })}
                         </div>
                       </div>
                     );
                   })}
                   {visiblePages.length === 0 ? (
                     <p className="text-xs text-muted-foreground">صفحه‌ای با این عبارت پیدا نشد.</p>
                   ) : null}
                 </div>
                 <p className="mt-1.5 text-xs text-muted-foreground">
                   {sectionKeys.filter((key) => KNOWLEDGE_PAGES.some((page) => page.key === key)).length} صفحه انتخاب شده
                 </p>
                 {legacyKeys.length > 0 ? (
                   <div className="mt-2 rounded-lg border border-dashed border-border p-2">
                     <p className="mb-2 text-xs text-muted-foreground">
                       اتصال‌های قدیمی حفظ شده‌اند؛ در صورت نیاز برای حذف روی آن‌ها بزنید:
                     </p>
                     <div className="flex flex-wrap gap-1.5">
                       {legacyKeys.map((key) => (
                         <button
                           key={key}
                           type="button"
                           aria-pressed="true"
                           onClick={() => setSectionKeys((prev) => prev.filter((value) => value !== key))}
                           className="rounded-full border border-amber-400/40 bg-amber-500/10 px-2.5 py-1 text-xs text-foreground"
                         >
                           {assignmentLabel(key)} ×
                         </button>
                       ))}
                     </div>
                   </div>
                 ) : null}
               </div>

              <Field label="برچسب‌ها">
                <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto rounded-lg border border-border p-2">
                  {tags.length === 0 ? (
                    <span className="text-xs text-muted-foreground">
                      اول از برگهٔ «برچسب‌ها» بسازید.
                    </span>
                  ) : (
                    tags.map((t) => {
                      const on = tagIds.includes(t.id);
                      return (
                        <button
                          key={t.id}
                          type="button"
                          aria-pressed={on}
                          onClick={() =>
                            setTagIds((prev) => toggleList(prev, t.id))
                          }
                          className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                            on
                              ? "border-emerald-400/50 bg-emerald-500/20 text-emerald-800 dark:text-emerald-200"
                              : "border-border bg-muted text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          #{t.label}
                        </button>
                      );
                    })
                  )}
                </div>
              </Field>
            </div>

            {/* ------------------ right: body editor + preview ----------------- */}
            <div className="flex min-h-0 flex-col">
              <div className="mb-1 flex flex-wrap items-center gap-1">
                {TOOLBAR.map((btn) => (
                  <button
                    key={btn.label}
                    type="button"
                    title={btn.title}
                    onClick={() => insertIntoBody(btn.insert)}
                    className="rounded-lg border border-border bg-muted px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {btn.label}
                  </button>
                ))}
              </div>
              <textarea
                ref={bodyRef}
                value={bodyMd}
                onChange={(e) => setBodyMd(e.target.value)}
                rows={18}
                spellCheck={false}
                placeholder={
                  "## شروع\nمتن راهنما به فارسی…\n\n```sql\nSELECT 1;\n```"
                }
                className="min-h-[320px] w-full flex-1 rounded-lg border border-border bg-muted p-3 font-mono text-[13px] leading-6 text-foreground outline-none placeholder:text-muted-foreground focus:border-sky-400/60 focus:ring-2 focus:ring-sky-400/20"
                aria-label="متن راهنما (مارک‌داون)"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                مارک‌داون: ## تیترها لنگر می‌گیرند؛ ``` بلوک کد؛ ![توضیح](آدرس)
                تصویر.
              </p>
            </div>
          </div>

          {showPreview ? (
            <div className="mt-5 rounded-xl border border-border bg-muted p-5">
              <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                پیش‌نمایش زنده — همان چیزی که عضو می‌بیند
              </p>
              <h4 className="mb-1 text-lg font-bold text-foreground">
                {title || "بدون عنوان"}
              </h4>
              {summary ? (
                <p className="mb-4 text-sm text-muted-foreground">{summary}</p>
              ) : null}
              <KbMarkdown content={bodyMd || "(بدنه خالی است)"} />
            </div>
          ) : null}

          {formError ? (
            <div className="mt-4 space-y-2">
              <ErrorBox>{formError}</ErrorBox>
              {conflict ? (
                <button
                  type="button"
                  onClick={onSaved}
                  className="rounded-lg border border-border/80 px-3 py-1.5 text-xs font-medium text-foreground/80 transition-colors hover:bg-muted"
                >
                  بستن و بارگذاری نسخهٔ تازه
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
          <Button variant="ghost" onClick={requestClose} disabled={busy}>
            انصراف
          </Button>
          <Button onClick={() => void save()} disabled={busy || !title.trim()}>
            {busy
              ? "در حال ذخیره…"
              : article
                ? "ذخیره تغییرات"
                : "ایجاد راهنما"}
          </Button>
        </div>
      </div>
    </div>
  );
}
