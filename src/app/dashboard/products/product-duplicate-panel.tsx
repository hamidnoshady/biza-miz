"use client";

/**
 * Issue #1207 §C — «بررسی محصول تکراری»: the safe compare/reconcile flow.
 *
 * The screen shows what the owner needs before anything is touched: every row
 * that carries the SKU (id, branch, kind and parent, on-hand quantity, creation
 * time in Shamsi, the store mapping that owns it, and the last product payload
 * the store sent), why the candidate is ambiguous, and the two decisions that
 * exist:
 *
 *  - «نگهداری جداگانه» — an audited "these are different rows": no write to
 *    `items`, no merge, nothing to undo. True for different products, branches,
 *    sources, stores and variant families, which is why a shared SKU alone is
 *    never a merge key;
 *  - «بایگانی نسخهٔ تکراری» — offered only for the row the server's plan calls a
 *    proven creation-race twin with no referencing record. Archive means
 *    `is_active = false` (reversible, audited), never delete, and the two stock
 *    snapshots are never added together.
 *
 * A blocked candidate shows its blockers and keeps the archive button away.
 * Both decisions require an explicit confirmation and echo the review token the
 * screen loaded, so a plan that changed meanwhile is refused rather than acted
 * on.
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, ErrorBox } from "../ui";
import { LoadingSkeleton, StatusBadge } from "../page-chrome";
import { formatQuantity, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import {
  DUPLICATE_VERDICT_COPY,
  ORPHAN_BLOCKER_COPY,
  SHARED_SKU_IS_NOT_A_MERGE_KEY,
  referenceTableLabel,
} from "@/lib/duplicate-items-copy";
import type { DuplicateReviewGroup } from "@/lib/duplicate-items-review-service";
import type { DuplicateReportMember } from "@/lib/duplicate-items-report";

type PendingDecision = { kind: "keep_separate" } | { kind: "archive_orphan"; orphanItemId: string };

const KIND_LABEL: Record<string, string> = {
  simple: "محصول ساده",
  variant_parent: "محصول اصلی (خانواده)",
  variant_child: "تنوع",
};

function shamsi(iso: string): string {
  return formatJalali(iso, { withTime: true, timeZone: "Asia/Tehran" });
}

export function ProductDuplicatePanel({
  sku,
  onDecision,
}: {
  /** The SKU the row carries; the server decides whether it is a duplicate. */
  sku: string;
  /** Fired after a decision lands, so the list and its link badges refresh. */
  onDecision: () => void;
}) {
  const [groups, setGroups] = useState<DuplicateReviewGroup[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [pending, setPending] = useState<PendingDecision | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    if (!sku) {
      // A row with no SKU cannot be in a duplicate group; asking the endpoint
      // without one would return the whole catalogue's candidates.
      setGroups([]);
      return;
    }
    setLoadError("");
    const result = await api<{ groups?: DuplicateReviewGroup[]; error?: string }>(
      `/api/products/duplicates?sku=${encodeURIComponent(sku)}`,
    );
    if (!result.ok) {
      setGroups([]);
      setLoadError(
        result.data.error === "forbidden"
          ? "برای دیدن و مدیریت ردیف‌های تکراری، دسترسی کالا و اتصال‌ها لازم است."
          : "بررسی ردیف‌های تکراری ممکن نشد؛ اتصال را بررسی کنید.",
      );
      return;
    }
    setGroups(Array.isArray(result.data.groups) ? result.data.groups : []);
  }, [sku]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(group: DuplicateReviewGroup, decision: PendingDecision) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    const result = await api<{ error?: string }>("/api/products/duplicates", {
      method: "POST",
      body: JSON.stringify({
        sku: group.sku,
        action: decision.kind,
        confirm: true,
        reviewToken: group.reviewToken,
        ...(decision.kind === "archive_orphan" ? { orphanItemId: decision.orphanItemId } : {}),
      }),
    });
    setBusy(false);
    setPending(null);
    if (!result.ok) {
      // A changed plan is a fresh question, not a retry: reload it.
      if (result.data.error === "duplicate_review_changed") void load();
      setError(
        result.data.error === "duplicate_review_changed"
          ? "شواهد این بررسی تغییر کرده است؛ فهرست دوباره خوانده شد. پیش از تأیید، یک بار دیگر بازبینی کنید."
          : result.data.error === "duplicate_not_safe_to_archive"
            ? "بایگانی خودکار برای این ردیف مجاز نیست؛ رکوردی به آن ارجاع می‌دهد و تصمیم با شماست."
            : "تصمیم ثبت نشد؛ دسترسی و وضعیت اتصال را بررسی کنید.",
      );
      return;
    }
    setNotice(
      decision.kind === "keep_separate"
        ? "این ردیف‌ها جدا نگه داشته شدند و به‌عنوان تصمیم بازبینی‌شده ثبت شد."
        : "نسخهٔ تکراری بایگانی شد. ردیف و سابقهٔ آن باقی است و در صورت نیاز قابل بازگردانی است.",
    );
    onDecision();
    void load();
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="text-sm font-semibold text-amber-950 dark:text-amber-200">بررسی محصول تکراری</p>
        <p dir="ltr" className="text-xs text-muted-foreground">
          {sku}
        </p>
      </div>
      <p className="text-xs text-muted-foreground">{SHARED_SKU_IS_NOT_A_MERGE_KEY}</p>

      {groups === null ? (
        <LoadingSkeleton rows={3} label="در حال خواندن ردیف‌های هم‌کد" />
      ) : loadError ? (
        <div className="space-y-2">
          <ErrorBox>{loadError}</ErrorBox>
          <Button type="button" variant="outline" size="sm" className="min-h-9" onClick={() => void load()}>
            تلاش دوباره
          </Button>
        </div>
      ) : groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">برای این کد کالا ردیف تکراری‌ای پیدا نشد.</p>
      ) : (
        groups.map((group) => (
          <section key={group.sku} className="space-y-3 rounded-xl border border-border/80 bg-card p-3 sm:p-4">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone={group.needsAction ? "danger" : "neutral"}>
                {DUPLICATE_VERDICT_COPY[group.verdict].label}
              </StatusBadge>
              <span className="text-xs text-muted-foreground">
                {toPersianDigits(group.members.length)} ردیف با این کد کالا
              </span>
              {group.reviewed ? <StatusBadge tone="positive">بازبینی‌شده</StatusBadge> : null}
            </div>
            <p className="text-xs text-muted-foreground">{DUPLICATE_VERDICT_COPY[group.verdict].action}</p>

            {group.notes.length > 0 ? (
              <ul className="list-disc space-y-1 pe-5 text-xs text-muted-foreground">
                {group.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            ) : null}

            <div className="grid min-w-0 gap-2 sm:grid-cols-2">
              {group.members.map((member) => (
                <MemberCard
                  key={member.itemId}
                  member={member}
                  archived={group.plan?.orphanItemId === member.itemId}
                  kept={group.plan?.twinItemId === member.itemId}
                />
              ))}
            </div>

            {group.plan && group.plan.blockers.length > 0 ? (
              <div className="rounded-lg border border-dashed border-rose-300 p-2.5 text-xs dark:border-rose-500/40">
                <p className="font-medium text-rose-600 dark:text-rose-400">
                  بایگانی خودکار مجاز نیست؛ این ردیف‌ها دست شماست:
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pe-4 text-muted-foreground">
                  {group.plan.blockers.map((blocker) => (
                    <li key={blocker}>{ORPHAN_BLOCKER_COPY[blocker]}</li>
                  ))}
                  {group.plan.references.map((reference) => (
                    <li key={`${reference.table}.${reference.column}`}>
                      {referenceTableLabel(reference.table)}: {toPersianDigits(reference.count)} رکورد
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {pending === null ? (
              <div className="flex flex-wrap gap-2">
                {group.plan?.status === "archive" ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-9 text-xs"
                    disabled={busy}
                    onClick={() => {
                      setError("");
                      setNotice("");
                      setPending({ kind: "archive_orphan", orphanItemId: group.plan!.orphanItemId });
                    }}
                  >
                    بایگانی نسخهٔ تکراری
                  </Button>
                ) : null}
                {group.plan?.status === "already_archived" ? (
                  <p className="text-xs text-muted-foreground">نسخهٔ تکراری پیش‌تر بایگانی شده است.</p>
                ) : null}
                {group.needsAction ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-9 text-xs"
                    disabled={busy}
                    onClick={() => {
                      setError("");
                      setNotice("");
                      setPending({ kind: "keep_separate" });
                    }}
                  >
                    نگهداری جداگانه
                  </Button>
                ) : null}
              </div>
            ) : (
              <div className="space-y-2 rounded-lg border border-amber-200/70 bg-amber-50/60 p-2.5 text-xs dark:border-amber-500/25 dark:bg-amber-500/10">
                <p className="font-medium text-amber-950 dark:text-amber-200">
                  {pending.kind === "keep_separate"
                    ? "این ردیف‌ها به‌عنوان دو محصول جدا ثبت می‌شوند."
                    : "نسخهٔ تکراری بایگانی می‌شود (حذف نمی‌شود)."}
                </p>
                <p className="text-muted-foreground">
                  {pending.kind === "keep_separate"
                    ? "هیچ ردیفی تغییر نمی‌کند؛ فقط تصمیم شما ثبت و در گزارش بازبینی باقی می‌ماند."
                    : "ردیف، موجودی و سابقهٔ آن حفظ می‌شود، پیوند فروشگاه جابه‌جا نمی‌شود و دو موجودی با هم جمع نمی‌شوند. این کار در گزارش رویدادها ثبت و قابل بازگردانی است."}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    className="min-h-9 text-xs"
                    disabled={busy}
                    onClick={() => void submit(group, pending)}
                  >
                    {busy ? "در حال ثبت…" : "تأیید"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="min-h-9 text-xs"
                    disabled={busy}
                    onClick={() => setPending(null)}
                  >
                    انصراف
                  </Button>
                </div>
              </div>
            )}

            {group.separateReasons.length > 0 && group.needsAction ? (
              <p className="text-[11px] text-muted-foreground">
                تفاوت‌هایی که «نگهداری جداگانه» را توجیه می‌کند: {group.separateReasons.join("، ")}
              </p>
            ) : null}
          </section>
        ))
      )}

      <ErrorBox>{error}</ErrorBox>
      {notice ? (
        <p role="status" className="text-xs text-emerald-700 dark:text-emerald-400">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

/** One row of the comparison — evidence, never an action. */
function MemberCard({
  member,
  archived,
  kept,
}: {
  member: DuplicateReportMember;
  /** The plan proposes archiving this row. */
  archived: boolean;
  /** The plan keeps this row as the surviving twin. */
  kept: boolean;
}) {
  return (
    <div className="min-w-0 space-y-1 rounded-lg border border-border/80 bg-muted/40 p-2.5 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="min-w-0 truncate font-medium text-foreground">{member.name}</span>
        {!member.isActive ? <StatusBadge tone="neutral">بایگانی‌شده</StatusBadge> : null}
        {archived ? <StatusBadge tone="danger">پیشنهاد بایگانی</StatusBadge> : null}
        {kept ? <StatusBadge tone="positive">ردیف نگه‌داشته‌شده</StatusBadge> : null}
      </div>
      <p className="text-muted-foreground">
        {KIND_LABEL[member.kind] ?? member.kind}
        {member.parentItemId ? " · تنوع یک خانواده" : ""}
      </p>
      <p className="text-muted-foreground">
        شعبه: {member.locationName} · موجودی: {member.quantity == null ? "—" : formatQuantity(member.quantity)}
      </p>
      <p className="text-muted-foreground">ایجاد: {shamsi(member.createdAt)}</p>
      <p className="break-all text-muted-foreground">
        منبع: {member.provenance || "بدون پیوند"}
      </p>
      {member.snapshots.map((snapshot) => (
        <p key={`${snapshot.connectionId}:${snapshot.remoteId}`} className="text-muted-foreground">
          آخرین دریافت از فروشگاه: {shamsi(snapshot.receivedAt)} · موجودی اعلامی فروشگاه:{" "}
          {snapshot.stockQuantity == null ? "—" : toPersianDigits(snapshot.stockQuantity)}
        </p>
      ))}
      <p dir="ltr" className="break-all text-[10px] text-muted-foreground">
        {member.itemId}
      </p>
    </div>
  );
}
