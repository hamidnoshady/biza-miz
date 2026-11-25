"use client";

/**
 * The inline «راهنمای همین مرحله» block (issue #1239 / ESH-90).
 *
 * Rendered by `StepShell`, so every wizard step carries it. It shows the
 * published Knowledge Base excerpt for this step when one resolves, and the
 * step's local fallback lines otherwise — so the owner always has an
 * explanation inside the form, online or offline, and never has to leave the
 * wizard to understand a field.
 *
 * Native `<details>`/`<summary>` rather than a modal: expandable, keyboard and
 * screen-reader accessible with no extra state, and it does not cover the form
 * it is explaining.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { BookOpenIcon } from "lucide-react";
import { cardClass } from "@/app/dashboard/page-chrome";
import type { WizardStep } from "@/lib/wizard-steps";
import { setupStepHelp } from "@/lib/setup-wizard-help";
import { api } from "./ui";

interface InlineHelpResponse {
  inlineHelp?: { guide: { slug: string; title: string }; lines: string[] } | null;
}

export function SetupStepHelp({ step }: { step: WizardStep }) {
  const help = setupStepHelp(step);
  const [published, setPublished] = useState<InlineHelpResponse["inlineHelp"]>(null);

  useEffect(() => {
    let cancelled = false;
    // A failure (offline install, unpublished guide, 500) is deliberately
    // swallowed: the local lines below are the whole fallback, and a help block
    // must never show a wizard-level error.
    void api<InlineHelpResponse>(
      `/api/knowledge?page=${encodeURIComponent(help.pageKey)}&step=${encodeURIComponent(step)}`,
    )
      .then(({ ok, data }) => {
        if (!cancelled && ok) setPublished(data.inlineHelp ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [help.pageKey, step]);

  const lines = published?.lines?.length ? published.lines : help.lines;

  return (
    <details className={`${cardClass} mb-5 p-4`}>
      <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium text-foreground">
        <BookOpenIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
        راهنمای کوتاه این مرحله
      </summary>
      <ul className="mt-3 space-y-1.5 text-sm leading-6 text-muted-foreground">
        {lines.map((line) => (
          <li key={line} className="flex gap-2">
            <span aria-hidden="true" className="text-primary">
              •
            </span>
            <span>{line}</span>
          </li>
        ))}
      </ul>
      {published?.guide.slug ? (
        <Link
          href={`/knowledge/a/${published.guide.slug}`}
          className="mt-3 inline-block text-xs text-primary hover:underline"
        >
          مطالعهٔ راهنمای کامل در مرکز آموزش
        </Link>
      ) : null}
    </details>
  );
}
