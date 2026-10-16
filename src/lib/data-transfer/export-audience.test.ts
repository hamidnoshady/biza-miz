import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, effectivePermissions } from "../permissions";
import { ALL_ROLES } from "../roles";
import {
  LEGACY_EXPORT_AUDIENCE,
  decideExportDownload,
  recordedAudienceFor,
  type CurrentExportAccess,
  type RecordedExportAudience,
} from "./export-audience";
import { FULL_PARTY_AUDIENCE } from "../personnel-access";

/**
 * The stored-export decision (issue #947, revisited).
 *
 * The first pass narrowed an export *at production time* and reported the stored-file
 * case as a known limitation. This suite is the case that limitation described, and it
 * is written as a matrix rather than as a handful of examples because the whole risk is
 * a combination: what was recorded (an audience, nothing, or a set of keys) crossed with
 * what the member holds now. Every cell has one right answer, and the wrong answer is
 * silent — a wider read that looks like a download.
 *
 * The preset rows matter as much as the hand-made ones: they are the shapes real
 * members have, and «the manager exported it and then lost the key» is not a thought
 * experiment, it is the revocation path this product actually has.
 */

const NARROW: CurrentExportAccess = {
  partyAudience: { personnel: false, financial: false },
  permissions: new Set<string>(),
};

function accessFor(role: (typeof ALL_ROLES)[number]): CurrentExportAccess {
  const permissions = effectivePermissions(role, {}, null);
  return {
    partyAudience: {
      personnel: permissions.has("team.view") || permissions.has("team.manage") ||
        permissions.has("payroll.view") || permissions.has("payroll.manage"),
      financial: permissions.has("ledger.view"),
    },
    permissions,
  };
}

const recorded = (input: Partial<RecordedExportAudience>): RecordedExportAudience => ({
  partyAudience: null,
  domainKeys: null,
  ...input,
});

