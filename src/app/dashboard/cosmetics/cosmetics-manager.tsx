"use client";

/**
 * Phase 42 — the cosmetics page keeps only the sections this trade alone has
 * (بچ‌ها و انقضا، برند و ماتریس). The catalogue itself moved to the shared
 * products workspace («محصولات» in the sidebar), so the old «کالاها» tab — the
 * VariantsSection board — is gone from here rather than duplicated.
 *
 * The «گزارش‌ها» tab is gone for the same reason: it was a second, poorer copy
 * of «تحلیل فروش تنوع‌ها», a report that already exists in the report library
 * («گزارش‌های آماده» → `variant_sales`), beside this trade's other two
 * («فروش به تفکیک برند» and «بچ‌های نزدیک انقضا»). Two doors onto the same
 * numbers meant one of them had no date range, no chart, no export and no
 * pinning — so reading a cosmetics report depended on which door you happened
 * to open. The library is now the only door; the page header links to it.
 */
import { useState } from "react";
import { IndustryManagerShell } from "../industry-manager-shell";
import { BatchesSection } from "./batches-section";
import { MerchandisingSection } from "./merchandising-section";

const TABS = [
  { key: "batches", label: "بچ‌ها و انقضا" },
  { key: "merchandising", label: "برند و ماتریس" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export function CosmeticsManager() {
  // Sections own their reads and error boxes; the shell contract still wants
  // an error slot above the strip.
  const error = "";
  const [tab, setTab] = useState<TabKey>("batches");

  return (
    <div data-tour-id="cosmetics.workspace">
    <IndustryManagerShell
      idPrefix="cosmetics"
      navLabel="بخش‌های آرایشی و بهداشتی"
      tabs={TABS}
      activeTab={tab}
      onTabChange={setTab}
      error={error}
    >
      {tab === "batches" ? <BatchesSection /> : null}
      {tab === "merchandising" ? <MerchandisingSection /> : null}
    </IndustryManagerShell>
    </div>
  );
}
