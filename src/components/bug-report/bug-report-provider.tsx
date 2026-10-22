"use client";

import dynamic from "next/dynamic";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { useShakeDetection } from "./use-shake";

const BugReportDialog = dynamic(
  () => import("./bug-report-dialog").then((module) => module.BugReportDialog),
  { ssr: false },
);

/**
 * Bug reporting, wired once around the dashboard.
 *
 * Two ways in, one dialog out:
 *   - shake the phone (device motion),
 *   - the small bug icon at the bottom of the sidebar.
 *
 * The provider owns the dialog's open state and the "is a screenshot being
 * captured" flag. `useBugReport()` lets the sidebar footer open the dialog
 * without knowing the plumbing.
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

  const { requestPermission } = useShakeDetection(() => {
    setOpen(true);
  });

  const openReport = useCallback(() => {
    // iOS requires a user gesture to enable device motion; tapping any report
    // control doubles as that gesture, so shake starts working from then on.
    void requestPermission();
    setOpen(true);
  }, [requestPermission]);

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
