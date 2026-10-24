"use client";

import dynamic from "next/dynamic";
import { createContext, useCallback, useContext, useMemo, useState } from "react";

const BugReportDialog = dynamic(
  () => import("./bug-report-dialog").then((module) => module.BugReportDialog),
  { ssr: false },
);

/**
 * Bug reporting provider — manual reporting only.
 * Shake detection removed per #945 Phase 5; bug report is now only via
 * explicit UI action (sidebar entry / menu). No device-motion listeners
 * or permission prompts are registered. The dialog remains lazy-loaded and
 * mounts only while open.
 */

interface BugReportContextValue {
  openReport: () => void;
}

const BugReportContext = createContext<BugReportContextValue | null>(null);

export function useBugReport(): BugReportContextValue {
  const ctx = useContext(BugReportContext);
  if (!ctx) throw new Error("useBugReport must be used within a <BugReportProvider>");
  return ctx;
}

export function BugReportProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);

  const openReport = useCallback(() => {
    setOpen(true);
  }, []);

  const value = useMemo<BugReportContextValue>(() => ({ openReport }), [openReport]);

  return (
    <BugReportContext.Provider value={value}>
      {children}
      {open ? (
        <BugReportDialog open onOpenChange={setOpen} capturing={capturing} onCapturingChange={setCapturing} />
      ) : null}
    </BugReportContext.Provider>
  );
}
