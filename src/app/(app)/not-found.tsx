import { NotFoundPanel } from "@/components/not-found-panel";

/**
 * The tenant realm's 404 — for a `notFound()` thrown inside the signed-in
 * shell, and for an unknown path beneath it.
 *
 * It renders inside `(app)/layout.tsx`, so the member keeps the sidebar and the
 * app switcher; only the missing page's area is replaced. The way back is the
 * assistant home, which every member can open regardless of which app they
 * were in.
 */
export default function AppNotFound() {
  return (
    <NotFoundPanel
      description="صفحه‌ای که خواستید وجود ندارد یا جابه‌جا شده است. منوها همچنان در دسترس‌اند."
      homeHref="/dashboard"
      homeLabel="بازگشت به خانهٔ دستیار"
    />
  );
}
