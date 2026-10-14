/**
 * The party directory is business-wide, while A/P statements are keyed by a
 * per-location supplier alias. A party can therefore map to a single alias
 * only when exactly one alias exists; choosing the first of several would
 * silently open the wrong branch's ledger. The payables subledger presents all
 * such aliases separately with their location context.
 */
export interface SupplierAliasRef {
  supplierId: string;
  locationName: string | null;
}

export function uniqueSupplierAliasByParty(
  aliases: readonly { supplierId: string; supplierPartyId: string | null; locationName?: string | null }[],
): Record<string, SupplierAliasRef> {
  const aliasesByParty = new Map<string, SupplierAliasRef[]>();
  for (const alias of aliases) {
    if (!alias.supplierPartyId) continue;
    const refs = aliasesByParty.get(alias.supplierPartyId) ?? [];
    refs.push({ supplierId: alias.supplierId, locationName: alias.locationName ?? null });
    aliasesByParty.set(alias.supplierPartyId, refs);
  }
  return Object.fromEntries(
    [...aliasesByParty].filter(([, refs]) => refs.length === 1).map(([partyId, refs]) => [partyId, refs[0]]),
  );
}
