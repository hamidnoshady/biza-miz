"use client";

/**
 * Issue #984 — the ticket's «سوابق» tab: every diagnostic run, repair,
 * assistance session, token and consent decision on this ticket as one
 * durable timeline. History is append-only: a new run never overwrites an
 * old one, and artifact expiry keeps its audit metadata.
 */
import { PlatformDetailSection } from "@/components/platform";
import { usePlatformQuery } from "../../_lib/use-platform-data";
import { fmtDateTime } from "@/lib/platform-format";
import {
  SUPPORT_ASSISTANCE_STATE_LABELS,
  SUPPORT_REPAIR_RUN_STATE_LABELS,
  SUPPORT_REQUEST_STATE_LABELS,
  SUPPORT_RUN_STATE_LABELS,
  SUPPORT_TOKEN_STATE_LABELS,
} from "@/lib/support-companion/types";
import type {
  AccessTokenDto,
  AssistanceSessionDto,
  DiagnosticRequestDto,
  DiagnosticRunDto,
  RepairRunDto,
  TicketSupportContext,
} from "./types";

interface TimelineEntry {
  at: string;
  kind: string;
  text: string;
}

export function HistoryPanel({ ticketId }: { ticketId: string }) {
  const diagnostics = usePlatformQuery<{ requests: DiagnosticRequestDto[]; runs: DiagnosticRunDto[] }>(
    `/api/platform/support/diagnostics?ticketId=${ticketId}`,
    [ticketId],
  );
  const repairs = usePlatformQuery<{ runs: RepairRunDto[] }>(
    `/api/platform/support/repairs?ticketId=${ticketId}`,
    [ticketId],
  );
  const assistance = usePlatformQuery<{ sessions: AssistanceSessionDto[] }>(
    `/api/platform/support/assistance?ticketId=${ticketId}`,
    [ticketId],
  );
  const tokens = usePlatformQuery<{ tokens: AccessTokenDto[] }>(
    `/api/platform/support/access-tokens?ticketId=${ticketId}`,
    [ticketId],
  );
  const context = usePlatformQuery<{ context: TicketSupportContext }>(
    `/api/platform/support/tickets/${ticketId}/context`,
    [ticketId],
  );

  if (diagnostics.loading) return <p className="text-sm text-muted-foreground">در حال بارگذاری سوابق…</p>;
  const failed = diagnostics.errorText ?? repairs.errorText ?? assistance.errorText ?? tokens.errorText;
  if (failed)
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {failed}
      </p>
    );

  const entries: TimelineEntry[] = [
    ...(diagnostics.data?.requests ?? []).map((item) => ({
      at: item.createdAt,
      kind: "درخواست بررسی",
      text: `${SUPPORT_REQUEST_STATE_LABELS[item.state as keyof typeof SUPPORT_REQUEST_STATE_LABELS] ?? item.state} — ${item.modules.length} ماژول`,
    })),
    ...(diagnostics.data?.runs ?? []).map((item) => ({
      at: item.createdAt,
      kind: "اجرای بررسی",
      text: `${SUPPORT_RUN_STATE_LABELS[item.state as keyof typeof SUPPORT_RUN_STATE_LABELS] ?? item.state} — ${item.findings.length} یافته — شدت ${item.severityOverall}`,
    })),
    ...(repairs.data?.runs ?? []).map((item) => ({
      at: item.createdAt,
      kind: "تعمیر",
      text: `${item.recipeId}@${item.recipeVersion} — ${SUPPORT_REPAIR_RUN_STATE_LABELS[item.state as keyof typeof SUPPORT_REPAIR_RUN_STATE_LABELS] ?? item.state}`,
    })),
    ...(assistance.data?.sessions ?? []).map((item) => ({
      at: item.createdAt,
      kind: "کمک راه‌دور",
      text: `${SUPPORT_ASSISTANCE_STATE_LABELS[item.state as keyof typeof SUPPORT_ASSISTANCE_STATE_LABELS] ?? item.state} — ${item.requestedCaps.join("/")}`,
    })),
    ...(tokens.data?.tokens ?? []).map((item) => ({
      at: item.createdAt,
      kind: "توکن حضوری",
      text: `${SUPPORT_TOKEN_STATE_LABELS[item.state as keyof typeof SUPPORT_TOKEN_STATE_LABELS] ?? item.state} — ${item.scope.length} قابلیت`,
    })),
    ...(context.data?.context.consent ?? []).map((item) => ({
      at: item.createdAt,
      kind: "رضایت مشتری",
      text: `${item.subject} — ${item.decision}`,
    })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1));

  return (
    <PlatformDetailSection title="خط زمانی تیکت">
      {entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">هنوز رویدادی برای این تیکت ثبت نشده است.</p>
      ) : (
        <ol className="space-y-2">
          {entries.map((entry, index) => (
            <li key={`${entry.at}-${index}`} className="flex items-start justify-between gap-3 text-xs">
              <div>
                <span className="font-medium text-foreground">{entry.kind}</span>
                <span className="text-muted-foreground"> — {entry.text}</span>
              </div>
              <span className="shrink-0 text-muted-foreground">{fmtDateTime(entry.at)}</span>
            </li>
          ))}
        </ol>
      )}
    </PlatformDetailSection>
  );
}
