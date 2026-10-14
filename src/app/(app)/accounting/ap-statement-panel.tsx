"use client";

/**
 * A supplier's full A/P activity (bills + payments + returns) with a running
 * balance.
 *
 * The panel itself lives once in `subledger-section.tsx`, shared with the A/R
 * mirror; this wrapper is the A/P side of it under the prop shape the
 * directory (`parties-section.tsx`) opens it with — an A/P statement is
 * addressed by the supplier's *branch alias* (`supplierId`), with the party
 * carried separately for the «اشخاص» deep link.
 */
import { PAYABLES_SIDE } from "./ap-section";
import { SubledgerStatementPanel } from "./subledger-section";

export function ApStatementPanel({
  supplierId,
  supplierName,
  supplierPartyId,
  supplierLocationName,
  onClose,
}: {
  supplierId: string;
  supplierName: string;
  /** The party behind the branch alias — what a deep link into «اشخاص» is keyed by. Null for the unattributed bucket. */
  supplierPartyId: string | null;
  /** Location context when opened from the business-wide party directory. */
  supplierLocationName?: string | null;
  onClose: () => void;
}) {
  return (
    <SubledgerStatementPanel
      side={PAYABLES_SIDE}
      id={supplierId}
      name={supplierName}
      partyId={supplierPartyId}
      locationName={supplierLocationName}
      onClose={onClose}
    />
  );
}
