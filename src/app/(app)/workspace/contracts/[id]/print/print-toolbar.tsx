"use client";

/**
 * The print view's only interactive part.
 *
 * `window.print()` is the whole "export PDF" implementation on purpose: the
 * browser's own print pipeline produces a real, paginated PDF of the A4 sheet in
 * the same process that rendered it, and the repo already owns the font and the
 * RTL rules here. Shipping a second PDF generator for one screen would be the
 * duplicate printing framework issue #908 explicitly forbids.
 */
import { PrinterIcon } from "lucide-react";

export function PrintToolbar({ title }: { title: string }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 print:hidden">
      <p className="text-sm text-muted-foreground">
        پیش‌نمایش چاپ — «چاپ» را بزنید و در پنجرهٔ چاپ، «ذخیره به‌صورت PDF» را انتخاب کنید.
      </p>
      <button
        type="button"
        onClick={() => window.print()}
        className="inline-flex h-10 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        <PrinterIcon className="me-1.5 size-4" aria-hidden />
        چاپ {title}
      </button>
    </div>
  );
}
