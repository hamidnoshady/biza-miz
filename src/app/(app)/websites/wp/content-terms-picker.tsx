"use client";

/**
 * The categories and tags a post belongs to (issue #1215, P2‑5).
 *
 * The rules this keeps, in the owner's interest:
 *
 *  - **Only terms the site already has are offered** — the app cannot create a
 *    tag on a site it cannot reach, and creating one silently in REST mode
 *    would be a second write nobody asked for. A new tag is made in WordPress.
 *  - **A post's current terms stay visible even when the list does not carry
 *    them**: the plugin reports the most-used terms, so a post's own rare tag
 *    would otherwise vanish from the screen it is meant to describe. Such terms
 *    are shown by id and can still be removed.
 *  - **Nothing here saves.** The selection is part of the editor's draft and
 *    travels with its ordinary save.
 */
import { useMemo, useState } from "react";
import { TagsIcon } from "lucide-react";
import { InfoBox, inputClass } from "@/app/dashboard/ui";
import { LoadingSkeleton } from "@/app/dashboard/page-chrome";
import { toPersianDigits } from "@/lib/digits";
import { cn } from "@/lib/utils";
import type { WpEditorTaxonomies } from "./content-editor-state";
import { toggleTermId } from "./content-editor-state";
import { MAX_PICKER_TERMS, type WpTermOption } from "@/lib/wp-content-taxonomies";

/** How many checkboxes one list draws before the search narrows it. */
const VISIBLE_TERMS = 30;

export interface ContentTermsPickerProps {
  categories: WpTermOption[];
  tags: WpTermOption[];
  selected: WpEditorTaxonomies;
  loading: boolean;
  /** Plugin mode, and the plugin never reported a term list. */
  unsupported: boolean;
  /** One of the two taxonomies could not be read (REST mode). */
  partial: boolean;
  disabled: boolean;
  onChange: (next: WpEditorTaxonomies) => void;
}

function matches(term: WpTermOption, query: string): boolean {
  return !query || term.name.toLocaleLowerCase("fa").includes(query);
}

export function ContentTermsPicker({
  categories,
  tags,
  selected,
  loading,
  unsupported,
  partial,
  disabled,
  onChange,
}: ContentTermsPickerProps) {
  const [categoryQuery, setCategoryQuery] = useState("");
  const [tagQuery, setTagQuery] = useState("");

  const visibleCategories = useMemo(() => {
    const query = categoryQuery.trim().toLocaleLowerCase("fa");
    return categories.filter((term) => matches(term, query)).slice(0, VISIBLE_TERMS);
  }, [categories, categoryQuery]);

  const visibleTags = useMemo(() => {
    const query = tagQuery.trim().toLocaleLowerCase("fa");
    return tags.filter((term) => matches(term, query)).slice(0, VISIBLE_TERMS);
  }, [tags, tagQuery]);

  const knownCategoryIds = useMemo(() => new Set(categories.map((term) => term.id)), [categories]);
  const knownTagIds = useMemo(() => new Set(tags.map((term) => term.id)), [tags]);
  // Selected but not listed — the post's own rare terms, kept removable.
  const unknownCategories = selected.categories.filter((id) => !knownCategoryIds.has(id));
  const unknownTags = selected.tags.filter((id) => !knownTagIds.has(id));

  function toggle(kind: "categories" | "tags", id: number) {
    onChange({ ...selected, [kind]: toggleTermId(selected[kind], id) });
  }

  function renderList(
    kind: "categories" | "tags",
    terms: WpTermOption[],
    unknown: number[],
    selectedIds: number[],
    query: string,
    setQuery: (value: string) => void,
    label: string,
  ) {
    return (
      <fieldset className="min-w-0" disabled={disabled}>
        <legend className="mb-1 text-xs text-muted-foreground">
          {label} — {toPersianDigits(selectedIds.length)} انتخاب‌شده
        </legend>
        {terms.length > VISIBLE_TERMS ? (
          <input
            className={cn(inputClass, "mb-2 h-8 text-xs")}
            placeholder={`جستجو در ${label}`}
            aria-label={`جستجوی ${label}`}
            value={query}
            disabled={disabled}
            onChange={(event) => setQuery(event.target.value)}
          />
        ) : null}
        <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-border/70 bg-card p-2">
          {terms.length === 0 ? (
            <p className="px-1 py-2 text-[11px] text-muted-foreground">
              {query ? "موردی با این جستجو پیدا نشد." : `این سایت هنوز ${label} ندارد.`}
            </p>
          ) : (
            terms.map((term) => (
              <label key={term.id} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  className="size-3.5"
                  checked={selectedIds.includes(term.id)}
                  disabled={disabled}
                  onChange={() => toggle(kind, term.id)}
                />
                <span className="min-w-0 break-words">{term.name}</span>
                {term.count > 0 ? (
                  // The count is a hint, not part of the checkbox's name.
                  <span aria-hidden="true" className="ms-auto shrink-0 text-[10px] text-muted-foreground">
                    {toPersianDigits(term.count)}
                  </span>
                ) : null}
              </label>
            ))
          )}
          {unknown.length > 0 ? (
            <p className="mt-1 border-t border-border/60 pt-1 text-[11px] leading-5 text-muted-foreground">
              {toPersianDigits(unknown.length)} مورد از {label} این نوشته در فهرست سایت نیست
              {unknown.length ? ` (${unknown.map((id) => `#${toPersianDigits(id)}`).join("، ")})` : ""}؛ حذف‌کردن آن‌ها
              ممکن است، تغییر نامشان در وردپرس.
            </p>
          ) : null}
        </div>
      </fieldset>
    );
  }

  return (
    <section className="mb-4 rounded-xl border border-border/70 bg-muted/40 p-3" aria-label="دسته‌ها و برچسب‌ها">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <TagsIcon aria-hidden="true" className="size-4 text-primary" />
        <span className="text-sm font-medium">دسته‌ها و برچسب‌ها</span>
        <span className="text-[11px] text-muted-foreground">فقط از میان موارد موجود در سایت</span>
      </div>

      {loading ? (
        // A skeleton reserves the two columns instead of a lone sentence; the
        // label is what a screen reader announces.
        <LoadingSkeleton rows={2} compact label="در حال خواندن دسته‌ها و برچسب‌های سایت" />
      ) : unsupported ? (
        <InfoBox>
          افزونهٔ این سایت فهرست دسته‌ها و برچسب‌ها را گزارش نمی‌کند. دسته‌بندی این نوشته را در پیشخوان وردپرس تغییر دهید یا
          افزونه را به‌روزرسانی کنید.
        </InfoBox>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {renderList(
            "categories",
            visibleCategories,
            unknownCategories,
            selected.categories,
            categoryQuery,
            setCategoryQuery,
            "دسته‌ها",
          )}
          {renderList("tags", visibleTags, unknownTags, selected.tags, tagQuery, setTagQuery, "برچسب‌ها")}
        </div>
      )}

      <p className="mt-2 text-[11px] text-muted-foreground">
        {partial
          ? "بخشی از فهرست خوانده نشد؛ موارد انتخابی فعلی حفظ می‌شوند. "
          : ""}
        حداکثر {toPersianDigits(MAX_PICKER_TERMS)} مورد از هر دسته‌بندی نمایش داده می‌شود.
      </p>
    </section>
  );
}
