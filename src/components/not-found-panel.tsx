import Link from "next/link";
import { CompassIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader, PageShell, SectionCard } from "@/app/dashboard/page-chrome";

/**
 * The one 404 surface, shared by the root boundary and the tenant realm.
 *
 * Before this, the product had **no** `not-found.tsx` at all: a mistyped or
 * retired URL — a bookmark to a section that moved, a truncated share link —
 * rendered Next's default 404, which is unstyled, Latin, outside the design
 * system, and offers no way back into the app. That was the most visible
 * uncovered state in the product (see docs/design/route-audit.md §6.2, S2).
 *
 * It composes the primitives rather than restating them: `PageHeader` supplies
 * the page's `<h1>` and rule, `SectionCard` the surface, and `EmptyState`'s
 * rich shape the icon chip, title and recovery action. The Persian copy names
 * what happened and what to do next — the design system's rule for an empty
 * region ("say what will be here, with a leading verb") applies to a 404 as
 * much as to an empty list.
 *
 * Two callers pass their own way back in: the root boundary cannot assume a
 * session, so it offers `/` (which resolves to the login or the assistant
 * home); `(app)/not-found.tsx` sits behind the auth guard and offers the
 * assistant home directly.
 */
export function NotFoundPanel({
  description,
  homeHref,
  homeLabel,
}: {
  description: string;
  homeHref: string;
  homeLabel: string;
}) {
  return (
    <PageShell className="px-4 py-8 sm:px-6 sm:py-10">
      <PageHeader title="این صفحه پیدا نشد" description={description} />
      <SectionCard bodyClassName="p-0">
        <EmptyState
          icon={CompassIcon}
          title="نشانی معتبر نیست"
          action={
            <Link href={homeHref}>
              <Button>{homeLabel}</Button>
            </Link>
          }
        >
          از منوی برنامه‌ها بخش موردنظر را باز کنید. اگر این نشانی را ذخیره کرده بودید، بخش
          جابه‌جا شده است و از همین منو در دسترس است.
        </EmptyState>
      </SectionCard>
    </PageShell>
  );
}
