import type { ReactNode } from "react";
import { InfoBox } from "@/app/dashboard/ui";
import { fiscalReadinessNotice, type FiscalReadiness } from "@/lib/fiscal-readiness";

/**
 * The F08 warning: shown wherever the books could be mistaken for "ready to
 * close" while no fiscal year covers today or some entries sit outside every
 * period. Presentational — the section that renders it owns the fetch (and
 * its skeleton); a failed readiness read shows nothing rather than a guess.
 */
export function FiscalReadinessBanner({
  readiness,
  action,
}: {
  readiness: FiscalReadiness | null;
  action?: ReactNode;
}) {
  const notice = readiness ? fiscalReadinessNotice(readiness) : null;
  if (!notice) return null;
  return (
    <InfoBox>
      <p className="font-semibold">{notice.title}</p>
      {notice.lines.map((line) => (
        <p key={line} className="mt-1 text-xs leading-5">
          {line}
        </p>
      ))}
      {action ? <div className="mt-2">{action}</div> : null}
    </InfoBox>
  );
}
