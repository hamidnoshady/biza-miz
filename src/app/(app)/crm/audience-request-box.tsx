"use client";

/**
 * «چه کسانی را می‌خواهید؟» — the spoken way into the audience builder.
 *
 * The box reads a Persian sentence through `interpretAudienceRequest` and shows
 * exactly what it understood: the clauses, written in the builder's own words,
 * and the words it could not read. The button that hands the rules to the
 * builder's form appears **only when every word was read** — a sentence with one
 * unknown word would otherwise create a segment that is missing the part the
 * member cared about, with a count that looks authoritative anyway.
 *
 * Two deliberate omissions:
 *
 * - **No count here.** The count belongs to `previewSegment`, which the builder
 *   calls — one SQL path, one number, and the consent arithmetic stays in the
 *   place that already documents it. This box composes rules, not queries.
 * - **No create button here.** It seeds the form; the form is still the only
 *   writer, so the segment a member ends up with is one they have seen in full
 *   before saving.
 */

import { useMemo, useState } from "react";
import { SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMoney } from "@/components/money/money-context";
import {
  AUDIENCE_REQUEST_EXAMPLES,
  describeAudienceRequest,
  interpretAudienceRequest,
} from "@/lib/crm-audience-request";
import type { SegmentDefinition } from "@/lib/segments";
import { Field, inputClass } from "@/app/dashboard/ui";
import { SectionCard } from "@/app/dashboard/page-chrome";
import { CrmCardHeading } from "./crm-card-heading";

export function AudienceRequestBox({
  onSeed,
}: {
  /** Hands the understood rules to the builder. Never saves anything by itself. */
  onSeed: (definition: SegmentDefinition) => void;
}) {
  const money = useMoney();
  const [sentence, setSentence] = useState("");

  const interpretation = useMemo(() => interpretAudienceRequest(sentence), [sentence]);
  const clauses = useMemo(
    () => describeAudienceRequest(interpretation, (rial) => money.format(rial)),
    [interpretation, money],
  );

  // An empty box has not misunderstood anything, so it says nothing yet — and
  // a two-letter half-typed word would otherwise flash a refusal on every key.
  const asked = sentence.trim().length >= 3;
  const refused = asked && !interpretation.ok;

  return (
    <SectionCard
      title={<CrmCardHeading kicker="جمله به شرط" title="درخواست بخش با یک جمله" />}
      description="بنویسید چه کسانی را می‌خواهید؛ همین‌جا می‌بینید چه چیزی خوانده شد. شرط‌ها فقط از واژگان فرم بخش انتخاب می‌شوند و به فرم ریخته می‌شوند تا پیش از ذخیره، شمار مشتریان را در همان‌جا ببینید."
    >
      <div className="space-y-3">
        <Field
          label="جملهٔ درخواست"
          hint="مثال: «ساکن تهران و ۹۰ روز است خرید نکرده‌اند». اگر واژه‌ای خوانده نشود، همان واژه بازگردانده می‌شود و بخشی ساخته نمی‌شود."
        >
          <div className="relative">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-muted-foreground"
            />
            <input
              className={`${inputClass} ps-9`}
              value={sentence}
              onChange={(event) => setSentence(event.target.value)}
              placeholder="مثلاً: بیش از ۱ میلیون تومان خرید کرده‌اند و ایمیل دارند"
              aria-label="درخواست بخش با جمله"
            />
          </div>
        </Field>

        <div className="flex flex-wrap items-center gap-1">
          <span className="text-xs text-muted-foreground">نمونه:</span>
          {AUDIENCE_REQUEST_EXAMPLES.map((example) => (
            <Button
              key={example}
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setSentence(example)}
            >
              {example}
            </Button>
          ))}
        </div>

        {asked ? (
          <div className="space-y-3 border-t border-border/80 pt-3">
            {clauses.length > 0 ? (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  این شرط‌ها خوانده شد:
                </p>
                <ul className="list-inside list-disc space-y-1 text-sm leading-6">
                  {clauses.map((clause, index) => (
                    <li key={`${clause}|${index}`}>{clause}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-sm leading-6 text-muted-foreground">
                هیچ شرطی از این جمله خوانده نشد.
              </p>
            )}

            {interpretation.unread.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs font-medium text-destructive">
                  این واژه‌ها خوانده نشد:
                </p>
                <ul className="flex flex-wrap gap-1">
                  {interpretation.unread.map((word, index) => (
                    <li
                      key={`${word}|${index}`}
                      className="rounded-xl border border-destructive/30 bg-destructive/5 px-2.5 py-1 text-xs text-foreground"
                    >
                      {word}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {interpretation.notes.map((note) => (
              <p key={note} className="text-xs leading-6 text-muted-foreground">
                {note}
              </p>
            ))}

            {interpretation.ok ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => onSeed(interpretation.definition)}
                >
                  ریختن در فرم بخش
                </Button>
                <span className="text-xs text-muted-foreground">
                  شرط‌ها در فرم باز می‌شوند؛ پیش‌نمایش و ذخیره همان‌جا انجام می‌شود.
                </span>
              </div>
            ) : refused ? (
              <p className="text-xs leading-6 text-muted-foreground">
                تا وقتی واژه‌ای خوانده نشده، این جمله به فرم نمی‌رود: بخشی که شرطی
                از آن کم داشته باشد، شمرده می‌شود و درست به نظر می‌رسد.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}
