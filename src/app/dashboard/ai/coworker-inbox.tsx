"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

/**
 * Phase 32 — the approval inbox.
 *
 * The one screen the whole feature is judged on: an owner who has handed work
 * to the coworker needs to see, in one place, what it wants to do tonight and
 * say yes or no. Everything else (the job list, the review) is setup; this is
 * the daily surface.
 *
 * Two deliberate choices about what it shows. A held action always says WHY it
 * was held — over a cap, category off, "you asked to be asked" — because "the
 * coworker didn't do it" with no reason is the thing that makes people turn a
 * feature off. And a run's actions are listed individually even when they are
 * approved together, because a night's write-off is five items and "it worked"
 * would hide the one that didn't.
 */
import { useCallback, useEffect, useState } from "react";
import { CheckIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useFeatureLocked } from "@/components/feature-lock";
import { ACCOUNTING_REVIEW_SEVERITY_LABELS, type AccountingFinding } from "@/lib/accounting-review";
import { COWORKER_RUN_STATUS_LABELS, type CoworkerRunStatus } from "@/lib/ai-coworker";
import { AI_APPROVAL_TTL_HOURS } from "@/lib/ai-approval-policy";
import { EmptyState, SectionCard, StatusBadge } from "../page-chrome";
import { SEVERITY_TONE, type CoworkerRunView } from "./coworker-types";
import { formatDateTime } from "./format";

const RUN_TONE: Record<CoworkerRunStatus, "active" | "positive" | "neutral" | "danger"> = {
  pending_approval: "active",
  applied: "positive",
  partially_applied: "active",
  rejected: "neutral",
  failed: "danger",
  skipped: "neutral",
  reported: "active",
};

const ACTION_TONE: Record<CoworkerRunActionStatus, "active" | "positive" | "neutral" | "danger"> = {
  pending: "active",
  applied: "positive",
  failed: "danger",
  rejected: "neutral",
  skipped: "neutral",
};

const ACTION_LABEL: Record<CoworkerRunActionStatus, string> = {
  pending: "در انتظار",
  applied: "ثبت شد",
  failed: "ناموفق",
  rejected: "رد شد",
  skipped: "رد شد",
};

type CoworkerRunActionStatus = CoworkerRunView["actions"][number]["status"];

/** GH #1567 F7 — a held run must be decided within the approval window. */
function approvalDeadline(run: CoworkerRunView): string {
  return new Date(new Date(run.createdAt).getTime() + AI_APPROVAL_TTL_HOURS * 3_600_000).toISOString();
}

function approvalExpired(run: CoworkerRunView): boolean {
  return Date.now() > new Date(approvalDeadline(run)).getTime();
}

function FindingList({ findings }: { findings: AccountingFinding[] }) {
  return (
    <ul className="space-y-2">
      {findings.map((finding) => (
        <li key={finding.code} className="rounded-xl border border-border/80 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium text-foreground">{finding.title}</span>
            <StatusBadge tone={SEVERITY_TONE[finding.severity]}>
              {ACCOUNTING_REVIEW_SEVERITY_LABELS[finding.severity]}
            </StatusBadge>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{finding.detail}</p>
          <p className="mt-1 text-xs leading-5 text-foreground/80">{finding.suggestion}</p>
        </li>
      ))}
    </ul>
  );
}