describe("the stored export's audience (issue #947)", () => {
  it("names a legacy file's audience as the widest one — never as «no permission needed»", () => {
    /*
     * The direction is the whole point. A row produced before this column existed was
     * produced by an engine that returned everything, so `null` must read as «everything»,
     * which refuses; reading it as «nothing sensitive» would hand a pre-#947 file to the
     * first caller who asked for it and make the fix cosmetic.
     */
    expect(LEGACY_EXPORT_AUDIENCE).toEqual(FULL_PARTY_AUDIENCE);
    // The audience decides, not the permission set: `ALL_PERMISSIONS` handed in with a
    // narrow *audience* is still a narrow reader, which is exactly the distinction that
    // keeps this function from being fooled by a caller that resolved one and not the
    // other.
    expect(decideExportDownload(recorded({}), NARROW).allowed).toBe(false);
    // A reader who genuinely holds the whole record — the owner preset — is the one who
    // can take an unprovenanced file.
    expect(decideExportDownload(recorded({}), accessFor("owner")).allowed).toBe(true);
    expect(effectivePermissions("owner", {}, null).size).toBe(ALL_PERMISSIONS.length);
  });

  it("refuses a legacy file to a reader who cannot read everything it may contain", () => {
    for (const role of ["manager", "cashier", "waiter", "kitchen"] as const) {
      const decision = decideExportDownload(recorded({}), accessFor(role));
      expect(decision.allowed, `legacy file vs ${role}`).toBe(false);
      if (!decision.allowed) expect(decision.reason).toBe("legacy_provenance");
    }
    // And to somebody holding the bulk keys but not the personnel ones: the *audience*
    // is the question, not the export capability.
    const bulkOnly: CurrentExportAccess = {
      partyAudience: { personnel: false, financial: true },
      permissions: new Set(["data.export", "crm.export", "parties.view", "ledger.view"]),
    };
    const decision = decideExportDownload(recorded({}), bulkOnly);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.requires).toContain("team.view");
  });

  it("lets a file in under a revocation be re-downloaded by whoever may still read it", () => {
    // The revocation path: produced by a member who held the personnel answer, now read
    // by one who does not. Same bytes, different members.
    const file = recorded({ partyAudience: { personnel: true, financial: true } });
    expect(decideExportDownload(file, accessFor("admin")).allowed).toBe(true);
    expect(decideExportDownload(file, accessFor("accountant")).allowed).toBe(true);
    const manager = decideExportDownload(file, accessFor("manager"));
    expect(manager.allowed).toBe(false);
    if (!manager.allowed) {
      expect(manager.reason).toBe("audience_revoked");
      // The refusal names the keys, so the screen can say which one an owner would grant.
      expect(manager.requires).toEqual(expect.arrayContaining(["team.view", "team.manage"]));
    }
  });

  it("treats the two halves as separate answers, not as one knob", () => {
    const financialOnly = recorded({ partyAudience: { personnel: false, financial: true } });
    // The accountant preset holds `ledger.view` but no `team.view`: a financial-only file
    // is theirs, and refusing it would be a false positive that makes the whole check
    // look arbitrary.
    expect(decideExportDownload(financialOnly, accessFor("accountant")).allowed).toBe(true);
    expect(decideExportDownload(financialOnly, accessFor("cashier")).allowed).toBe(false);
    // The other direction: staff-file-only bytes are not opened by a ledger key alone.
    const personnelOnly = recorded({ partyAudience: { personnel: true, financial: false } });
    const ledgerOnly: CurrentExportAccess = {
      partyAudience: { personnel: false, financial: true },
      permissions: new Set(["ledger.view", "data.export", "crm.export"]),
    };
    expect(decideExportDownload(personnelOnly, ledgerOnly).allowed).toBe(false);
  });

  it("requires every recorded domain key to still be held", () => {
    const file = recorded({
      partyAudience: { personnel: false, financial: false },
      domainKeys: ["parties.view", "crm.export", "purchases.manage"],
    });
    const holdsAll: CurrentExportAccess = {
      partyAudience: { personnel: true, financial: true },
      permissions: new Set(["parties.view", "crm.export", "purchases.manage"]),
    };
    expect(decideExportDownload(file, holdsAll).allowed).toBe(true);

    const lostOne: CurrentExportAccess = {
      partyAudience: { personnel: true, financial: true },
      permissions: new Set(["parties.view", "crm.export"]),
    };
    const decision = decideExportDownload(file, lostOne);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("domain_keys_revoked");
      expect(decision.requires).toEqual(["purchases.manage"]);
    }
  });

  it("reads «no domain keys recorded» as «nothing extra required», not as «everything»", () => {
    // A key list is a *requirement* list: the absent case is an empty requirement, and
    // the party audience is what carries the sensitivity for a non-provider export. If
    // this arm were inverted, every ordinary CRM export would become undownloadable.
    const file = recorded({ partyAudience: { personnel: true, financial: true }, domainKeys: null });
    expect(decideExportDownload(file, accessFor("admin")).allowed).toBe(true);
    const emptyKeys = recorded({ partyAudience: { personnel: true, financial: true }, domainKeys: [] });
    expect(decideExportDownload(emptyKeys, accessFor("admin")).allowed).toBe(true);
  });

  it("checks the domain keys before the party halves, so a provider file cannot be half-read", () => {
    const file = recorded({
      partyAudience: { personnel: true, financial: true },
      domainKeys: ["parties.view"],
    });
    const decision = decideExportDownload(file, {
      partyAudience: { personnel: false, financial: false },
      permissions: new Set<string>(),
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      // Both are missing; the reported reason is the first gate, and the *requires* list
      // is what a screen shows, so it still names the domain key.
      expect(decision.requires).toContain("parties.view");
    }
  });

  it("records provenance honestly, including «not resolved»", () => {
    expect(recordedAudienceFor(undefined)).toBeNull();
    expect(recordedAudienceFor({ personnel: true, financial: false })).toEqual({
      personnel: true,
      financial: false,
    });
    // A copy, not the caller's object: the row must not be able to change under us.
    const source = { personnel: true, financial: true };
    const stored = recordedAudienceFor(source);
    expect(stored).not.toBe(source);
  });
});
