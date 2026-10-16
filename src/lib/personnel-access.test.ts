import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FULL_PARTY_AUDIENCE,
  PARTY_FINANCIAL_PERMISSIONS,
  PARTY_FINANCIAL_PRESET_ROLES,
  PERSONNEL_READ_PERMISSION_HINT,
  PERSONNEL_RESTRICTED_COLUMNS,
  SENSITIVE_PERSONNEL_PERMISSIONS,
  SENSITIVE_PERSONNEL_PRESET_ROLES,
  canReadSensitivePersonnel,
  partyReadAudienceForPermissions,
  partyReadAudienceForRole,
  restrictPartyColumnsForAudience,
} from "./personnel-access";
import { ALL_PERMISSIONS, effectivePermissions, roleBasePermissions } from "./permissions";
import { ALL_ROLES } from "./roles";
import { PARTIES_PRESET_LEDGER_ROLES } from "./parties-scopes";

/**
 * Issue #947 (TEAM-F01) — the policy that decides whether the sensitive half of a
 * personnel file may leave the server.
 *
 * These are the tests the issue asks for in the negative direction: «a cashier or
 * customer reader cannot obtain the restricted Employee identifiers or banking data
 * through the collection, item, search or AI reads». The serialization that applies
 * this audience is exercised in `integration/parties.integration.test.ts` against a
 * real row; what is pinned here is the *decision*, and — more importantly — that the
 * decision keeps agreeing with the permission catalogue it claims to mirror. The
 * table in `personnel-access.ts` is prose; without these cases a preset edit (a new
 * key added to the cashier, `team.view` moved into the manager) would reopen the hole
 * silently, which is exactly how the original defect survived review.
 */

/** The role presets' effective sets, the way `authorize()` resolves them. */
function presetPermissions(role: (typeof ALL_ROLES)[number]): string[] {
  return [...effectivePermissions(role, {}, null)];
}

