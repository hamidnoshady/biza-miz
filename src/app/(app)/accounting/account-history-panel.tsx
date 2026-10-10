"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { auditActionLabel } from "@/lib/audit";
import { api, ErrorBox } from "@/app/dashboard/ui";
import { Button } from "@/components/ui/button";
import { overlayPanelClass } from "@/app/dashboard/page-chrome";
import { OverlayDialog } from "./ledger-ui";

interface HistoryEntry {
  id: number;
  actorName: string | null;
  action: string;
  createdAt: string;
  payload:
    | ({
        code?: string;
        name?: string;
        type?: string;
        parentId?: string | null;
        parentLabel?: string | null;
        level?: string;
        isContra?: boolean;
        before?: unknown;
        after?: unknown;
        beforeParentLabel?: string | null;
        afterParentLabel?: string | null;
      } & Record<string, unknown>)
    | null;
  accountBeforeParentLabel: string | null;
  accountAfterParentLabel: string | null;
}

function formatTime(iso: string): string {
  return toPersianDigits(formatJalali(iso, { withMonthName: true }));
}

/** What actually changed, for audit row types that carry a before/after. */
function changeDetail(entry: HistoryEntry): string | null {
  const p = entry.payload ?? {};
  if (entry.action === "account.created") {
    const parts: string[] = [];
    if (p.code) parts.push(`کد ${p.code}`);
    if (p.name) parts.push(`نام «${p.name}»`);
    if (p.parentLabel) parts.push(`زیر ${p.parentLabel}`);
    else if (!p.parentId) parts.push("در سطح گروه");
    if (typeof p.isContra === "boolean" && p.isContra) parts.push("کاهنده");
    return parts.length > 0 ? parts.join("، ") : null;
  }
  if (entry.action === "account.deleted") {
    const parts: string[] = [];
    if (p.code) parts.push(`کد ${p.code}`);
    if (p.name) parts.push(`نام «${p.name}»`);
    return parts.length > 0 ? `حذف شد — ${parts.join("، ")}` : "حذف شد";
  }
  if (entry.action === "account.renamed" && typeof p.before === "string" && typeof p.after === "string") {
    return `از «${p.before}» به «${p.after}»`;
  }
  if (entry.action === "account.contra_changed") {
    return typeof p.after === "boolean" ? (p.after ? "به حساب کاهنده تغییر کرد" : "از حالت کاهنده خارج شد") : null;
  }
  if (entry.action === "account.reparented") {
    const before = entry.accountBeforeParentLabel ?? p.beforeParentLabel ?? "بدون سرگروه";
    const after = entry.accountAfterParentLabel ?? p.afterParentLabel ?? "بدون سرگروه";
    return `از «${before}» به «${after}»`;
  }
  return null;
}

/**
 * One account's change history (issue #160 §7.5, Phase 22 Wave 11) — who
 * renamed/reparented/archived it, and when. Reached from the
 * chart-of-accounts tab, same "small modal per account" pattern as
 * AccountStatementPanel, but reading from the shared audit trail
 * (audit-service.ts) instead of the ledger.
 */
export function AccountHistoryPanel({
  accountId,
  accountCode,
  accountName,
  onClose,
}: {
  accountId: string;
  accountCode: string;
  accountName: string;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setEntries(null);
    setError("");
    void api<{ entries: HistoryEntry[] }>(`/api/ledger/accounts/${accountId}/history`)
      .then(({ ok, data }) => {
        if (ok) setEntries(data.entries);
        else setError("بارگذاری تاریخچهٔ این حساب ناموفق بود.");
      })
      .catch(() => setError("ارتباط با سرور برقرار نشد؛ دوباره تلاش کنید."));
  }, [accountId]);

  return (
    <OverlayDialog
      headingId="account-history-heading"
      onClose={onClose}
      className={`${overlayPanelClass} max-h-[88vh] w-full max-w-2xl overflow-y-auto p-4 sm:max-h-[80vh] sm:p-5`}
    >
        <header className="mb-4 flex items-start justify-between gap-3 border-b border-border pb-4">
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">تاریخچهٔ تغییرات حساب</p>
            <h3 id="account-history-heading" className="mt-1 text-lg font-bold">
              <span dir="ltr">{accountCode}</span> — {accountName}
            </h3>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            بستن
          </Button>
        </header>

        {error ? (
          <ErrorBox>{error}</ErrorBox>
        ) : entries === null ? (
          <LoadingSkeleton rows={3} />
        ) : entries.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
            هیچ تغییری برای این حساب ثبت نشده است.
          </p>
        ) : (
          <ul className="space-y-2">
            {entries.map((entry) => (
              <li key={entry.id} className="rounded-xl border border-border/80 bg-muted/60 p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold text-foreground">{auditActionLabel(entry.action)}</p>
                  <p className="text-xs text-muted-foreground">{formatTime(entry.createdAt)}</p>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{entry.actorName ?? "سیستم"}</p>
                {changeDetail(entry) ? <p className="mt-2 text-foreground">{changeDetail(entry)}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </OverlayDialog>
  );
}
