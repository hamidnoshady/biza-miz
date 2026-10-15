"use client";

/**
 * «تخصیص گروهی ابعاد» — bulk dimension assignment on unposted drafts
 * (issue #868). Selection → dry-run preview → explicit confirmation:
 *
 *   * only the drafts on screen can be picked, and only unposted drafts exist
 *     here at all (a posted draft no longer has a row to select);
 *   * a kind left untouched is never written; «پاک کردن» sends an explicit
 *     null, which is the only way this panel clears anything;
 *   * «پیش‌نمایش» is the server's own dry-run — the exact changed lines,
 *     before → after — and «تأیید» stays disabled until the preview matches
 *     what is on screen (no executing a preview of something else);
 *   * a draft approved while this panel was open answers 409
 *     draft_approval_race, told in plain words, with nothing written.
 */
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ErrorBox, SecondaryButton, api } from "@/app/dashboard/ui";
import {
  DIMENSION_KINDS,
  type DimensionKind,
  type LineDimensions,
} from "@/lib/accounting-dimensions";
import { DimensionFields, useDimensionCatalog } from "./dimension-fields";
import type { DimensionCatalog, DimensionDraft } from "./dimension-catalog";

interface BulkAssignLineChange {
  lineId: string;
  lineNo: number;
  before: Record<string, string | null>;
  after: Record<string, string | null>;
}

interface BulkAssignResult {
  dryRun: boolean;
  mode: "fill_blank" | "overwrite";
  matchedDrafts: number;
  changedLines: BulkAssignLineChange[];
  unchangedLines: number;
}