describe("party read audience (issue #947, TEAM-F01)", () => {
  it("names only real catalogue permissions", () => {
    for (const key of [...SENSITIVE_PERSONNEL_PERMISSIONS, ...PARTY_FINANCIAL_PERMISSIONS]) {
      expect(ALL_PERMISSIONS, `${key} is a catalogue permission`).toContain(key);
    }
    expect(SENSITIVE_PERSONNEL_PERMISSIONS).toContain(PERSONNEL_READ_PERMISSION_HINT);
  });

  it("gives the sensitive audience to exactly the administrative presets", () => {
    /*
     * The rule, checked one way and then the other: every preset this module claims
     * may read personnel data must actually hold one of the keys, and every preset it
     * claims may not must not hold one by accident.
     */
    for (const role of ALL_ROLES) {
      const held = presetPermissions(role);
      const mayRead = SENSITIVE_PERSONNEL_PERMISSIONS.some((key) => held.includes(key));
      expect(
        mayRead,
        `${role} preset ${SENSITIVE_PERSONNEL_PRESET_ROLES.includes(role) ? "may" : "may not"} read personnel fields`,
      ).toBe(SENSITIVE_PERSONNEL_PRESET_ROLES.includes(role));
    }
  });

  it("keeps the cashier, waiter and kitchen presets out of staff files", () => {
    // The finding's own example: the till holds `parties.view` (it must — the
    // checkout looks customers up) and must still not read national IDs or IBANs.
    for (const role of ["cashier", "waiter", "kitchen"] as const) {
      const held = presetPermissions(role);
      const audience = partyReadAudienceForRole(role);
      expect(audience.personnel, `${role} reads no personnel file`).toBe(false);
      // Whoever can read the directory is the population the finding is about, so
      // the case is only meaningful for a role that actually holds the key.
      if (held.includes("parties.view")) {
        expect(held, `${role} holds the directory key`).toContain("parties.view");
      }
    }
    // The till is the one that holds both the directory and no personnel key.
    expect(presetPermissions("cashier")).toContain("parties.view");
    expect(presetPermissions("cashier")).not.toContain("ledger.view");
    expect(partyReadAudienceForRole("cashier")).toEqual({ personnel: false, financial: false });
  });

  it("keeps the manager preset out of staff files, and says why in the catalogue", () => {
    /*
     * The one deliberate exclusion. A manager may run the floor and the catalogue's
     * own records show they hold neither `team.*` nor `payroll.*`; a business that
     * wants them to read the roster or payroll grants one of those keys, and then the
     * *effective set* — not the role name — opens the fields. Pinned because it is the
     * case a later reader is most likely to "fix" by adding manager to the preset list.
     */
    const held = presetPermissions("manager");
    expect(held.filter((key) => (SENSITIVE_PERSONNEL_PERMISSIONS as readonly string[]).includes(key))).toEqual([]);
    expect(partyReadAudienceForRole("manager").personnel).toBe(false);
    // …but the bank block is a different question with a different key, and the
    // manager has held `ledger.view` since before these columns existed.
    expect(held).toContain("ledger.view");
    expect(partyReadAudienceForRole("manager").financial).toBe(true);
  });

  it("opens the fields for the accountant (payroll) and the team administrator", () => {
    expect(presetPermissions("accountant")).toContain("payroll.view");
    expect(partyReadAudienceForRole("accountant")).toEqual({ personnel: true, financial: true });
    expect(partyReadAudienceForRole("owner")).toEqual(FULL_PARTY_AUDIENCE);
    expect(partyReadAudienceForRole("admin")).toEqual(FULL_PARTY_AUDIENCE);
  });

  it("follows the effective set, not the role name", () => {
    // A cashier granted `team.view` (a small business where the till also
    // administers staff) reads the fields…
    expect(partyReadAudienceForRole("cashier", ["parties.view", "team.view"]).personnel).toBe(true);
    // …and an admin whose overrides revoked `payroll.view` still reads them through
    // `team.manage`; the set is a union on purpose, not a single key.
    expect(partyReadAudienceForPermissions(["team.manage"]).personnel).toBe(true);
    // A revocation that leaves nothing is a revocation: the projection narrows.
    expect(partyReadAudienceForPermissions(["parties.view"]).personnel).toBe(false);
  });

  it("treats a known-but-empty set as «nothing», not as «unspecified»", () => {
    /*
     * The distinction `partyReadAudienceForRole` exists for. `undefined` means "this
     * caller's grants have not been resolved" and falls back to the preset table;
     * `[]` means "resolved, and they hold nothing", which must answer no. Reading the
     * two the same way is how a screen renders a field the server then redacts.
     */
    expect(partyReadAudienceForRole("owner", [])).toEqual({ personnel: false, financial: false });
    expect(partyReadAudienceForRole("owner", null)).toEqual(FULL_PARTY_AUDIENCE);
    expect(canReadSensitivePersonnel("owner", [])).toBe(false);
    expect(canReadSensitivePersonnel("owner")).toBe(true);
  });

  it("keeps the financial answer tied to the key its writes already need", () => {
    // The bank tab is gated `ledger.view` on the write (`accountingFieldsIn`), so a
    // reader without it must not read it either — otherwise the projection is wider
    // than the mutation gate next to it.
    expect(PARTY_FINANCIAL_PERMISSIONS).toEqual(["ledger.view"]);
    for (const role of ALL_ROLES) {
      const holds = presetPermissions(role).includes("ledger.view");
      expect(partyReadAudienceForRole(role).financial, `${role} bank block`).toBe(holds);
      /*
       * The preset fallback may be *narrower* than the catalogue (an unknown caller
       * is answered conservatively) but never wider: a role this list names must
       * actually hold the key, or a screen would render a tab the route redacts.
       */
      if (PARTY_FINANCIAL_PRESET_ROLES.includes(role)) {
        expect(holds, `${role} preset list agrees with the catalogue`).toBe(true);
      }
    }
  });

  it("agrees with the party screens' preset list about the ledger key", () => {
    /*
     * `parties-scopes.ts` answers the same financial question for the *buttons*
     * (`partiesSectionAbilities`). Two lists, one rule: this one must not withhold a
     * tab the screens draw, so it has to be at least as wide as theirs — and every
     * role either list names has to actually hold the key, or a screen would draw a
     * field the route redacts.
     */
    for (const role of PARTIES_PRESET_LEDGER_ROLES) {
      expect(PARTY_FINANCIAL_PRESET_ROLES, `${role} in both lists`).toContain(role);
    }
    expect(PARTY_FINANCIAL_PRESET_ROLES).toContain("admin");
  });

  it("agrees with the catalogue about which presets hold each key", () => {
    // A last guard on the two hand-written preset arrays: every role they name holds
    // a key that grants the same answer, so the fallback can only ever be *narrower*
    // than the real decision — never wider.
    for (const role of SENSITIVE_PERSONNEL_PRESET_ROLES) {
      const held = presetPermissions(role as (typeof ALL_ROLES)[number]);
      expect(held.some((key) => (SENSITIVE_PERSONNEL_PERMISSIONS as readonly string[]).includes(key))).toBe(true);
    }
    expect(roleBasePermissions("manager").length).toBeGreaterThan(0);
    expect(roleBasePermissions("accountant")).toContain("payroll.view");
  });
});


