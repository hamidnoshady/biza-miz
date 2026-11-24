"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2Icon, FlameIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { toPersianDigits } from "@/lib/digits";
import { ORDER_ITEM_STATUS_LABELS } from "@/lib/order-item-status";

export type BatchActionStatus = "preparing" | "ready";

export interface BatchCandidate {
  id: string;
  name_snapshot: string;
  quantity: number;
  status: "sent" | "preparing" | "ready";
}

/**
 * Confirmation and line selection for a ticket-wide kitchen action.
 *
 * The eligible list is a snapshot of what the operator can see; the server
 * re-evaluates every selected line inside its locked transaction and returns
 * the authoritative outcome. This dialog deliberately does not change any
 * ticket state itself: cancelling and closing send nothing.
 */
export function KitchenBatchActionDialog({
  open,
  action,
  orderNumber,
  items,
  busy,
  error,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  action: BatchActionStatus;
  orderNumber: number;
  items: BatchCandidate[];
  busy: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (itemIds: string[]) => void;
}) {
  const signature = items.map((item) => item.id).join("|");
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setSelected(signature ? signature.split("|") : []);
  }, [open, signature]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const allSelected = items.length > 0 && selected.length === items.length;
  const complicates = action === "ready"
    ? "همهٔ اقلام انتخاب‌شده که در حال آماده‌سازی هستند «آماده» می‌شوند."
    : "همهٔ اقلام انتخاب‌شده که هنوز شروع نشده‌اند «در حال آماده‌سازی» می‌شوند.";
  const confirmLabel = action === "ready" ? "علامت‌گذاری به‌عنوان آماده" : "شروع آماده‌سازی";

  function toggle(itemId: string, checked: boolean) {
    setSelected((current) => {
      if (checked) return current.includes(itemId) ? current : [...current, itemId];
      return current.filter((id) => id !== itemId);
    });
  }

  return (
    <Dialog open={open} onOpenChange={busy ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-lg" aria-busy={busy}>
        <DialogHeader>
          <DialogTitle>
            {action === "ready" ? "علامت‌گذاری گروهی به‌عنوان آماده" : "شروع آماده‌سازی گروهی"}
          </DialogTitle>
          <DialogDescription>
            سفارش {toPersianDigits(orderNumber)} — {complicates}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-semibold text-foreground/80">
            {toPersianDigits(selected.length)} از {toPersianDigits(items.length)} قلم انتخاب شده
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy || items.length === 0}
            onClick={() => setSelected(allSelected ? [] : items.map((item) => item.id))}
          >
            {allSelected ? "لغو انتخاب همه" : "انتخاب همه"}
          </Button>
        </div>

        <ul className="max-h-72 space-y-1 overflow-y-auto rounded-xl border border-border bg-muted/40 p-2">
          {items.map((item) => (
            <li key={item.id}>
              <label
                htmlFor={`kitchen-batch-${item.id}`}
                className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-muted"
              >
                <Checkbox
                  id={`kitchen-batch-${item.id}`}
                  checked={selectedSet.has(item.id)}
                  disabled={busy}
                  onCheckedChange={(checked) => toggle(item.id, checked === true)}
                  aria-label={`انتخاب ${item.name_snapshot}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block break-words font-medium text-foreground/80">
                    {toPersianDigits(item.quantity)}× {item.name_snapshot}
                  </span>
                  <span className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                    {item.status === "ready" ? (
                      <CheckCircle2Icon className="size-3.5" aria-hidden="true" />
                    ) : (
                      <FlameIcon className="size-3.5" aria-hidden="true" />
                    )}
                    {ORDER_ITEM_STATUS_LABELS[item.status]}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>

        <ul className="space-y-1.5 rounded-xl border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          <li>• فقط اقلام انتخاب‌شده تغییر می‌کنند؛ بقیهٔ سفارش دست‌نخورده می‌ماند.</li>
          <li>• اقلام سروشده، باطل یا لغوشده هرگز تغییر نمی‌کنند.</li>
          <li>• اگر همکار دیگری هم‌زمان تغییری بدهد، نتیجهٔ هر قلم جداگانه نمایش داده می‌شود.</li>
        </ul>

        {error ? (
          <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm font-medium text-destructive">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            انصراف
          </Button>
          <Button
            type="button"
            className="min-h-11"
            disabled={busy || selected.length === 0}
            onClick={() => onConfirm(selected)}
          >
            {busy ? "در حال ثبت…" : `${confirmLabel} (${toPersianDigits(selected.length)})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
