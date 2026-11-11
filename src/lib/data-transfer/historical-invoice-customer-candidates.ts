/**
 * Read-only hints for an operator linking an imported customer code. The
 * caller supplies customer rows it is authorized to see in the current tenant.
 * A hint is never a binding, even when a phone is verified or the match is unique.
 * Only bindHistoricalCustomer may persist the operator's explicit decision.
 */
import { normalizeNameKey, normalizePhoneKey } from "../import-reconciliation/normalize";
import { resolveParty, type CanonicalParty, type PartyContext } from "../import-reconciliation/resolvers";

export interface HistoricalCustomerCandidate {
  partyId: string;
  name: string;
  matchedOn: ("phone" | "name")[];
}

export function historicalCustomerCandidates(input: {
  sourceName?: string | null;
  sourcePhone?: string | null;
  customers: readonly CanonicalParty[];
  limit?: number;
}): { candidates: HistoricalCustomerCandidate[]; truncated: boolean } {
  // Building the indexes from an already tenant-scoped set is intentional:
  // this function must never query across tenants or bypass field permissions.
  const canonicalById = new Map(input.customers.filter((p) => p.roles.includes("customer") && !p.isArchived && !p.isGuest).map((p) => [p.id, p]));
  const customers = [...canonicalById.values()];
  const candidatesByPhone = new Map<string, CanonicalParty[]>();
  const candidatesByName = new Map<string, CanonicalParty[]>();
  for (const customer of customers) {
    const name = normalizeNameKey(customer.name);
    if (name) {
      const hits = candidatesByName.get(name) ?? [];
      hits.push(customer);
      candidatesByName.set(name, hits);
    }
    for (const phone of new Set(customer.phones.map(normalizePhoneKey).filter((key): key is string => key !== null))) {
      const hits = candidatesByPhone.get(phone) ?? [];
      hits.push(customer);
      candidatesByPhone.set(phone, hits);
    }
  }
  const ctx: PartyContext = { mappings: new Map(), canonicalById, candidatesByPhone, candidatesByName,
    candidatesByEmail: new Map(), incomingPhoneCounts: new Map() };
  const matches = new Map<string, HistoricalCustomerCandidate>();
  for (const [kind, value] of [["phone", input.sourcePhone], ["name", input.sourceName]] as const) {
    if (!value?.trim()) continue;
    const resolution = resolveParty({ domain: "party", externalId: null, name: kind === "name" ? value : null,
      phone: kind === "phone" ? value : null, role: "customer" }, ctx);
    for (const ref of resolution.candidates) {
      const candidate = matches.get(ref.id) ?? { partyId: ref.id, name: ref.label, matchedOn: [] };
      candidate.matchedOn.push(kind);
      matches.set(ref.id, candidate);
    }
  }
  const all = [...matches.values()].sort((a, b) => a.name.localeCompare(b.name, "fa") || a.partyId.localeCompare(b.partyId));
  const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(Math.trunc(input.limit!), 100)) : 20;
  return { candidates: all.slice(0, limit), truncated: all.length > limit };
}