/**
 * The bulk readers — the data-transfer adapters and the Holoo persons workbook — never
 * build a `Party`: they read flattened rows. These cases pin the flat half of the same
 * rule, so «what an export writes» cannot drift from «what the screen shows».
 */
describe("the flat projection the exports read through (issue #947, TEAM-F01)", () => {
  const employeeRow = {
    id: "11111111-1111-1111-1111-111111111111",
    name: "کارمند",
    phone: "+989120000000",
    nationalId: "0084575980",
    economicCode: "411222333444",
    address: "تهران، خیابان",
    notes: "یادداشت منابع انسانی",
    accountingCode: "1201",
  };

  it("names the columns the wire projection withholds, one set rather than two", () => {
    /*
     * The serialized list is paths (`generalInfo.nationalId`, in `parties-service.ts`);
     * the row list is columns. Both describe one decision, so every column has to be the
     * last segment of some path — an export that withheld fewer fields than the screen
     * would be a way around the screen. Read from the source rather than imported,
     * because that module reaches the database and this suite is a pure one.
     */
    const source = readFileSync(new URL("./parties-service.ts", import.meta.url), "utf8");
    const block = /export const PERSONNEL_RESTRICTED_FIELDS: readonly string\[\] = \[(.*?)\];/s.exec(source);
    expect(block, "the path list is where this test says it is").not.toBeNull();
    const paths = [...block![1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    expect(paths.length).toBeGreaterThan(0);
    const segments = paths.map((path) => path.split(".").pop()!);
    for (const column of PERSONNEL_RESTRICTED_COLUMNS) {
      expect(segments, `${column} is named by a restricted path`).toContain(column);
    }
    // And nothing is withheld in the flat reading that the screen still draws.
    for (const segment of segments) {
      expect(PERSONNEL_RESTRICTED_COLUMNS, `${segment} is withheld in both readings`).toContain(segment);
    }
  });

  it("blanks those columns on an Employee row for a caller without the personnel answer", () => {
    const projected = restrictPartyColumnsForAudience(employeeRow, { personnel: false, financial: true }, true);
    expect(projected).toMatchObject({
      nationalId: "",
      economicCode: "",
      address: "",
      notes: "",
    });
    // The columns an export legitimately needs are untouched: the file is narrowed, not
    // emptied, and the party's accounting identity survives.
    expect(projected.name).toBe("کارمند");
    expect(projected.phone).toBe("+989120000000");
    expect(projected.accountingCode).toBe("1201");
    // A copy, so the caller's own row object is not mutated under them.
    expect(employeeRow.nationalId).toBe("0084575980");
  });

  it("leaves the row whole for the personnel answer, and for anyone but an Employee file", () => {
    expect(restrictPartyColumnsForAudience(employeeRow, FULL_PARTY_AUDIENCE, true)).toBe(employeeRow);
    // The restriction is about Employee *files*: the same columns on a customer are
    // ordinary CRM data, and a manager exporting customers keeps their addresses.
    expect(
      restrictPartyColumnsForAudience(employeeRow, { personnel: false, financial: true }, false),
    ).toBe(employeeRow);
  });

  it("keeps a null null, so an absent column stays absent rather than becoming «»", () => {
    const row: Record<string, unknown> = { id: "x", nationalId: null, notes: null };
    const projected = restrictPartyColumnsForAudience(row, { personnel: false, financial: true }, true);
    expect(projected).toEqual({ id: "x", nationalId: null, notes: null });
  });
});
