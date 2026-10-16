"use client";

import * as React from "react";
import { AlertTriangleIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ErrorBox, Field, inputClass } from "@/app/dashboard/ui";

/**
 * The product confirmation every destructive personal-security action goes
 * through before it may send a mutation (issue #854 P2.26).
 *
 * The rules this component exists to enforce:
 *
 *  - **Cancellation sends nothing.** The dialog's only output is `onConfirm`;
 *    closing it — the button, the scrim, Escape — never calls the mutation.
 *  - **Consequences are spelled out.** `consequences` renders as a visible
 *    list; a destructive action that cannot describe its own scope is the one
 *    the member should not be taking, so the prop is required, not decorative.
 *  - **Recent-auth is additional proof, not the confirmation.** The step-up
 *    prompt proves who is acting; this dialog proves they chose *this* action
 *    knowing what it does. They are two separate gates and stay that way.
 *  - **Retries do not duplicate.** While `busy` the dialog cannot be closed
 *    and both buttons disable, so a slow network cannot be answered with a
 *    second confirm that re-runs the mutation.
 *
 * `variant="destructive"` gives irreversible actions (factor removal, recovery
 * regeneration, credential removal) the red framing; reversible confirmations
 * use the default variant.
 *
 * ## The optional reason (issue #947, TEAM-F08)
 *
 * Some confirmations are also *access changes* whose justification the server
 * insists on: archiving a custom role, retiring a permission template. Those
 * screens used `window.prompt` to ask — a native dialog the product cannot style,
 * localize or validate, and one that a screen reader announces as an unlabelled
 * text box. Passing `reason` turns the same confirmation into the application's own
 * field: labelled, hinted, length-checked before the button enables, and part of the
 * one dialog the member already confirmed. The caller keeps the value in its own
 * state, so cancelling sends nothing and the reason never leaves the form.
 */
export function SecurityConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  consequences,
  confirmLabel = "تأیید و ادامه",
  cancelLabel = "انصراف",
  busy = false,
  error,
  variant = "destructive",
  reason,
  onConfirm,
}: {
  open: boolean;
  /** Called with `false` when the member cancels; must never trigger a mutation. */
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** What actually happens if the member confirms — rendered as a list. */
  consequences: readonly React.ReactNode[];
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  error?: React.ReactNode;
  variant?: "default" | "destructive";
  /**
   * The justification field, rendered inside the dialog when the action is an
   * access change the server will ask for a reason about. Omitted entirely for the
   * confirmations that need none.
   */
  reason?: {
    label: string;
    hint?: string;
    value: string;
    onChange: (value: string) => void;
    /** Minimum characters the server accepts; the confirm button waits for it. */
    minLength: number;
    maxLength?: number;
  };
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={busy ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {variant === "destructive" ? (
              <AlertTriangleIcon aria-hidden="true" className="size-4 shrink-0 text-destructive" />
            ) : null}
            {title}
          </DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>

        <ul className="space-y-1.5 rounded-xl border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          {consequences.map((item, index) => (
            <li key={index} className="flex gap-2">
              <span aria-hidden="true" className="text-destructive">•</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>

        {reason ? (
          <Field label={reason.label} hint={reason.hint}>
            <textarea
              className={inputClass}
              value={reason.value}
              onChange={(event) => reason.onChange(event.target.value)}
              rows={3}
              maxLength={reason.maxLength ?? 500}
              aria-required="true"
            />
          </Field>
        ) : null}

        {error ? <ErrorBox>{error}</ErrorBox> : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={variant === "destructive" ? "destructive" : "default"}
            onClick={onConfirm}
            disabled={busy || (reason ? reason.value.trim().length < reason.minLength : false)}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
