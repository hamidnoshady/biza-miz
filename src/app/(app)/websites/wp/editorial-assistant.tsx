"use client";

/**
 * «دستیار تحریریه» — the platform AI drafting a post or page with the editor
 * (issue #1215, P2‑5).
 *
 * The contract this panel keeps, in the same words the product-copy draft uses:
 *
 *  - **It reads what the editor holds.** Every action but «طرح کلی» is given the
 *    unsaved title, body and excerpt the human is looking at, not the copy last
 *    synced from the site — improving text nobody can see would be a mystery.
 *  - **Nothing is saved by the model.** The suggestion lands in this panel; it
 *    reaches a field only when the owner presses a button here, and reaches the
 *    *site* only through the editor's ordinary save with its version check.
 *  - **A refusal is named.** No AI configured, an empty wallet, a paused
 *    connection, or nothing to work on each say so plainly instead of failing
 *    with a raw code.
 */
import { useState } from "react";
import { SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, ErrorBox, inputClass } from "@/app/dashboard/ui";
import {
  EDITORIAL_ACTIONS,
  EDITORIAL_ACTION_LABELS,
  EDITORIAL_LANGUAGES,
  EDITORIAL_LANGUAGE_LABELS,
  EDITORIAL_LIMITS,
  EDITORIAL_TONES,
  EDITORIAL_TONE_LABELS,
  type EditorialAction,
  type EditorialLanguage,
  type EditorialTone,
} from "@/lib/editorial-ai";
import { toPersianDigits } from "@/lib/digits";

/** Where a draft for this action belongs in the editor. */
export function draftTarget(action: EditorialAction): "title" | "excerpt" | "content" {
  if (action === "title") return "title";
  if (action === "excerpt") return "excerpt";
  return "content";
}

const TARGET_LABELS = {
  title: "عنوان",
  excerpt: "خلاصه",
  content: "متن",
} as const;

/** Actions whose output replaces the body versus extends it. */
const APPENDS: ReadonlySet<EditorialAction> = new Set(["expand", "body", "outline"]);

export interface EditorialAssistantProps {
  connectionId: string;
  type: "post" | "page";
  title: string;
  content: string;
  excerpt: string;
  /** Editing is blocked while a save is in flight, or when the body could not be read. */
  disabled: boolean;
  /** The body field is editable (the raw HTML arrived from the site). */
  canEditContent: boolean;
  onInsert: (target: "title" | "excerpt" | "content", text: string, mode: "replace" | "append") => void;
}

