"use client";

import { toPersianDigits } from "@/lib/digits";
import {
  formatModifierDelta,
  modifierDeltasOf,
  modifierQuantity,
  sumModifierDeltas,
  type DisplayModifier,
} from "@/lib/modifier-display";

/**
 * Add-ons are shown against two different surfaces: the amber cash-desk
 * surfaces (POS cart, review dialog, open-orders panel) and the turquoise
 * document surfaces (order page, waiter panel). One palette on both would read
 * as a foreign element on whichever surface it didn't match, so the tone picks
 * the accent and everything else about the chip stays identical.
 */
export type ModifierTone = "amber" | "brand";

export const MODIFIER_TONE: Record<
  ModifierTone,
  {
    /** Unselected/neutral chip — how an already-chosen add-on reads in a list. */
    chip: string;
    /** The money inside a chip. */
    chipPrice: string;
    /** The «افزودنی‌ها» caption above the chips. */
    caption: string;
    /** A pickable option in the picker, unselected. */
    option: string;
    /** …and selected. */
    optionSelected: string;
    /** Accent for standalone amounts (unit price, group rule badges). */
    accent: string;
    /** Tinted surface for a summary block. */
    surface: string;
    /** The confirming call-to-action, so it matches the surface that opened the dialog. */
    cta: string;
  }
> = {
  amber: {
    chip: "border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 text-muted-foreground",
    chipPrice: "text-amber-700 dark:text-amber-300",
    caption: "text-muted-foreground",
    option:
      "border-border/80 bg-card text-muted-foreground hover:border-amber-200 dark:hover:border-amber-500/30 hover:bg-amber-50 dark:hover:bg-amber-500/15",
    optionSelected: "border-amber-500 dark:border-amber-500/60 bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300",
    accent: "text-amber-700 dark:text-amber-300",
    surface: "border-amber-200/60 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15",
    cta: "bg-amber-500 dark:bg-amber-400 text-amber-950 hover:bg-amber-500 dark:hover:bg-amber-400 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45",
  },
  brand: {
    chip: "border-primary/25 bg-primary/5 text-foreground",
    chipPrice: "text-primary",
    caption: "text-muted-foreground",
    option:
      "border-input bg-background text-muted-foreground hover:border-primary/50 hover:bg-primary/5 hover:text-foreground",
    optionSelected: "border-primary bg-primary/10 text-primary",
    accent: "text-primary",
    surface: "border-primary/20 bg-primary/5",
    cta: "bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring/45",
  },
};

/**
 * The one way an order line's add-ons are rendered on screen: a captioned row
 * of chips, each carrying its own price. Callers pass the line's add-ons; an
 * empty list renders nothing so a plain line stays visually plain.
 */
export function ModifierBadges({
  modifiers,
  tone = "amber",
  showCaption = true,
  showPrices = true,
  className = "",
}: {
  modifiers: DisplayModifier[];
  tone?: ModifierTone;
  showCaption?: boolean;
  showPrices?: boolean;
  className?: string;
}) {
  if (modifiers.length === 0) return null;
  const palette = MODIFIER_TONE[tone];
  // The caption states what the add-ons add to ONE unit, so every delta is
  // repeated by that add-on's own count — «شات ×۳» is three shots' worth of
  // money, not one (migration 0169).
  const total = sumModifierDeltas(modifierDeltasOf(modifiers));

  return (
    <div className={className}>
      {showCaption ? (
        <p
          className={`mb-1 text-[11px] font-semibold ${palette.caption}`}
          aria-hidden="true"
        >
          افزودنی‌ها
          {showPrices && total !== 0
            ? ` (${formatModifierDelta(total)} روی هر واحد)`
            : ""}
        </p>
      ) : null}
      <ul className="flex flex-wrap gap-1.5">
        {modifiers.map((modifier, index) => {
          const quantity = modifierQuantity(modifier);
          const extended = modifier.priceDelta * quantity;
          return (
            <li
              key={`${modifier.name}-${index}`}
              className={`inline-flex max-w-full items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-semibold leading-5 ${palette.chip}`}
            >
              <span className="truncate">
                {modifier.name}
                {quantity > 1 ? (
                  <span className="ms-1 font-black">
                    ×{toPersianDigits(quantity)}
                  </span>
                ) : null}
              </span>
              {showPrices ? (
                <span
                  className={`flex shrink-0 items-baseline gap-1 font-bold ${palette.chipPrice}`}
                >
                  {/* The chip's money is the EXTENDED price for this add-on;
                      the unit price is named beside it when it differs, so
                      «×۳» can never be read as a third of what it costs. */}
                  <span>{formatModifierDelta(extended)}</span>
                  {quantity > 1 && modifier.priceDelta !== 0 ? (
                    <span
                      className="text-[10px] font-semibold opacity-80"
                      title="مبلغ هر عدد"
                    >
                      (هر عدد {formatModifierDelta(modifier.priceDelta, { withUnit: false })})
                    </span>
                  ) : null}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
