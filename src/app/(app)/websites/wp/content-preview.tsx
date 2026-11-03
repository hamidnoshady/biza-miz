"use client";

/**
 * An approximate preview of a post or page while it is being edited
 * (issue #1215, P2‑5): the owner's own HTML drawn in a sealed frame so they can
 * read what they have written before saving it to the site.
 *
 * Two honest limits, both stated in the panel itself:
 *
 *  - **It is not the site's template.** The mirror holds the post's HTML, not
 *    the theme's CSS, header, sidebar or shortcodes' output, so this shows the
 *    text as it stands — a guide, not a screenshot.
 *  - **Nothing in it can run.** The frame is `sandbox=""` (no scripts, no
 *    forms, no same-origin) and the document carries its own CSP that allows
 *    images and inline styles only, so neither the owner's HTML nor an embedded
 *    widget can reach the app or the network beyond an image request.
 */
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { EyeIcon } from "lucide-react";

/** Escape text that must not be read as markup (the title and the excerpt). */
export function escapePreviewText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The document inside the frame. The body HTML is inserted verbatim on
 * purpose: it is the owner's own stored `post_content`, the same bytes the
 * editor round-trips, and the frame is what keeps it inert.
 */
export function buildPreviewDocument(input: { title: string; content: string; excerpt?: string }): string {
  const title = escapePreviewText(input.title.trim()) || "بدون عنوان";
  const excerpt = input.excerpt?.trim() ? `<p class="lead">${escapePreviewText(input.excerpt.trim())}</p>` : "";
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'; font-src 'none'; script-src 'none'; form-action 'none'; base-uri 'none'">
<meta name="referrer" content="no-referrer">
<style>
  body { margin: 0; padding: 16px; font-family: system-ui, Tahoma, sans-serif; line-height: 1.9; color: #111; background: #fff; }
  h1 { font-size: 1.35rem; line-height: 1.6; margin: 0 0 12px; }
  .lead { color: #444; margin: 0 0 16px; }
  img { max-width: 100%; height: auto; }
  p, ul, ol, blockquote, figure { margin: 0 0 12px; }
  blockquote { border-inline-start: 3px solid #ccc; padding-inline-start: 12px; color: #444; }
  table { border-collapse: collapse; max-width: 100%; }
  td, th { border: 1px solid #ddd; padding: 4px 8px; }
</style>
</head>
<body>
<h1>${title}</h1>
${excerpt}
${input.content}
</body>
</html>`;
}

export interface ContentPreviewProps {
  title: string;
  content: string;
  excerpt?: string;
  /** The body could not be read from the site, so there is nothing to show. */
  editable: boolean;
}

export function ContentPreview({ title, content, excerpt, editable }: ContentPreviewProps) {
  const [open, setOpen] = useState(false);
  const document = useMemo(() => buildPreviewDocument({ title, content, excerpt }), [title, content, excerpt]);

  return (
    <section className="mb-4 rounded-xl border border-border/70 bg-muted/40 p-3" aria-label="پیش‌نمایش نوشته">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <EyeIcon aria-hidden="true" className="size-4 text-primary" />
          <span className="text-sm font-medium">پیش‌نمایش</span>
          <span className="text-[11px] text-muted-foreground">بدون قالب سایت؛ فقط متن و تصویرهای همین نوشته</span>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "بستن پیش‌نمایش" : "نمایش پیش‌نمایش"}
        </Button>
      </div>
      {open ? (
        editable ? (
          // sandbox="" is the load-bearing attribute: no scripts, no forms, no
          // same-origin access, so the stored HTML stays inert.
          <iframe
            title="پیش‌نمایش متن"
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={document}
            className="mt-3 h-80 w-full rounded-lg border border-border/70 bg-card"
          />
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            متن خام این مورد از سایت دریافت نشده است؛ پیش‌نمایشی برای نمایش وجود ندارد.
          </p>
        )
      ) : null}
    </section>
  );
}
