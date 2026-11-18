"use client";

import { ErrorPanel } from "@/components/error-panel";

/**
 * The Superadmin console's boundary.
 *
 * The console is a separate visual identity, but a failure is the one moment
 * where the operator needs the *same* dependable recovery as a tenant: a
 * quotable error ID, a redacted technical report and a retry. Before this
 * file a render failure here fell through to the tenant-facing root boundary,
 * whose link goes to `/` — a tenant surface — and whose copy says «صفحهٔ
 * اصلی», which for an operator is not where they were working.
 *
 * The way back is the console root, not the tenant dashboard.
 */
export default function PlatformError({
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
      title="خطایی در کنسول مدیریت رخ داد"
      description="مشکلی در نمایش این بخش از کنسول رخ داد و گزارش آن ثبت شد. می‌توانید دوباره تلاش کنید یا به فهرست کسب‌وکارها بازگردید."
      homeHref="/platform"
      homeLabel="بازگشت به کنسول مدیریت"
      logPrefix="platform-error-log"
    />
  );
}
