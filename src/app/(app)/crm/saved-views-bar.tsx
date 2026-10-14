"use client";

/**
 * Saved views — the bar above a list.
 *
 * A saved view is a name for a set of filters («سرنخ‌های داغ این هفته»), so the
 * same five filters do not have to be rebuilt every morning. The bar is the
 * whole surface: pick one, or save the filters you are looking at.
 *
 * ## What it deliberately is not
 *
 * - **It does not run the query.** Applying a view hands its filter document
 *   back to the screen, which maps it onto the query parameters it already
 *   supports. So a view can never express something the screen cannot show, and
 *   «چرا این نما اشتباه است؟» stays a question about one screen's filters.
 * - **It does not invent filter keys.** The service drops anything outside the
 *   entity's closed vocabulary, on write and again on read; the UI never sees a
 *   key it cannot honour.
 * - **It does not offer editing what is not yours.** Built-ins are the app's own
 *   views and are shown without a delete control; somebody else's private view
 *   is not in the list at all (the SQL scopes it), so there is no control whose
 *   request could only fail.
 *
 * Saving requires `crm.manage` — the same key the API requires — so the bar
 * renders read-only for a member who may use the list but not reshape it.
 */

import { useCallback, useEffect, useState } from "react";
import { BookmarkIcon, BookmarkPlusIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoadingSkeleton } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, errorMessage, Field, inputClass } from "@/app/dashboard/ui";

export interface CrmSavedView {
  id: string;
  entity: string;
  name: string;
  filters: Record<string, string>;
  ownerUserId: string | null;
  isBuiltin: boolean;
  createdBy: string;
}

export function SavedViewsBar({
  entity,
  current,
  onApply,
  canSave = false,
  onNotice,
}: {
  /** One of `SAVED_VIEW_ENTITIES`. */
  entity: string;
  /** The screen's live filters, in the entity's vocabulary. */
  current: Record<string, string>;
  /**
   * Apply a view. The screen decides how — it owns its own filter state, and
   * the mapping from a filter key to a control is its business.
   */
  onApply: (filters: Record<string, string>) => void;
  /** Whether this member may create, rename or delete views (`crm.manage`). */
  canSave?: boolean;
  onNotice?: (message: string) => void;
}) {
  const [views, setViews] = useState<CrmSavedView[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(true);

  const load = useCallback(() => {
    api<{ views: CrmSavedView[] }>(`/api/crm/saved-views?entity=${encodeURIComponent(entity)}`).then(
      ({ ok, data, aborted }) => {
        if (aborted) return;
        if (ok) {
          setViews(data.views ?? []);
          setError("");
        } else {
          setError("بارگذاری نماهای ذخیره‌شده ناموفق بود.");
        }
      },
    );
  }, [entity]);

  useEffect(load, [load]);

  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string }>("/api/crm/saved-views", {
      method: "POST",
      body: JSON.stringify({ entity, name: name.trim(), filters: current, shared }),
    });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setSaving(false);
    setName("");
    load();
    onNotice?.("نما ذخیره شد.");
  };

  const remove = async (view: CrmSavedView) => {
    if (busy) return;
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string }>(
      `/api/crm/saved-views?id=${encodeURIComponent(view.id)}`,
      { method: "DELETE" },
    );
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    if (activeId === view.id) setActiveId(null);
    load();
  };

  // Nothing saved yet and no right to save one: the bar would be an empty strip
  // with no way to fill it.
  if (views !== null && views.length === 0 && !canSave) return null;
  if (views === null && !canSave) return null;

  return (
    <div className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
          <BookmarkIcon aria-hidden="true" className="size-3.5" />
          نماها
        </span>
        {views === null ? (
          // The bar reserves the strip it will occupy: a chip row that appears
          // from nothing is a layout shift under the list's toolbar.
          <div className="min-w-40 flex-1">
            <LoadingSkeleton rows={1} compact label="در حال بارگذاری نماها" />
          </div>
        ) : (
          views.map((view) => (
            <span key={view.id} className="inline-flex items-center">
              <Button
                type="button"
                variant={activeId === view.id ? "secondary" : "outline"}
                size="sm"
                className="h-8 rounded-full"
                aria-pressed={activeId === view.id}
                onClick={() => {
                  setActiveId(view.id);
                  onApply(view.filters);
                }}
              >
                {view.name}
                {view.isBuiltin ? null : view.ownerUserId === null ? (
                  <span className="ms-1 text-[10px] text-muted-foreground">همگانی</span>
                ) : (
                  <span className="ms-1 text-[10px] text-muted-foreground">شخصی</span>
                )}
              </Button>
              {canSave && !view.isBuiltin ? (
                <button
                  type="button"
                  onClick={() => void remove(view)}
                  aria-label={`حذف نمای ${view.name}`}
                  className="-ms-1 inline-flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <XIcon aria-hidden="true" className="size-3" />
                </button>
              ) : null}
            </span>
          ))
        )}
        {canSave ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 rounded-full"
            onClick={() => setSaving(true)}
          >
            <BookmarkPlusIcon aria-hidden="true" className="size-3.5" />
            ذخیرهٔ نما
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={load}
          aria-label="بازخوانی نماها"
        >
          <RefreshCwIcon aria-hidden="true" className="size-3.5" />
        </Button>
      </div>
      <ErrorBox>{error}</ErrorBox>

      {saving ? (
        <Dialog open onOpenChange={(next) => (next ? undefined : setSaving(false))}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>ذخیرهٔ نمای فعلی</DialogTitle>
            </DialogHeader>
            <Field
              label="نام نما"
              hint="فیلترهای همین لحظهٔ صفحه ذخیره می‌شوند؛ بعداً با یک کلیک برمی‌گردند."
            >
              <input
                autoFocus
                className={inputClass}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="مثلاً سرنخ‌های داغ این هفته"
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={shared}
                onChange={(event) => setShared(event.target.checked)}
              />
              برای همهٔ اعضا قابل مشاهده باشد
            </label>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setSaving(false)} disabled={busy}>
                انصراف
              </Button>
              <Button type="button" onClick={save} disabled={busy || name.trim() === ""}>
                ذخیره
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
