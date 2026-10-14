"use client";

/**
 * «فضای کار حسابداری» — the ledger workspace's landing page (`/accounting/ledger`).
 *
 * The sidebar's long ledger disclosure — sixteen rows, a chevron and a
 * remembered open/closed state — became one ordinary menu link, and this page
 * is where that link lands. It is an *index*, not a second ledger: the tools
 * keep their own routes, gates and screens, and this page lists them the way
 * an accountant divides the work (دفتر و اسناد، دریافتنی و پرداختنی، وجوه و
 * هزینه، دوره، مالیات و حقوق) — the divisions `LEDGER_WORKSPACE_SUBGROUPS`
 * already defines, with membership and canonical hrefs from the same
 * definitions the menu used.
 *
 * The list is permission-filtered through `ledgerWorkspaceToolGroups` — the
 * same `accountingSectionsFor` helper the menu and the page gates read — so a
 * member without `payroll.view` sees no payroll card here, and the section's
 * own route still refuses a hand-typed URL. PageShell and the «فضای کار
 * حسابداری» heading come from `AccountingPageBody`, which also draws the
 * `ledger.view` door before this component ever renders.
 */

import {
  DestinationCard,
  EmptyState,
  SectionCard,
} from "@/app/dashboard/page-chrome";
import { ACCOUNTING_SECTION_ICONS } from "./accounting-icons";
import { accountingSectionHeading } from "./accounting-headings";
import { ledgerWorkspaceToolGroups } from "./accounting-workspace";
import type { AccountingSectionKey } from "./accounting-routes";

export function LedgerWorkspaceSection({ permissions }: { permissions: ReadonlySet<string> }) {
  const groups = ledgerWorkspaceToolGroups(permissions);

  if (groups.length === 0) {
    return (
      <EmptyState title="ابزاری برای نمایش نیست">
        نقش شما به هیچ‌یک از ابزارهای دفترداری دسترسی ندارد؛ برای دسترسی با مدیر کسب‌وکار تماس
        بگیرید.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <SectionCard key={group.key} title={group.label}>
          <div className="grid gap-3 sm:grid-cols-2">
            {group.entries.map((entry) => {
              const key = entry.section as AccountingSectionKey;
              return (
                <DestinationCard
                  key={entry.href}
                  href={entry.href}
                  title={entry.label}
                  description={accountingSectionHeading(key).description}
                  icon={ACCOUNTING_SECTION_ICONS[key]}
                />
              );
            })}
          </div>
        </SectionCard>
      ))}
    </div>
  );
}
