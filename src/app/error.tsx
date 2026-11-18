"use client";

import { ErrorPanel } from "@/components/error-panel";

/**
 * The root boundary — the last resort, for a render error anywhere below the
 * root layout (fonts, theme and providers are already mounted, so this can
 * stay a plain page).
 *
 * It is now a thin wrapper over `ErrorPanel`, which also serves the two realm
 * boundaries: `(app)/error.tsx` (inside the tenant shell) and
 * `platform/error.tsx` (the operator console). The recipe — error ID,
 * redacted technical log, export, retry — lives once in the panel, so the
 * realms cannot drift from it and a fix here reaches them.
 */
export default function Error({
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
      title="خطایی پیش آمد"
      description="مشکلی در نمایش این صفحه رخ داد. گزارش آن ثبت شد؛ می‌توانید دوباره تلاش کنید یا به صفحهٔ اصلی بازگردید."
      homeHref="/"
      homeLabel="بازگشت به صفحهٔ اصلی"
      as="main"
      // Kept from the root boundary's first release: a support agent may
      // already ask a user for this filename.
      logPrefix="pos-error-log"
    />
  );
}
