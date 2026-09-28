"use client";

import { CheckIcon, CircleAlertIcon, Clock3Icon, SparklesIcon, XIcon } from "lucide-react";
import { ACTION_CATALOG, type ProposedAction } from "@/lib/ai";
import { Button } from "@/components/ui/button";

export type ProposalStatus = "proposed" | "processing" | "applied" | "failed" | "dismissed" | "reverted" | null;

const STATUS_COPY: Record<Exclude<ProposalStatus, null | "proposed">, string> = {
  processing: "در حال اجرا…",
  applied: "اجرا شد",
  failed: "اجرا ناموفق بود",
  dismissed: "رد شد",
  reverted: "برگردانده شد",
};

export function AiProposalCard({
  proposal,
  applied,
  status = null,
  applying,
  onApply,
  onDismiss,
}: {
  proposal: ProposedAction;
  applied?: boolean;
  status?: ProposalStatus;
  applying: boolean;
  onApply: () => void;
  onDismiss: () => void;
}) {
  const meta = ACTION_CATALOG[proposal.type];
  const terminal = status && status !== "proposed";
  const effectiveStatus = applied ? "applied" : status;
  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm">
      <div className="mb-1 flex items-center gap-1.5 font-semibold text-primary">
        <SparklesIcon className="size-4" />
        {proposal.title || meta?.label}
      </div>
      {proposal.summary ? <p className="mb-2 text-foreground/90">{proposal.summary}</p> : null}
      <details className="mb-2 rounded-lg bg-background/70 px-2 py-1.5 text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none">جزئیات فنی</summary>
        <pre dir="ltr" className="mt-2 max-h-40 overflow-auto text-left text-[11px]">
          {JSON.stringify(proposal.payload, null, 2)}
        </pre>
      </details>
      {terminal && effectiveStatus ? (
        <p
          className={`flex items-center gap-1 font-medium ${
            effectiveStatus === "applied" || effectiveStatus === "reverted"
              ? "text-emerald-600 dark:text-emerald-400"
              : effectiveStatus === "failed"
                ? "text-red-600 dark:text-red-400"
                : "text-muted-foreground"
          }`}
        >
          {effectiveStatus === "applied" ? <CheckIcon className="size-4" /> : null}
          {effectiveStatus === "failed" ? <CircleAlertIcon className="size-4" /> : null}
          {effectiveStatus === "dismissed" ? <XIcon className="size-4" /> : null}
          {effectiveStatus === "reverted" ? <Clock3Icon className="size-4" /> : null}
          {STATUS_COPY[effectiveStatus as Exclude<ProposalStatus, null | "proposed">]}
        </p>
      ) : (
        <div className="flex gap-2">
          <Button size="sm" onClick={onApply} disabled={applying}>
            <CheckIcon aria-hidden="true" />
            {applying ? "در حال اجرا…" : "تأیید و اجرا"}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss} disabled={applying}>
            رد
          </Button>
        </div>
      )}
    </div>
  );
}
