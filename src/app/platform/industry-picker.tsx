"use client";

/**
 * Phase 25 Wave 1 — the console's business-type picker.
 *
 * The same control serves both places the super-admin chooses an industry: the
 * provision form on the landing page, and the industry panel on a business's
 * detail page. It deliberately does not share a component with the identical
 * grid on `/welcome` (src/app/welcome/page.tsx) — that one is rendered in the
 * tenant app's layout, while the console has its own theme-aware visual
 * language, so sharing would mean a variant prop threading two design systems
 * through one component for no gain. What is
 * shared is the thing that matters: `INDUSTRIES` / `ENABLED_INDUSTRIES` /
 * `INDUSTRY_LABELS` from src/lib/industries.ts, so neither copy can drift on
 * which industries exist or what they are called.
 */
import { useRef } from "react";
import { ENABLED_INDUSTRIES, INDUSTRIES, INDUSTRY_LABELS, type Industry } from "@/lib/industries";
import { radioMoveForKey, radioTargetIndex } from "@/lib/radio-keys";

export function IndustryPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: Industry;
  onChange: (industry: Industry) => void;
  disabled?: boolean;
}) {
  // Roving focus for the `role="radiogroup"` below — see radio-keys.ts (the
  // same helper business-settings.tsx's currency choice and
  // branches-manager.tsx's colour picker use). Skips options that are
  // disabled or not yet available, since a "به‌زودی" tile can't take focus.
  const buttonsRef = useRef<Array<HTMLButtonElement | null>>([]);

  return (
    <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="نوع کسب‌وکار">
      {INDUSTRIES.map((option, index) => {
        const available = ENABLED_INDUSTRIES.includes(option);
        const selected = value === option;
        const canFocus = !disabled && available;
        return (
          <button
            key={option}
            ref={(node) => {
              buttonsRef.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled || !available}
            tabIndex={selected && canFocus ? 0 : -1}
            onClick={() => available && onChange(option)}
            onKeyDown={(event) => {
              if (disabled) return;
              const move = radioMoveForKey(event.key, true);
              if (!move) return;
              // Step from the current option until an enabled one is found,
              // bounded by the group's length so an all-disabled group (never
              // happens today, but costs nothing to guard) can't loop forever.
              let target = radioTargetIndex(move, index, INDUSTRIES.length);
              for (let steps = 0; target !== null && steps < INDUSTRIES.length; steps += 1) {
                if (ENABLED_INDUSTRIES.includes(INDUSTRIES[target])) break;
                target = radioTargetIndex(move === "first" || move === "last" ? "next" : move, target, INDUSTRIES.length);
              }
              if (target === null) return;
              event.preventDefault();
              onChange(INDUSTRIES[target]);
              buttonsRef.current[target]?.focus();
            }}
            className={`relative rounded-lg border px-3 py-2 text-sm transition-colors ${
              selected
                ? "border-sky-400/60 bg-sky-400/10 font-medium text-sky-800 dark:text-sky-200"
                : "border-border text-foreground"
            } ${
              disabled || !available
                ? "cursor-not-allowed opacity-50"
                : "hover:border-sky-400/40 hover:text-foreground"
            }`}
          >
            {INDUSTRY_LABELS[option]}
            {!available ? (
              <span className="absolute -top-2 -left-2 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                به‌زودی
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
