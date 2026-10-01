"use client";

import * as React from "react";
import { KeyRoundIcon, CheckCircle2Icon, CircleIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PlatformStatusBadge } from "./status-badge";
import { cn } from "@/lib/utils";

/**
 * The console's one secret-input pattern (section 28). Secrets are never echoed
 * back from the server; the field only ever shows configured/not-configured and
 * an optional masked hint. An operator "replaces" a secret by revealing the
 * input and typing a new value; leaving it untouched keeps the stored value.
 * An EMPTY input must never delete an existing credential — that requires the
 * explicit "clear" action.
 *
 * The parent reads `value` (the new secret to send, or "" to leave unchanged)
 * and `cleared` (true when the operator asked to remove the credential).
 */
export function PlatformSecretField({
  label,
  description,
  configured,
  maskedHint,
  value,
  onChange,
  cleared,
  onClearedChange,
  canClear = true,
  placeholder = "برای جایگزینی، مقدار جدید را وارد کنید",
  disabled,
  id,
  className,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  /** Whether a secret is currently stored on the server. */
  configured: boolean;
  /** A safe masked hint (e.g. «••••abcd»), when the backend can provide one. */
  maskedHint?: string | null;
  /** The new secret to submit; "" means "leave unchanged". */
  value: string;
  onChange: (value: string) => void;
  /** True when the operator has staged a clear of the stored credential. */
  cleared?: boolean;
  onClearedChange?: (cleared: boolean) => void;
  canClear?: boolean;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}) {
  const [editing, setEditing] = React.useState(!configured);
  const generatedId = React.useId();
  const inputId = id ?? generatedId;

  // Not configured and no staged clear → always in edit mode.
  const showInput = editing || !configured;

  function beginReplace() {
    setEditing(true);
    onClearedChange?.(false);
  }

  function cancelReplace() {
    setEditing(false);
    onChange("");
  }

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={inputId} className="flex items-center gap-1.5">
          <KeyRoundIcon
            className="size-3.5 text-muted-foreground"
            aria-hidden="true"
          />
          {label}
        </Label>
        {cleared ? (
          <PlatformStatusBadge tone="warning" label="حذف در انتظار ذخیره" />
        ) : configured ? (
          <PlatformStatusBadge tone="success" dot label="تنظیم‌شده" />
        ) : (
          <PlatformStatusBadge tone="muted" dot label="تنظیم‌نشده" />
        )}
      </div>

      {description ? (
        <p className="text-xs leading-5 text-muted-foreground">{description}</p>
      ) : null}

      {cleared ? (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm dark:border-amber-400/30 dark:bg-amber-400/10">
          <span className="text-amber-700 dark:text-amber-300">
            این اعتبارنامه با ذخیره حذف می‌شود.
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onClearedChange?.(false)}
            disabled={disabled}
          >
            لغو
          </Button>
        </div>
      ) : showInput ? (
        <>
          <Input
            id={inputId}
            type="password"
            autoComplete="new-password"
            dir="ltr"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            disabled={disabled}
          />
          {configured ? (
            <button
              type="button"
              onClick={cancelReplace}
              disabled={disabled}
              className="text-xs text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50 outline-none focus-visible:ring focus-visible:ring-ring/50 rounded-sm"
            >
              نگه‌داشتن مقدار فعلی
            </button>
          ) : null}
        </>
      ) : (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
          <span
            className="flex items-center gap-2 text-sm text-muted-foreground"
            dir="ltr"
          >
            {maskedHint ? (
              <span className="font-mono">{maskedHint}</span>
            ) : (
              <span className="font-mono tracking-widest">••••••••</span>
            )}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={beginReplace}
              disabled={disabled}
            >
              جایگزینی
            </Button>
            {canClear ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onClearedChange?.(true)}
                disabled={disabled}
                className="text-destructive hover:text-destructive"
              >
                حذف
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

/** A tiny read-only "configured?" indicator for status panels. */
export function SecretStatus({ configured }: { configured: boolean }) {
  return configured ? (
    <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
      <CheckCircle2Icon className="size-3.5" aria-hidden="true" />
      تنظیم‌شده
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <CircleIcon className="size-3.5" aria-hidden="true" />
      تنظیم‌نشده
    </span>
  );
}
