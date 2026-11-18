"use client";

import { ErrorPanel } from "@/components/error-panel";

/**
 * The tenant realm's boundary.
 *
 * A Next.js `error.tsx` replaces the failing segment, not its layouts, and this
 * one sits inside `(app)/layout.tsx` — so `WorkspaceShell` stays mounted: the
 * sidebar, the app switcher and the business context survive while only the
 * failed page is replaced. That is the point of having it: before this file a
 * render failure anywhere in the 112 tenant routes was caught by the *root*
 * boundary and the member lost the whole shell, with only a link to `/`.
 *
 * The copy and the way back are the realm's own; the behaviour (error ID,
 * redacted report, export, retry) is `ErrorPanel`'s.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <ErrorPanel
      error={error}
      reset={reset}
      minHeightClass="min-h-[60vh]"
      title="خطایی در این صفحه پیش آمد"
      description="مشکلی در نمایش این بخش رخ داد و گزارش آن ثبت شد. می‌توانید دوباره تلاش کنید یا به خانهٔ دستیار بازگردید؛ بقیهٔ منوها همچنان در دسترس‌اند."
      homeHref="/dashboard"
      homeLabel="بازگشت به خانهٔ دستیار"
      logPrefix="app-error-log"
    />
  );
}
