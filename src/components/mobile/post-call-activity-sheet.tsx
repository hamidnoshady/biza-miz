"use client";

/**
 * Post-call CRM activity logger bottom sheet (`PostCallActivitySheet`) for the
 * Android TWA runtime and mobile CRM flows (issue #884).
 *
 * Automatically opens when the Android wrapper emits `crm.callEnded` over the
 * native bridge after a call genuinely finishes (`CALL_STATE_IDLE`), or can be
 * opened manually from CRM customer screens. Logs the call outcome, notes,
 * optional follow-up date, and optional assignee into the canonical
 * `POST /api/crm/activities` endpoint (`subject` / `body`) without recording
 * call audio or creating a parallel call database.
 */
import { useEffect, useState, type FormEvent } from "react";
import { PhoneIncomingIcon, PhoneOutgoingIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useNative } from "@/components/native/native-provider";
import {
  buildPostCallActivityPayload,
  POST_CALL_OUTCOME_LABELS,
  type PostCallOutcome,
} from "@/lib/native/capabilities-client";
import type { NativeCrmCallEndedEvent } from "@/lib/native/bridge-contract";
import { AppSheet } from "./app-sheet";

export interface PostCallActivitySheetProps {
  manualCall?: NativeCrmCallEndedEvent | null;
  onManualClose?: () => void;
  onLogged?: () => void;
}

const OUTCOME_KEYS = Object.keys(POST_CALL_OUTCOME_LABELS) as PostCallOutcome[];

export function PostCallActivitySheet({
  manualCall = null,
  onManualClose,
  onLogged,
}: PostCallActivitySheetProps) {
  const { onEvent } = useNative();
  const [activeCall, setActiveCall] = useState<NativeCrmCallEndedEvent | null>(manualCall);
  const [outcome, setOutcome] = useState<PostCallOutcome>("answered");
  const [note, setNote] = useState("");
  const [followUpDate, setFollowUpDate] = useState("");
  const [assignedTo, setAssignedTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (manualCall) {
      setActiveCall(manualCall);
    }
  }, [manualCall]);

  useEffect(() => {
    return onEvent("crm.callEnded", (event) => {
      setActiveCall(event);
      setOutcome("answered");
      setNote("");
      setFollowUpDate("");
      setAssignedTo("");
      setError(null);
    });
  }, [onEvent]);

  function close() {
    setActiveCall(null);
    setError(null);
    onManualClose?.();
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!activeCall) return;
    setBusy(true);
    setError(null);
    try {
      const payload = buildPostCallActivityPayload({
        customerId: activeCall.customerId,
        customerName: activeCall.customerName,
        phoneNormalized: activeCall.phoneNormalized,
        direction: activeCall.direction,
        durationSeconds: activeCall.durationSeconds,
        outcome,
        note,
        followUpAt: followUpDate ? new Date(followUpDate).toISOString() : null,
        assignedTo: assignedTo.trim() || undefined,
      });

      const res = await fetch("/api/crm/activities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        setError("ثبت گزارش تماس در CRM انجام نشد.");
        return;
      }
      onLogged?.();
      close();
    } catch {
      setError("خطا در ارتباط با سرور.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppSheet
      open={activeCall !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title="ثبت گزارش تماس در CRM"
      description={
        activeCall
          ? `${activeCall.customerName ?? "مشتری"} (${activeCall.phoneNormalized})`
          : undefined
      }
    >
      {activeCall ? (
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3.5">
          <div className="flex items-center gap-2.5 rounded-xl border border-border/80 bg-secondary/50 p-3 text-xs">
            {activeCall.direction === "incoming" ? (
              <PhoneIncomingIcon className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
            ) : (
              <PhoneOutgoingIcon className="size-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />
            )}
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-foreground">
                {activeCall.customerName ?? "تماس تلفنی"}
              </div>
              <div dir="ltr" className="text-muted-foreground">
                {activeCall.phoneNormalized}
              </div>
            </div>
          </div>

          <div>
            <span className="mb-1.5 block text-xs font-medium text-foreground">نتیجهٔ تماس</span>
            <div className="grid grid-cols-2 gap-1.5">
              {OUTCOME_KEYS.map((key) => {
                const selected = outcome === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setOutcome(key)}
                    className={`min-h-10 rounded-xl border px-3 py-2 text-xs font-medium transition ${
                      selected
                        ? "border-amber-500 bg-amber-50 text-amber-900 dark:border-amber-400 dark:bg-amber-950/50 dark:text-amber-200"
                        : "border-border bg-card text-foreground hover:bg-muted"
                    }`}
                  >
                    {POST_CALL_OUTCOME_LABELS[key]}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-foreground" htmlFor="post-call-note">
              یادداشت تماس
            </label>
            <textarea
              id="post-call-note"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="خلاصهٔ گفتگو، توافق‌ها یا موارد مهم…"
              className="w-full rounded-xl border border-border bg-card p-3 text-sm text-foreground outline-none focus-visible:border-amber-500 dark:focus-visible:border-amber-400"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground" htmlFor="post-call-followup">
                زمان پیگیری بعدی (اختیاری)
              </label>
              <input
                id="post-call-followup"
                type="datetime-local"
                dir="ltr"
                value={followUpDate}
                onChange={(e) => setFollowUpDate(e.target.value)}
                className="min-h-11 w-full rounded-xl border border-border bg-card px-3 text-sm text-foreground outline-none focus-visible:border-amber-500 dark:focus-visible:border-amber-400"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-foreground" htmlFor="post-call-assignee">
                مسئول پیگیری (اختیاری)
              </label>
              <input
                id="post-call-assignee"
                type="text"
                value={assignedTo}
                onChange={(e) => setAssignedTo(e.target.value)}
                placeholder="نام همکار…"
                className="min-h-11 w-full rounded-xl border border-border bg-card px-3 text-sm text-foreground outline-none focus-visible:border-amber-500 dark:focus-visible:border-amber-400"
              />
            </div>
          </div>

          {error ? <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p> : null}

          <div className="flex items-center gap-2 pt-2">
            <Button type="button" variant="outline" className="min-h-11 flex-1" onClick={close}>
              انصراف
            </Button>
            <Button type="submit" disabled={busy} className="min-h-11 flex-1">
              {busy ? "در حال ثبت…" : "ثبت در فعالیت‌های CRM"}
            </Button>
          </div>
        </form>
      ) : null}
    </AppSheet>
  );
}