export function EditorialAssistant({
  connectionId,
  type,
  title,
  content,
  excerpt,
  disabled,
  canEditContent,
  onInsert,
}: EditorialAssistantProps) {
  const [action, setAction] = useState<EditorialAction>("rewrite");
  const [tone, setTone] = useState<EditorialTone>("friendly");
  const [language, setLanguage] = useState<EditorialLanguage>("en");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<{ text: string; action: EditorialAction; costRial: number | null } | null>(null);

  async function generate() {
    setBusy(true);
    setError("");
    setNotice("");
    const response = await api<{
      draft?: { text: string };
      action?: string;
      costRial?: number;
      error?: string;
      message?: string;
    }>("/api/integrations/wp-manager/content/posts/ai", {
      method: "POST",
      body: JSON.stringify({
        connectionId,
        type,
        action,
        title: title.slice(0, EDITORIAL_LIMITS.title),
        content: content.slice(0, EDITORIAL_LIMITS.content),
        excerpt: excerpt.slice(0, EDITORIAL_LIMITS.excerpt),
        instruction: instruction.slice(0, EDITORIAL_LIMITS.instruction),
        ...(action === "tone" ? { tone } : {}),
        ...(action === "translate" ? { language } : {}),
      }),
    });
    setBusy(false);
    if (!response.ok) {
      setError(describeAssistantError(String(response.data?.error ?? ""), response.data?.message));
      setDraft(null);
      return;
    }
    const text = response.data?.draft?.text ?? "";
    if (!text) {
      setError("پاسخ خالی بود؛ دوباره تلاش کنید.");
      setDraft(null);
      return;
    }
    setDraft({
      text,
      action,
      costRial: typeof response.data?.costRial === "number" ? response.data.costRial : null,
    });
  }

  function insert(mode: "replace" | "append") {
    if (!draft) return;
    onInsert(draftTarget(draft.action), draft.text, mode);
    setNotice(
      draftTarget(draft.action) === "content"
        ? "پیش‌نویس در ویرایشگر گذاشته شد؛ هنوز ذخیره نشده است. با «ذخیره» به سایت می‌رود."
        : `پیش‌نویس در فیلد ${TARGET_LABELS[draftTarget(draft.action)]} گذاشته شد؛ هنوز ذخیره نشده است.`,
    );
    setDraft(null);
  }

  const target = draftTarget(draft?.action ?? action);
  const insertionBlocked = disabled || (target === "content" && !canEditContent);
  const lacksMaterial = !title.trim() && !content.trim() && !excerpt.trim();
  const needsTitle = lacksMaterial && (action === "outline" || action === "body");
  const cannotRun = disabled || needsTitle || (lacksMaterial && action !== "outline" && action !== "body");

  return (
    <section className="mb-4 rounded-xl border border-border/70 bg-muted/40 p-3" aria-label="دستیار تحریریه">
      <div className="flex flex-wrap items-center gap-2">
        <SparklesIcon aria-hidden="true" className="size-4 text-primary" />
        <span className="text-sm font-medium">دستیار تحریریه</span>
        <span className="text-[11px] text-muted-foreground">پیش‌نویس می‌سازد؛ چیزی را ذخیره نمی‌کند</span>
      </div>

      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">کار</span>
          <select
            className={`${inputClass} h-9 w-auto min-w-36 text-xs`}
            aria-label="کار دستیار تحریریه"
            value={action}
            disabled={disabled || busy}
            onChange={(event) => {
              setAction(event.target.value as EditorialAction);
              setDraft(null);
              setError("");
              setNotice("");
            }}
          >
            {EDITORIAL_ACTIONS.map((entry) => (
              <option key={entry} value={entry}>
                {EDITORIAL_ACTION_LABELS[entry]}
              </option>
            ))}
          </select>
        </label>

        {action === "tone" ? (
          <label className="text-xs">
            <span className="mb-1 block text-muted-foreground">لحن</span>
            <select
              className={`${inputClass} h-9 w-auto min-w-28 text-xs`}
              aria-label="لحن پیشنهادی"
              value={tone}
              disabled={disabled || busy}
              onChange={(event) => setTone(event.target.value as EditorialTone)}
            >
              {EDITORIAL_TONES.map((entry) => (
                <option key={entry} value={entry}>
                  {EDITORIAL_TONE_LABELS[entry]}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {action === "translate" ? (
          <label className="text-xs">
            <span className="mb-1 block text-muted-foreground">زبان مقصد</span>
            <select
              className={`${inputClass} h-9 w-auto min-w-28 text-xs`}
              aria-label="زبان مقصد ترجمه"
              value={language}
              disabled={disabled || busy}
              onChange={(event) => setLanguage(event.target.value as EditorialLanguage)}
            >
              {EDITORIAL_LANGUAGES.map((entry) => (
                <option key={entry} value={entry}>
                  {EDITORIAL_LANGUAGE_LABELS[entry]}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label className="min-w-48 flex-1 text-xs">
          <span className="mb-1 block text-muted-foreground">دستور (اختیاری)</span>
          <input
            className={`${inputClass} h-9 text-xs`}
            aria-label="دستور به دستیار تحریریه"
            maxLength={EDITORIAL_LIMITS.instruction}
            value={instruction}
            disabled={disabled || busy}
            placeholder="مثلاً: برای مخاطب عمده، بدون اصطلاح فنی"
            onChange={(event) => setInstruction(event.target.value)}
          />
        </label>

        <Button type="button" size="sm" variant="outline" disabled={cannotRun || busy} onClick={() => void generate()}>
          {busy ? "در حال تولید…" : "تولید پیش‌نویس"}
        </Button>
      </div>

      {lacksMaterial ? (
        <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">
          {needsTitle
            ? `برای «${EDITORIAL_ACTION_LABELS[action]}» اول عنوان را بنویسید.`
            : "برای این کار اول عنوان یا متنی بنویسید تا دستیار روی آن کار کند."}
        </p>
      ) : null}

      {error ? (
        <div className="mt-2">
          <ErrorBox>{error}</ErrorBox>
        </div>
      ) : null}
      {notice ? <p className="mt-2 text-[11px] text-muted-foreground">{notice}</p> : null}

      {draft ? (
        <div className="mt-3 space-y-2 rounded-xl border border-border/70 bg-card p-3">
          <p className="text-xs font-medium">
            پیشنهاد «{EDITORIAL_ACTION_LABELS[draft.action]}» — ذخیره‌نشده
            {draft.costRial !== null ? (
              <span className="ms-2 font-normal text-muted-foreground">
                هزینه: {toPersianDigits(draft.costRial)} ریال
              </span>
            ) : null}
          </p>
          <p className="max-h-56 overflow-y-auto whitespace-pre-wrap text-sm leading-7" aria-live="polite">
            {draft.text}
          </p>
          <div className="flex flex-wrap gap-2">
            {target === "content" && !APPENDS.has(draft.action) ? (
              <Button
                type="button"
                size="xs"
                disabled={insertionBlocked}
                onClick={() => insert("replace")}
              >
                جایگزینی متن با این پیش‌نویس
              </Button>
            ) : null}
            {target === "content" ? (
              <Button
                type="button"
                size="xs"
                variant={APPENDS.has(draft.action) ? "default" : "outline"}
                disabled={insertionBlocked}
                onClick={() => insert("append")}
              >
                افزودن به پایان متن
              </Button>
            ) : (
              <Button type="button" size="xs" disabled={insertionBlocked} onClick={() => insert("replace")}>
                گذاشتن در فیلد {TARGET_LABELS[target]}
              </Button>
            )}
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => {
                setDraft(null);
                setNotice("");
              }}
            >
              نادیده گرفتن
            </Button>
          </div>
          {target === "content" && !canEditContent ? (
            <p className="text-[11px] text-amber-700 dark:text-amber-300">
              متن خام این مورد در دسترس نیست، بنابراین پیش‌نویس در فیلد متن گذاشته نمی‌شود.
            </p>
          ) : null}
          <p className="text-[11px] text-muted-foreground">
            تا «ذخیره» را نزنید، هیچ‌چیز به سایت نمی‌رود؛ نسخهٔ فعلی صفحه هم پیش از ذخیره بررسی می‌شود.
          </p>
        </div>
      ) : null}
    </section>
  );
}

/** The route's refusals, in words the writer can act on. */
export function describeAssistantError(code: string, message?: string): string {
  switch (code) {
    case "ai_unavailable":
      return "سرویس هوش مصنوعی هنوز آماده نیست؛ متن را دستی بنویسید.";
    case "ai_credit_required":
      return "اعتبار کیف پول هوش مصنوعی کافی نیست.";
    case "connection_paused":
      return "اتصال این سایت متوقف است؛ تا فعال‌شدن آن پیش‌نویسی ساخته نمی‌شود.";
    case "no_location":
      return "شعبه‌ای ثبت نشده است؛ تنظیمات کسب‌وکار را کامل کنید.";
    case "empty_content":
      return "برای این کار اول عنوان یا متنی بنویسید تا دستیار روی آن کار کند.";
    case "title_required":
      return "برای این کار اول عنوان را بنویسید.";
    case "ai_failed":
      return "تولید پیش‌نویس ناموفق بود؛ دوباره تلاش کنید.";
    default:
      return message || "دستیار تحریریه نتوانست پیش‌نویس بسازد.";
  }
}
