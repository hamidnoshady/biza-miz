import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_ROLES, SETUP_CREATABLE_ROLES } from "@/lib/roles";

/**
 * The wiring invariants of the persons directory, the team screen, and the
 * user section — the seams no other harness reaches.
 *
 * The repo's vitest runs in Node with no jsdom and no `@testing-library`
 * (see accounting-nav-rtl.test.ts), and the cookie-session API routes cannot
 * be invoked outside a Next request store (see the withTenantScope doc
 * comment in auth.ts) — so the pure rules these screens obey already live in
 * framework-free modules and are unit-tested there (`resolveMemberLocationAssignment`
 * in team.test.ts, `partiesSectionAbilities` in parties-scopes.test.ts,
 * `directoryFilterCategories` in party-directory.test.ts), and the database
 * behaviour is pinned in integration/team and integration/parties.
 *
 * What only grepping the sources can hold is the *wiring*: that the screen
 * sends what the route accepts, that a rename reaches the personnel file but a
 * suspend does not, that the pre-rename CRM addresses are redirects rather
 * than a second copy of the screen, that the wizard offers every role its
 * route will create, and that the label maps and permission-threading this
 * cleanup deduplicated do not quietly grow back.
 */

const here = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const TEAM_MANAGER = here("./team-manager.tsx");
const TEAM_API = here("../../api/team/route.ts");
const TEAM_SERVICE = here("../../../lib/team-service.ts");
const PERSONNEL_FILE = here("../../../lib/personnel-file.ts");
const MEMBER_API = here("../../api/team/[id]/route.ts");
const CREDENTIALS_API = here("../../api/team/[id]/credentials/route.ts");
const SETUP_USERS_API = here("../../api/setup/users/route.ts");
const SETUP_USERS_PAGE = here("../../setup/users/page.tsx");
const PERSONS_ALIAS_INDEX = here("../../(app)/crm/customers/page.tsx");
const PERSONS_ALIAS_FILE = here("../../(app)/crm/customers/[id]/page.tsx");
const PARTIES_SECTION = here("../parties/parties-section.tsx");