export function CoworkerInbox({ onChange }: { onChange?: () => void }) {
  const locked = useFeatureLocked();
  const [runs, setRuns] = useState<CoworkerRunView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/ai/coworker/runs?limit=40");
      const body = (await response.json().catch(() => ({}))) as { runs?: CoworkerRunView[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "خواندن کارهای همکار هوشمند ممکن نشد.");
      setRuns(body.runs ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "خواندن کارهای همکار هوشمند ممکن نشد.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (locked) {
      setLoading(false);
      return;
    }
    void load();
  }, [load, locked]);

  async function decide(run: CoworkerRunView, decision: "approve" | "reject") {
    const runId = run.id;
    setBusyId(runId);
    try {
      // GH #1567 F7 — the approval is bound to exactly what this card shows:
      // one hash per pending financial/stock action. The server refuses a
      // missing or different hash and runs nothing.
      const approvals = Object.fromEntries(
        run.actions
          .filter((action) => action.status === "pending" && action.approvalHash)
          .map((action) => [action.id, action.approvalHash as string]),
      );
      const response = await fetch(`/api/ai/coworker/runs/${runId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(decision === "approve" ? { decision, approvals } : { decision }),
      });
      const body = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
      if (!response.ok) throw new Error(body.message ?? body.error ?? "ثبت تصمیم ممکن نشد.");
      toast.success(decision === "approve" ? "اقدام‌ها ثبت شد." : "این اجرا رد شد.");
      await load();
      onChange?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "ثبت تصمیم ممکن نشد.");
    } finally {
      setBusyId(null);
    }
  }

  const pending = runs.filter((run) => run.status === "pending_approval");
  const history = runs.filter((run) => run.status !== "pending_approval");

  function renderRun(run: CoworkerRunView, actionable: boolean) {
    const findings = run.facts?.findings ?? [];
    return (
      <li key={run.id} className="px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">{run.jobTitle}</span>
              <StatusBadge tone={RUN_TONE[run.status]}>{COWORKER_RUN_STATUS_LABELS[run.status]}</StatusBadge>
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{run.summary}</p>
            <p className="mt-1 text-xs text-muted-foreground">{formatDateTime(run.createdAt)}</p>
            {actionable ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {approvalExpired(run)
                  ? "مهلت تأیید این اجرا گذشته است؛ فقط رد کردن ممکن است."
                  : `مهلت تأیید تا ${formatDateTime(approvalDeadline(run))}`}
              </p>
            ) : null}
          </div>
          {actionable ? (
            <div className="flex shrink-0 items-center gap-2">
              <Button size="sm" onClick={() => void decide(run, "approve")} disabled={busyId === run.id || approvalExpired(run)}>
                <CheckIcon className="size-4" aria-hidden="true" />
                {busyId === run.id ? "در حال ثبت…" : "تأیید و ثبت"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void decide(run, "reject")}
                disabled={busyId === run.id}
              >
                <XIcon className="size-4" />
                رد
              </Button>
            </div>
          ) : null}
        </div>

        {run.actions.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {run.actions.map((action) => (
              <li key={action.id} className="rounded-xl border border-border/80 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">{action.title}</span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    {action.status === "pending" && action.approvalHash ? (
                      <StatusBadge tone="neutral">نیازمند تأیید انسانی</StatusBadge>
                    ) : null}
                    <StatusBadge tone={ACTION_TONE[action.status]}>{ACTION_LABEL[action.status]}</StatusBadge>
                  </span>
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{action.summary}</p>
                {/* Why it is waiting, always — a silent hold is what makes an
                    owner stop trusting the feature. */}
                {action.heldReason ? (
                  <p className="mt-1 text-xs leading-5 text-amber-800 dark:text-amber-300">{action.heldReason}</p>
                ) : null}
                {action.error ? (
                  <p className="mt-1 text-xs leading-5 text-destructive">{action.error}</p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        {findings.length > 0 ? (
          <div className="mt-3">
            <FindingList findings={findings} />
          </div>
        ) : null}
      </li>
    );
  }

  return (
    <div className="space-y-4">
      <SectionCard
        title="در انتظار تأیید شما"
        description="کارهایی که همکار هوشمند آماده کرده و منتظر «بله» شماست."
        flush
      >
        {loading ? (
          <div className="p-4 sm:p-5"><LoadingSkeleton rows={4} /></div>
        ) : pending.length === 0 ? (
          <div className="p-4 sm:p-5">
            <EmptyState>چیزی در انتظار تأیید نیست.</EmptyState>
          </div>
        ) : (
          <ul className="divide-y divide-border/80">{pending.map((run) => renderRun(run, true))}</ul>
        )}
      </SectionCard>

      <SectionCard title="سابقهٔ اجرا" description="آخرین اجراهای همکار هوشمند و نتیجهٔ هرکدام." flush>
        {history.length === 0 ? (
          <div className="p-4 sm:p-5">
            <EmptyState>هنوز اجرایی ثبت نشده است.</EmptyState>
          </div>
        ) : (
          <ul className="divide-y divide-border/80">{history.map((run) => renderRun(run, false))}</ul>
        )}
      </SectionCard>
    </div>
  );
}
