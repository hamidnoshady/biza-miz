"use client";

/**
 * The numeric fields a dashboard form is built from.
 *
 * `PersianNumberInput` is deliberately unstyled — it is a behaviour (Persian
 * digits shown, ASCII handed to state), and every caller has to remember to
 * give it `inputClass`. A form that forgot rendered a borderless field whose
 * placeholder was all that showed (the New Product pricing tab). These two wrap
 * it with the platform's input look and the unit the figure is in, so a price
 * or a percentage is spelled one way everywhere:
 *
 *  - `PriceInput` — a whole amount in the business's display unit (تومان or
 *    ریال, from `useMoney()`); the unit sits inside the field's start edge.
 *  - `PercentInput` — a percentage, with «٪» in the same place.
 *
 * Both keep `PersianNumberInput`'s contract: `onChange` receives the canonical
 * ASCII value, so existing `event.target.value` handlers need no change.
 */
import { forwardRef } from "react";
import { PersianNumberInput, type PersianNumberInputProps } from "@/components/ui/persian-number-input";
import { useMoney } from "@/components/money/money-context";
import { cn } from "@/lib/utils";
import { inputClass } from "./ui";

type AdornedProps = Omit<PersianNumberInputProps, "allowNegative" | "grouping">;
type PriceInputProps = AdornedProps & {
  /**
   * Show the unit inside the field. Turn it off where the label already names
   * it («قیمت فروش (تومان)») so the unit is never said twice.
   */
  showUnit?: boolean;
};

const PriceInput = forwardRef<HTMLInputElement, PriceInputProps>(function PriceInput(
  { className, allowDecimal = false, placeholder = "۰", showUnit = true, ...props },
  ref,
) {
  const money = useMoney();
  return (
    <div className="relative">
      <PersianNumberInput
        ref={ref}
        dir="ltr"
        allowDecimal={allowDecimal}
        allowNegative={false}
        placeholder={placeholder}
        className={cn(inputClass, "tabular-nums", showUnit && "ps-14", className)}
        {...props}
      />
      {showUnit ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-xs text-muted-foreground"
        >
          {money.unitLabel}
        </span>
      ) : null}
    </div>
  );
});

const PercentInput = forwardRef<HTMLInputElement, AdornedProps>(function PercentInput(
  { className, allowDecimal = true, placeholder = "۰", ...props },
  ref,
) {
  return (
    <div className="relative">
      <PersianNumberInput
        ref={ref}
        dir="ltr"
        inputMode="decimal"
        allowDecimal={allowDecimal}
        allowNegative={false}
        grouping={false}
        placeholder={placeholder}
        className={cn(inputClass, "ps-9 tabular-nums", className)}
        {...props}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-sm text-muted-foreground"
      >
        ٪
      </span>
    </div>
  );
});

export { PriceInput, PercentInput };
