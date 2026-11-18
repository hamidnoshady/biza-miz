import { NotFoundPanel } from "@/components/not-found-panel";

/**
 * The root 404 — any URL the app has no route for.
 *
 * Renders inside the root layout, so it mounts its own `<main>` and the
 * canvas; the panel itself is the shared one (`(app)/not-found.tsx` uses it
 * too). Before this file Next answered with its default page, which is not a
 * product surface at all.
 */
export default function NotFound() {
  return (
    <main className="min-h-screen bg-background">
      <NotFoundPanel
        description="نشانی‌ای که باز کردید وجود ندارد یا جابه‌جا شده است."
        homeHref="/"
        homeLabel="بازگشت به صفحهٔ اصلی"
      />
    </main>
  );
}
