"use client";

/**
 * The business workspace shell.
 *
 * Wraps every `/platform/businesses/{id}/…` section: one data provider (see
 * context.tsx), a persistent identity header (name, status, live tenant URL,
 * plan, quick lifecycle buttons), and the section tabs. The console sidebar
 * mirrors these same tabs as a sub-menu, so the operator can navigate the
 * workspace from either side; the strip below keeps the sections reachable on
 * mobile where the sidebar collapses.
 */
import Link from "next/link";
import { allowedLifecycleTransitions } from "@/lib/platform-business-lifecycle";
import { BusinessDataProvider, useBusiness } from "./context";
import { businessSections } from "./sections";
import {
  Button,
  ErrorBox,
  InfoBox,
  PlanBadge,
  SkeletonRows,
  StatusBadge,
  SubNav,
  useCapabilities,
} from "../../ui";

function Workspace({ children }: { children: React.ReactNode }) {
  const { id, business, loading, error, notice, setNotice, changeStatus, rootDomain } =
    useBusiness();
  const caps = useCapabilities();
  const sections = businessSections(id, caps);

  const tabs = sections.map((s) => ({
    label: s.label,
    href: s.href,
    exact: s.href === `/platform/businesses/${id}`,
  }));

  // The moves this operator may actually make from the *current* status. The
  // capability belongs to the transition (archived -> active needs
  // `business.archive`), so the header cannot derive it from the target alone.
  const lifecycle = business ? allowedLifecycleTransitions(business.status, caps) : [];

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Link
          href="/platform/businesses"
          className="text-sm text-sky-700 dark:text-sky-300 hover:underline"
          aria-label="بازگشت به فهرست کسب‌وکارها"
        >
          ← فهرست کسب‌وکارها
        </Link>
        <span className="text-muted-foreground" aria-hidden>
          /
        </span>
        <h1 className="text-xl font-bold">{business?.name ?? "…"}</h1>
        {business ? <StatusBadge status={business.status} /> : null}
        {business ? <PlanBadge plan={business.plan} /> : null}
        {business?.subdomain && rootDomain ? (
          <a
            href={`https://${business.subdomain}.${rootDomain}`}
            target="_blank"
            rel="noreferrer"
            dir="ltr"
            className="text-xs text-muted-foreground underline-offset-4 hover:text-sky-700 dark:hover:text-sky-300 hover:underline"
          >
            {business.subdomain}.{rootDomain}
          </a>
        ) : null}
        {lifecycle.map((t, index) => (
          <Button
            key={`${t.from}-${t.to}`}
            variant="ghost"
            className={index === 0 ? "ms-auto" : undefined}
            onClick={() => void changeStatus(t.to, t.label)}
          >
            {t.label}
          </Button>
        ))}
      </div>

      <SubNav items={tabs} />

      <ErrorBox>{error}</ErrorBox>
      {notice ? (
        <InfoBox>
          <div className="flex items-start justify-between gap-3">
            <span>{notice}</span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              className="text-muted-foreground hover:text-foreground"
              aria-label="بستن پیام"
            >
              ✕
            </button>
          </div>
        </InfoBox>
      ) : null}

      {loading ? (
        <SkeletonRows rows={3} />
      ) : !business ? (
        <ErrorBox>این کسب‌وکار پیدا نشد؛ ممکن است حذف شده باشد.</ErrorBox>
      ) : (
        children
      )}
    </div>
  );
}

export default function BusinessWorkspaceLayout({ children }: { children: React.ReactNode }) {
  return (
    <BusinessDataProvider>
      <Workspace>{children}</Workspace>
    </BusinessDataProvider>
  );
}
