import type { Party } from "./parties-service";

export interface PartyReadAccess {
  /** May read personnel identity/contact fields for Employee files. */
  personnelSensitive: boolean;
  /** May read ledger-owned accounting and banking fields. */
  financial: boolean;
}

/**
 * Field-level projection for the shared party API.
 *
 * `parties.view` intentionally powers low-trust customer pickers. It therefore
 * cannot imply access to an Employee's personnel identity or anybody's banking
 * details. Keeping this projection at the HTTP boundary lets internal accounting
 * services continue to use the complete domain record while every generic API
 * consumer receives only fields its authenticated member may read.
 */
export function projectPartyForRead(party: Party, access: PartyReadAccess): Partial<Party> {
  const projected = { ...party } as Partial<Party> & Record<string, unknown>;

  if (!access.financial) {
    delete projected.financialInfo;
    delete projected.accountingCode;
    delete projected.accountingCodeMode;
    const general = projected.generalInfo;
    if (general && typeof general === "object") {
      const safeGeneral = { ...(general as Record<string, unknown>) };
      delete safeGeneral.taxPercentage;
      projected.generalInfo = safeGeneral as Party["generalInfo"];
    }
  }

  if (party.roles.includes("Employee") && !access.personnelSensitive) {
    delete projected.phone;
    delete projected.email;
    delete projected.address;
    delete projected.notes;
    delete projected.addressInfo;
    delete projected.contactInfo;
    delete projected.birthday;
    const general = projected.generalInfo;
    if (general && typeof general === "object") {
      const safeGeneral = { ...(general as Record<string, unknown>) };
      delete safeGeneral.nationalId;
      delete safeGeneral.economicCode;
      projected.generalInfo = safeGeneral as Party["generalInfo"];
    }
  }

  return projected;
}

export function projectPartiesForRead(parties: Party[], access: PartyReadAccess): Partial<Party>[] {
  return parties.map((party) => projectPartyForRead(party, access));
}
