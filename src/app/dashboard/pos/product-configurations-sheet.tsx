"use client";

import { MinusIcon, PencilIcon, PlusIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import {
  linePriceBreakdown,
  modifierDeltasOf,
  type DisplayModifier,
} from "@/lib/modifier-display";
import { ModifierBadges } from "../modifier-badges";
import type { PosCartLine } from "@/lib/pos-cart";

/**
 * "Which configuration of this product?" — the surface the product tile was
 * missing.
 *
 * A tile knows only the product: its + rings up a plain unit and its − undoes
 * the last touch, and neither can say *which* of several carts lines it
 * touched. Once a product is in the cart in more than one shape (plain, with
 * chocolate, with chocolate and milk), correcting one of them meant hunting
 * for the right card in the cart list — on a phone, behind a sheet.
 *
 * This dialog names every configuration the cart holds, with its add-ons,
 * count, and full line total, and gives each one the two actions that were
 * previously only available on its card: add a unit of THAT configuration, or
 * re-open its add-ons. «ترکیب جدید» is the explicit way to start another one
 * from scratch.
 *
 * Rows are read from the cart, never copied into local state: a stepper press
 * here mutates the cart exactly like the card's stepper does, and the dialog
 * re-renders from the same lines the cart list renders.
 */
export function ProductConfigurationsSheet({
  itemName,
  lines,
  onEdit,
  onStep,
  onNew,
  onClose,
}: {
  itemName: string;
  /** The cart lines that belong to one product, in cart order. */
  lines: readonly PosCartLine[];
  onEdit: (key: string) => void;
  onStep: (key: string, delta: 1 | -1) => void;
  /** Start a configuration the cart does not hold yet. */
  onNew: () => void;
  onClose: () => void;
}) {
  const money = useMoney();

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>ترکیب‌های «{itemName}» در سبد</DialogTitle>
          <DialogDescription>
            هر ردیف یک ترکیب است. «+» روی هر ردیف همان ترکیب را زیاد می‌کند؛
            برای واحد بدون افزودنی از همین گفتگو یک ترکیب جدید بسازید یا آن را
            از تابلؤ محصول اضافه کنید.
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-2.5" aria-label={`ترکیب‌های ${itemName}`}>
          {lines.map((line, index) => {
            const breakdown = linePriceBreakdown({
              unitPrice: line.unitPrice,
              modifierDeltas: modifierDeltasOf(
                line.modifiers as DisplayModifier[],
              ),
              quantity: line.quantity,
            });
            const configuration = `ترکیب ${toPersianDigits(index + 1)}`;
            return (
              <li
                key={line.key}
                aria-label={`${configuration} از ${itemName}`}
                className="rounded-xl border border-border/80 bg-card p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-foreground">
                      {configuration}
                      {line.modifiers.length === 0 && !line.note ? (
                        <span className="ms-1.5 text-xs font-normal text-muted-foreground">
                          (بدون افزودنی)
                        </span>
                      ) : null}
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {toPersianDigits(line.quantity)} ×{" "}
                      {money.format(breakdown.unit)}
                    </p>
                  </div>
                  <p className="shrink-0 text-sm font-bold text-amber-700 dark:text-amber-300">
                    {money.format(breakdown.total)}
                  </p>
                </div>

                {line.modifiers.length > 0 ? (
                  <div className="mt-2">
                    <ModifierBadges
                      modifiers={line.modifiers as DisplayModifier[]}
                      tone="amber"
                      showCaption={false}
                    />
                  </div>
                ) : null}
                {line.note ? (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    یادداشت: {line.note}
                  </p>
                ) : null}

                <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border/70 pt-2">
                  <div
                    className="flex items-center gap-1 rounded-lg border border-border/80 bg-muted p-0.5"
                    role="group"
                    aria-label={`تعداد ${configuration} از ${itemName}`}
                  >
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`کاهش ${configuration} از ${itemName}`}
                      onClick={() => onStep(line.key, -1)}
                    >
                      <MinusIcon className="size-4" aria-hidden="true" />
                    </Button>
                    <span className="min-w-6 text-center text-sm font-bold tabular-nums">
                      {toPersianDigits(line.quantity)}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`افزایش ${configuration} از ${itemName} (با همین افزودنی‌ها)`}
                      onClick={() => onStep(line.key, 1)}
                    >
                      <PlusIcon className="size-4" aria-hidden="true" />
                    </Button>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 text-xs text-amber-700 dark:text-amber-300"
                    aria-label={`ویرایش افزودنی‌های ${configuration} از ${itemName}`}
                    onClick={() => onEdit(line.key)}
                  >
                    <PencilIcon className="size-3.5" aria-hidden="true" />
                    ویرایش افزودنی‌ها
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            بستن فهرست
          </Button>
          <Button onClick={onNew}>
            <PlusIcon className="size-4" aria-hidden="true" />
            ترکیب جدید
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
