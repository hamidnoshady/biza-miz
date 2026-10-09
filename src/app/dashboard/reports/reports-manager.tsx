"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { SectionNav } from "../section-nav";
import { BranchOverviewSection } from "./branch-overview-section";
import { ReportBuilderSection } from "./report-builder-section";
import { ShiftOrdersSection } from "./shift-orders-section";
import { StandardReportsSection } from "./standard-reports-section";
import { GrowthAccountingView } from "@/components/growth/growth-accounting-view";
import type { ReportCapabilities } from "@/lib/report-permissions";
import { reportsTabsForCapabilities, resolveReportsTab, type ReportsTabKey } from "./reports-nav";

/**
 * The reports workspace.
 *
 * The server page resolves the member's capabilities and passes them down;
 * this component never re-derives them from a role. The `?tab=` value is
 * validated against the *allowed* tabs (issue #819), so a crafted URL cannot
 * render a section the member's capabilities do not include, and client-side
 * query-string navigations are followed only when they land on an allowed tab.
 */
export function ReportsManager({
  capabilities,
  canExplain,
}: {
  capabilities: ReportCapabilities;
  canExplain: boolean;
}) {
  const searchParams = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const tabs = reportsTabsForCapabilities(capabilities);
  // `null` only when the member has no reports capability at all — a state the
  // server page already redirects away — so the fallback is for the type, not
  // for a reachable screen.
  const defaultTab: ReportsTabKey = resolveReportsTab(requestedTab, tabs) ?? "standard";

  // The phone shows the section list first; a `?tab=` link asked for one
  // section by name, so that link opens it rather than the list around it —
  // but only when that section is one of the member's own tabs.
  const [tab, setTab] = useState<ReportsTabKey>(defaultTab);

  // Follow client-side navigations that only changed the query string. An
  // unknown or disallowed value falls back to the first allowed tab rather
  // than to whatever key was typed, which is what keeps a hand-crafted
  // `?tab=branches` from rendering the branch comparison.
  useEffect(() => {
    setTab(resolveReportsTab(requestedTab, tabs) ?? "standard");
    // `tabs` is derived from `capabilities`, which is stable for a render of
    // the page; depending on the array identity would re-run this on every
    // render for no change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedTab]);

  return (
    <SectionNav
      idPrefix="reports"
      label="بخش‌های گزارش‌ها"
      sections={tabs}
      active={tab}
      onChange={setTab}
      className="space-y-5 sm:space-y-6"
    >
      {tab === "standard" ? (
        <StandardReportsSection
          canExplain={canExplain}
          canExport={capabilities.canExportReports}
          canBusinessWide={capabilities.canViewBusinessWide}
        />
      ) : null}
      {tab === "shift-orders" ? (
        <ShiftOrdersSection canExport={capabilities.canExportReports} />
      ) : null}
      {tab === "builder" ? <ReportBuilderSection capabilities={capabilities} /> : null}
      {tab === "growth" ? <GrowthAccountingView /> : null}
      {tab === "branches" && capabilities.canViewBusinessWide ? (
        <BranchOverviewSection canExplain={canExplain} canExport={capabilities.canExportReports} />
      ) : null}
    </SectionNav>
  );
}