/** Every .ts/.tsx under a directory, recursively — the design-lint walk. */
function sourcesUnder(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) out.push(...sourcesUnder(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const APP_SOURCES = sourcesUnder(dirname(fileURLToPath(import.meta.url)) + "/../..");

describe("the team screen sends what the API accepts", () => {
  it("edits the name, role, branches, default branch and overrides in one PATCH", () => {
    // The editor's save body and the route's accepted body must name the same
    // keys — before, the API accepted all of it and the screen offered a role
    // picker alone, so a name or branch change meant delete + re-add.
    for (const key of ["fullName", "role", "permissions", "locationIds", "defaultLocationId"]) {
      expect(TEAM_MANAGER, `team-manager sends ${key}`).toContain(key);
      expect(MEMBER_API, `the member route accepts ${key}`).toContain(key);
    }
  });

  it("resets credentials through the route that owns them", () => {
    expect(TEAM_MANAGER).toContain("/credentials");
    expect(TEAM_MANAGER).toContain("{ pin }");
    expect(TEAM_MANAGER).toContain("send_password_reset");
    expect(TEAM_MANAGER).toContain("revoke_sessions");
    expect(TEAM_MANAGER).not.toContain("JSON.stringify({ password })");
    // The route is the one that decides owner-vs-self rules; the screen must
    // not invent its own write path.
    expect(CREDENTIALS_API).toContain("body.pin !== undefined");
    expect(CREDENTIALS_API).toContain("body.password !== undefined");
    expect(CREDENTIALS_API).toContain("cross_user_password_reset_forbidden");
  });

  it("assigns branches from the list the API returned with the members", () => {
    expect(TEAM_API).toContain("listBranches");
    expect(TEAM_API).toContain("locations:");
    expect(TEAM_MANAGER).toContain("member.locationIds");
  });
});

describe("the personnel file follows the membership, and every door writes it", () => {
  it("propagates a rename from the membership row, never from the body", () => {
    /*
     * The rename guard used to live in the route (`const renameTo = body.fullName?.trim()`)
     * and was the fix for a PATCH that omitted a name stamping the party blank. The
     * guard's *job* moved into the guarantee: the route forwards whatever the body
     * said (or nothing), the service writes the row first, and the file is derived
     * from the row that was written — so an omitted name is simply not a value the
     * propagation can ever see, whatever door the edit came through.
     */
    expect(MEMBER_API).toContain("fullName: body.fullName");
    expect(TEAM_SERVICE).toContain("full_name   = coalesce($4, full_name)");
    expect(PERSONNEL_FILE).toContain("displayName: (member.full_name ?? \"\").trim()");
  });

  it("has one writer for the file, called by the membership service", () => {
    /*
     * Issue #947 (TEAM-F04). The file used to be created by whichever door
     * remembered to: `POST /api/team` called `ensureEmployeeParty`, the setup
     * wizard and the invitation finaliser each had their own writer, and the IAM
     * replica had a third. Two of those doors had no writer at all, so a member
     * created through them owned no personnel file — no payroll row could hang off
     * them. The single guarantee now lives in `personnel-file.ts` and the routes do
     * not write parties themselves; this asserts the two halves of that: the
     * service calls it, and the member route no longer reaches for the old
     * per-route writer.
     */
    expect(TEAM_SERVICE).toContain("ensurePersonnelFileForMembership");
    expect(MEMBER_API).not.toContain("ensureEmployeeParty");
    expect(TEAM_API).not.toContain("ensureEmployeeParty");
  });

  it("tells the member card whether the file exists or is still owed", () => {
    // F04/F05 surface: the guarantee is either true or visibly owed, and the
    // roster is where an owner sees which.
    expect(TEAM_API).toContain("listPersonnelFileDrift");
    expect(TEAM_API).toContain("retryPersonnelFileDrift");
    expect(TEAM_MANAGER).toContain("personnelFileId");
    expect(TEAM_MANAGER).toContain("personnelFileDrift");
  });
});

describe("the branch policy is chosen, not inferred (issue #947, TEAM-F03)", () => {
  it("sends an explicit branch policy from the PIN-staff form", () => {
    /*
     * The form used to send role/name/PIN/phone and nothing else, and
     * `createMembership`'s INSERT ended in `ELSE 'all'` — so every PIN member
     * created here silently received every branch of the business, with no
     * `user_locations` row to show for it.
     */
    expect(TEAM_MANAGER).toContain("locationScope,");
    expect(TEAM_MANAGER).toContain('locationIds: locationScope === "selected" ? branchIds : []');
    expect(TEAM_MANAGER).toContain('defaultLocationId: locationScope === "home" ? defaultLocationId : null');
    expect(TEAM_API).toContain("locationScope: isLocationScope(body.locationScope)");
  });

  it("leaves no SQL arm that can widen a policy by omission", () => {
    // The decision itself lives in location-access.ts and is unit-tested; what
    // this holds is that the service no longer carries a second, wider one.
    expect(TEAM_SERVICE).not.toContain("ELSE 'all'::location_scope");
    expect(TEAM_SERVICE).toContain("resolveMembershipBranchPolicy");
  });

  it("does not claim the PIN is unique per branch", () => {
    // `isPinTaken` compares across the business and the keyed blind index enforces
    // it business-wide; the old hint said the opposite.
    expect(TEAM_MANAGER).not.toContain("در هر شعبه باید یکتا باشد");
    expect(TEAM_MANAGER).toContain("در کل کسب‌وکار یکتاست");
  });
});

describe("a read-only visit does not request what it may not read (TEAM-F06)", () => {
  it("gates the invitations read on team.manage", () => {
    // GET /api/team accepts team.view OR team.manage; /api/team/invitations needs
    // team.manage. Asking for both unconditionally put a 403 about invitations —
    // which the reader never requested — above a roster that had loaded fine.
    expect(TEAM_MANAGER).toContain('"/api/team/invitations"');
    expect(TEAM_MANAGER).toContain("canManage");
    // The refusal is read as a *partial* failure, not as a broken page: the
    // roster loaded, and the sentence says so.
    expect(TEAM_MANAGER).toContain("if (!invitesRes) {");
    expect(TEAM_MANAGER).toContain("بقیهٔ این صفحه کامل بارگذاری شده است");
  });
});

describe("the pre-rename CRM addresses are redirects, not a second screen", () => {
  it("answers /crm/customers with a redirect to /crm/persons", () => {
    expect(PERSONS_ALIAS_INDEX).toContain("redirect(");
    expect(PERSONS_ALIAS_INDEX).toContain('crmSectionHref("persons")');
    // A second copy of the picker/file is the bug this alias replaced.
    expect(PERSONS_ALIAS_INDEX).not.toContain("CustomerPicker");
    expect(PERSONS_ALIAS_INDEX).not.toContain("CustomerFileSection");
  });

  it("answers /crm/customers/<id> with a redirect to the one file page", () => {
    expect(PERSONS_ALIAS_FILE).toContain("redirect(");
    expect(PERSONS_ALIAS_FILE).toContain("crmCustomerHref(id)");
    expect(PERSONS_ALIAS_FILE).not.toContain("CustomerFileSection");
  });
});

describe("the setup wizard and its route agree on the creatable roles", () => {
  it("derives the list from the catalogue instead of restating it", () => {
    /*
     * The wizard used to hold three separate copies of "which roles can be
     * created here": an inline `options` array in the page, a `CreatableRole`
     * union beside it, and a `CREATABLE_ROLES` array in the route. The first
     * copy was already missing «حسابدار» while the route would happily create
     * one — the screen refused what the API accepted — and when `admin` and
     * `viewer` were added, all three fell behind at once.
     *
     * Both sides now read `SETUP_CREATABLE_ROLES`, so the question is asked in
     * exactly one place and the two cannot disagree again.
     */
    expect(SETUP_USERS_PAGE).toContain("SETUP_CREATABLE_ROLES");
    expect(SETUP_USERS_API).toContain("SETUP_CREATABLE_ROLES");
    expect(SETUP_USERS_PAGE, "no hand-written role options").not.toMatch(
      /options=\{\[\s*\{\s*value:\s*"manager"/,
    );
  });

  it("can create every role except the owner, who already exists", () => {
    expect(SETUP_CREATABLE_ROLES).not.toContain("owner");
    for (const role of ALL_ROLES.filter((r) => r !== "owner")) {
      expect(SETUP_CREATABLE_ROLES, role).toContain(role);
    }
  });

  it("gates the email fields on the shared password-role rule, not one role", () => {
    // `role === "manager"` was the bug's shape: a second password role (or a
    // renamed one) silently lost its email/password path.
    expect(SETUP_USERS_API).toContain("isPasswordRole(role)");
    expect(SETUP_USERS_API).not.toContain('role === "manager"');
    expect(SETUP_USERS_PAGE).toContain("needsEmail");
  });

  it("folds Persian digits out of the PIN before the shape check", () => {
    // The wizard's numeric pad emits Persian glyphs; the team route folds them
    // and the wizard must not be the one door that rejects «۱۲۳۴».
    expect(SETUP_USERS_API).toContain("toLatinDigits");
  });
});

describe("the deduplicated definitions stay deduplicated", () => {
  it("declares ROLE_LABELS in exactly one place", () => {
    // Nine screens used to carry their own copy and they drifted (the wizard's
    // had already lost «حسابدار»). role-labels.ts is the one definition;
    // PARTY_ROLE_LABELS and PLATFORM_ROLE_LABELS are different domains and
    // stay in their own modules.
    const redeclares = APP_SOURCES.filter(
      (file) =>
        !file.endsWith("role-labels.ts") &&
        /const ROLE_LABELS\s*[:=]/.test(readFileSync(file, "utf8")),
    );
    expect(redeclares).toEqual([]);
  });

  it("reads its labels through the shared helper, not a local map", () => {
    expect(TEAM_MANAGER).toContain('from "@/lib/role-labels"');
    expect(TEAM_MANAGER).not.toMatch(/const ROLE_LABELS/);
  });

  it("threads the member's permissions into every party-directory mount", () => {
    // Every screen that mounts the shared section passes `permissions`, so
    // the buttons follow the member's real rights rather than the role
    // presets. A new mount that forgets is the bug this catches.
    const mounts = APP_SOURCES.filter((file) =>
      readFileSync(file, "utf8").includes("<PartiesSection"),
    );
    expect(mounts.length).toBeGreaterThanOrEqual(4);
    const missing = mounts.filter(
      (file) => !readFileSync(file, "utf8").includes("permissions={"),
    );
    expect(
      missing,
      "these mounts draw buttons from role presets instead of the member's effective permissions",
    ).toEqual([]);
  });

  it("keeps the section's ability fallback in the shared scope module", () => {
    // The rule (effective permissions when known, presets when not) is one
    // definition in parties-scopes.ts; the section composes it with its own
    // readOnly scope, and neither re-derives it inline.
    expect(PARTIES_SECTION).toContain("partiesSectionAbilities(");
    expect(PARTIES_SECTION).not.toMatch(/MANAGING_ROLES|LEDGER_ROLES/);
  });
});

describe("the personnel directory is gated on parties.view (issue #854 pass 4)", () => {
  it("renders the team-scoped directory only behind canViewParties", () => {
    // `/api/parties` enforces `parties.view`, which a team manager's grant
    // need not include. The Team screen hides the personnel file for such a
    // member instead of mounting a section that only ever answers 403 — and
    // the permission itself is not widened to avoid the error.
    expect(TEAM_MANAGER).toContain("canViewParties");
    const gated =
      /canViewParties\(role, permissions\)\s*\?\s*\([\s\S]*?پروندهٔ کارکنان[\s\S]*?<PartiesSection scope=\{partyScopeFor\("team"\)\}/.test(
        TEAM_MANAGER,
      );
    expect(gated).toBe(true);
    // The gate must not be bypassed by an unconditional second mount.
    const mounts = TEAM_MANAGER.match(/<PartiesSection/g) ?? [];
    expect(mounts.length).toBe(1);
  });

  it("keeps the view gate in the shared scope module, not re-derived inline", () => {
    expect(TEAM_MANAGER).toContain('from "@/lib/parties-scopes"');
    expect(TEAM_MANAGER).not.toMatch(/includes\(\s*(PERMISSIONS\.)?(partiesView|"parties\.view")\s*\)/);
  });
});

describe("lifecycle-derived member actions (issue #854 pass 4, gap 4)", () => {
  it("offers suspend/reactivate only to non-offboarded members and rehire only to offboarded ones", () => {
    // Offboarding removed the identity linkage; a bare «فعال‌سازی» would
    // restore a doorless membership. The buttons are therefore derived from
    // the lifecycle state instead of offered side by side.
    const suspendOrReactivate = /member\.status !== "offboarded"\)\s*\?\s*<SecondaryButton[\s\S]*?\{(member\.isActive \? "تعلیق" : "فعال‌سازی")\}/.test(
      TEAM_MANAGER,
    );
    expect(suspendOrReactivate).toBe(true);

    const rehire = /member\.status === "offboarded"\)\s*\?\s*<SecondaryButton[\s\S]*?بازگشت به کار/.test(
      TEAM_MANAGER,
    );
    expect(rehire).toBe(true);

    // Offboarding itself stays a distinct, non-offboarded action.
    expect(TEAM_MANAGER).toContain('member.status !== "offboarded") ? <SecondaryButton');
  });

  it("rehire goes through its own ceremony endpoint with a mandatory reason, not the membership PATCH", () => {
    expect(TEAM_MANAGER).toContain("/api/team/${member.id}/rehire");
    // The dialog is the only path to that endpoint — no fire-and-forget fetch.
    expect(TEAM_MANAGER).toMatch(/RehireDialog/);
    // Client-side minimum before submission mirrors the route's requirement.
    expect(TEAM_MANAGER).toContain("دلیل این تغییر را بنویسید (حداقل ۸ نویسه)");
  });

  it("the rehire route enforces the ceremony server-side", () => {
    const REHIRE_API = here("../../api/team/[id]/rehire/route.ts");
    // Both gates: the general team-write permission and the permissions-
    // management one, because a rehire re-grants a stored role + grant.
    expect(REHIRE_API).toContain("requirePermission(PERMISSIONS.teamManage)");
    expect(REHIRE_API).toContain("PERMISSIONS.teamPermissionsManage");
    // It delegates to the service ceremony — not an unlocked state flip.
    expect(REHIRE_API).toContain("rehireMembership");
    // The ceremony itself holds the membership row lock and takes a reason.
    expect(TEAM_SERVICE).toContain("FOR UPDATE");
    expect(TEAM_SERVICE).toContain("validateAccessChangeReason");
    const AUTHORITY = here("../../../lib/membership-authority.ts");
    expect(AUTHORITY).toContain("reason_required");
  });

  it("the offboard confirmation names rehire as the way back", () => {
    expect(TEAM_MANAGER).toContain("بازگشت دوبارهٔ همین شخص با «بازگشت به کار»");
  });
});