export function DraftBulkAssignPanel({
  drafts,
  onChanged,
}: {
  drafts: readonly { id: string; memo: string }[];
  /** The queue's own reload — a run changes lines the list is showing. */
  onChanged: () => void;
}) {
  const { catalog, error: catalogError, retry: retryCatalog } = useDimensionCatalog();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [draft, setDraft] = useState<DimensionDraft>({});
  const [clearKinds, setClearKinds] = useState<ReadonlySet<DimensionKind>>(new Set());
  const [mode, setMode] = useState<"fill_blank" | "overwrite">("fill_blank");
  const [preview, setPreview] = useState<BulkAssignResult | null>(null);
  const [previewSignature, setPreviewSignature] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const payload = useMemo<LineDimensions | null>(() => {
    const out: Record<string, string | null> = {};
    for (const kind of DIMENSION_KINDS) {
      if (clearKinds.has(kind)) out[kind] = null;
      else if (draft[kind]) out[kind] = draft[kind] as string;
    }
    return Object.keys(out).length > 0 ? (out as LineDimensions) : null;
  }, [draft, clearKinds]);

  const signature = useMemo(
    () => JSON.stringify({ ids: [...selected].sort(), payload, mode }),
    [selected, payload, mode],
  );
  const previewIsCurrent = preview !== null && previewSignature === signature;

  function toggle(id: string): void {
    setPreview(null);
    setDone("");
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll(): void {
    setPreview(null);
    setDone("");
    setSelected((prev) => (prev.size === drafts.length ? new Set() : new Set(drafts.map((d) => d.id))));
  }

  async function run(dryRun: boolean): Promise<void> {
    if (!payload || selected.size === 0) return;
    setBusy(true);
    setError("");
    setDone("");
    const { ok, data } = await api<Record<string, unknown> & { error?: string }>(
      "/api/ledger/dimensions/bulk-assign",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draftIds: [...selected], dimensions: payload, mode, dryRun }),
      },
    );
    setBusy(false);
    if (!ok) {
      setPreview(null);
      const code = typeof data.error === "string" ? data.error : "";
      if (code === "draft_approval_race") {
        setError("یکی از اسناد انتخاب‌شده همین حالا تأیید شد؛ فهرست به‌روز شد. دوباره انتخاب کنید.");
        onChanged();
        return;
      }
      if (code === "dimension_inactive" || code === "dimension_not_found" || code === "dimension_kind_disabled") {
        setError("یکی از مقادیر انتخاب‌شده قابل انتساب نیست (بایگانی‌شده، متعلق به این کسب‌وکار نیست، یا نوعش غیرفعال است).");
        return;
      }
      setError("تخصیص گروهی انجام نشد.");
      return;
    }
    const result = data as unknown as BulkAssignResult;
    if (dryRun) {
      setPreview(result);
      setPreviewSignature(signature);
      return;
    }
    setPreview(null);
    setDone(`تخصیص روی ${result.changedLines.length} ردیف ثبت شد.`);
    setSelected(new Set());
    onChanged();
  }

  const canRun = !busy && selected.size > 0 && payload !== null;

  return (
    <section aria-label="تخصیص گروهی ابعاد" className="mt-4 rounded-xl border border-border/80 p-3">
      <h3 className="text-sm font-semibold text-foreground">تخصیص گروهی ابعاد به پیش‌نویس‌ها</h3>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        فقط پیش‌نویس‌های انتخاب‌شده تغییر می‌کنند؛ اسناد ثبت‌شده هرگز دست نمی‌خورند. مقدارهای انتخاب‌نشده دست نمی‌خورند و
        «پاک کردن» تنها راه حذف است.
      </p>

      <div className="mt-3">
        <SecondaryButton type="button" onClick={toggleAll} disabled={busy || drafts.length === 0}>
          {selected.size === drafts.length ? "لغو انتخاب همه" : "انتخاب همه"}
        </SecondaryButton>
        <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-lg border border-border/60 p-2">
          {drafts.map((d) => (
            <li key={d.id}>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.has(d.id)}
                  onChange={() => toggle(d.id)}
                  disabled={busy}
                  aria-label={`انتخاب پیش‌نویس ${d.memo}`}
                />
                <span className="truncate">پیش‌نویس «{d.memo}»</span>
              </label>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div>
          <span className="mb-1.5 block text-sm font-medium text-foreground">مقدارهایی که ثبت شوند</span>
          <DimensionFields
            idPrefix="bulk-assign-dims"
            catalog={catalog}
            locationId={null}
            value={draft}
            onChange={(next) => {
              setPreview(null);
              setDone("");
              setDraft(next);
            }}
            disabled={busy}
          />
          <div className="mt-2 flex flex-wrap gap-3">
            {DIMENSION_KINDS.filter((kind) => draft[kind] || clearKinds.has(kind)).map((kind) => (
              <label key={kind} className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={clearKinds.has(kind)}
                  disabled={busy}
                  onChange={() => {
                    setPreview(null);
                    setDone("");
                    setClearKinds((prev) => {
                      const next = new Set(prev);
                      if (next.has(kind)) next.delete(kind);
                      else next.add(kind);
                      return next;
                    });
                  }}
                />
                پاک کردن این بُعد
              </label>
            ))}
          </div>
        </div>

        <fieldset className="rounded-lg border border-border/60 p-3">
          <legend className="px-1 text-sm font-medium text-foreground">شیوهٔ تخصیص</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="bulk-assign-mode"
              checked={mode === "fill_blank"}
              disabled={busy}
              onChange={() => {
                setPreview(null);
                setMode("fill_blank");
              }}
            />
            فقط ردیف‌های خالی (بدون بازنویسی)
          </label>
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="bulk-assign-mode"
              checked={mode === "overwrite"}
              disabled={busy}
              onChange={() => {
                setPreview(null);
                setMode("overwrite");
              }}
            />
            بازنویسی مقادیر موجود
          </label>
        </fieldset>
      </div>

      {catalogError ? (
        <p role="alert" className="mt-3 rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          فهرست ابعاد بارگذاری نشد.{" "}
          <button type="button" className="underline" onClick={retryCatalog}>
            تلاش دوباره
          </button>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {done ? (
        <p role="status" aria-live="polite" className="mt-3 rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-500/15 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
          {done}
        </p>
      ) : null}

      {preview ? (
        <div className="mt-3 rounded-lg border border-border/60 p-3">
          <p className="text-sm text-foreground">
            {preview.changedLines.length === 0
              ? "هیچ ردیفی تغییر نمی‌کند."
              : `${preview.changedLines.length} ردیف تغییر می‌کند (${preview.unchangedLines} ردیف از قبل درست است).`}
          </p>
          {preview.changedLines.length > 0 ? (
            <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-xs">
              {preview.changedLines.slice(0, 20).map((line) => (
                <li key={line.lineId} className="flex flex-wrap gap-2">
                  <span className="text-muted-foreground">ردیف {line.lineNo}:</span>
                  <span>{summarize(line.before, catalog)}</span>
                  <span aria-hidden>←</span>
                  <span>{summarize(line.after, catalog)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={() => void run(true)} disabled={!canRun}>
          {busy ? "در حال بررسی…" : "پیش‌نمایش تغییرات"}
        </Button>
        <Button type="button" onClick={() => void run(false)} disabled={!canRun || !previewIsCurrent}>
          {busy ? "در حال ثبت…" : "تأیید و اعمال"}
        </Button>
      </div>
    </section>
  );
}

function summarize(dimensions: Record<string, string | null> | undefined, catalog: DimensionCatalog | null): string {
  const parts = DIMENSION_KINDS.filter((kind) => dimensions?.[kind]).map((kind) => {
    const value = catalog?.allValues.find((v) => v.id === dimensions![kind]);
    return value ? `${value.code} · ${value.name}` : String(dimensions![kind]).slice(0, 8);
  });
  return parts.length > 0 ? parts.join("، ") : "بدون بُعد";
}
