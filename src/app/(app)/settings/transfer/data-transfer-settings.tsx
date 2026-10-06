"use client";

/**
 * «ورود و خروج داده» — the settings tab the three sections hang off.
 *
 * One `TabBar` over import / export / history, which is the shape the rest of
 * the settings area uses for a section with a few distinct jobs. The entity
 * catalogue is fetched once here and handed down, so the three panels agree
 * about what this member may move — and so switching tabs does not re-fetch
 * the same list.
 */

import { useCallback, useEffect, useState } from "react";
import { SectionCard, TabBar, type Tab } from "@/app/dashboard/page-chrome";
import { ErrorBox, api } from "@/app/dashboard/ui";
import { DataTransferSkeleton, useDataCatalogue } from "./data-transfer-ui";
import { ExportSection } from "./export-section";
import { HistorySection } from "./history-section";
import { ImportSection } from "./import-section";
import { HolooTransferSection } from "./holoo-transfer-section";

type PanelKey = "import" | "export" | "history" | "holoo";

export function DataTransferSettings() {
  const { entities, canImport, error } = useDataCatalogue();
  // The history reloads when an import is queued or an export produced, so the
  // operator sees their own action land without pressing refresh.
  const [revision, setRevision] = useState(0);
  const bump = useCallback(() => setRevision((current) => current + 1), []);
  const [panel, setPanel] = useState<PanelKey>("import");
  const [holooPermitted, setHolooPermitted] = useState(false);

  useEffect(() => {
    if (entities === null) {
      setHolooPermitted(false);
      return;
    }
    let mounted = true;
    void api<Record<string, unknown>>("/api/data/providers/holoo").then((result) => {
      if (mounted) setHolooPermitted(result.ok);
    });
    return () => { mounted = false; };
  }, [entities]);

  const tabs: Tab<PanelKey>[] = [
    ...(canImport ? [{ key: "import" as const, label: "ورود اطلاعات" }] : []),
    { key: "export", label: "خروجی گرفتن" },
    { key: "history", label: "تاریخچه" },
    ...(holooPermitted ? [{ key: "holoo" as const, label: "انتقال هلو" }] : []),
  ];
  const active = tabs.some((tab) => tab.key === panel) ? panel : (tabs[0]?.key ?? "export");

  if (entities === null && !error) return <DataTransferSkeleton />;

  return (
    <div className="space-y-6">
      {error ? <ErrorBox>{error}</ErrorBox> : null}

      <SectionCard
        title="ورود و خروج داده"
        description="یک جای واحد برای وارد کردن و خروجی گرفتن اطلاعات همهٔ بخش‌ها: مشتریان، منو، انبار، حسابداری، وب‌سایت و میز کار. دسترسی‌ها همان دسترسی‌های خود آن بخش‌هاست."
      >
        <TabBar
          idPrefix="data-transfer"
          label="بخش‌های ورود و خروج داده"
          tabs={tabs}
          active={active}
          onChange={setPanel}
        />
      </SectionCard>

      {active === "import" ? <ImportSection entities={entities} onJobQueued={bump} /> : null}
      {active === "export" ? <ExportSection entities={entities} onExported={bump} /> : null}
      {active === "history" ? (
        <HistorySection canImport={canImport} revision={revision} />
      ) : null}
      {active === "holoo" && holooPermitted ? <HolooTransferSection /> : null}
    </div>
  );
}
