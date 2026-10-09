/**
 * Issue #854 (P1.1 / P2.1 / P2.3 / P2.4 / P2.11) — the screen-level contract
 * around access editing, without rendering React.
 *
 * These are the questions the admin screens have to answer the same way the
 * server does, and each one was wrong before this pass:
 *
 *  - Does a member with only `team.view` get the roster? (P2.1 — they got
 *    nothing, because the tab demanded `team.manage`.)
 *  - Can a member with `team.manage` but *not* `team.permissions.manage` change
 *    capabilities? (P2.4 — the screen offered the controls; the server refused.)
 *  - Does the organization MFA policy have both knobs, and does a write that
 *    names one leave the other alone? (P1.1 — the accountant knob did not exist,
 *    and a one-key `PUT` silently cleared the other key.)
 *
 * The screen mirrors `membership-authority.ts` and the policy route; where a
 * rule is enforced in both places, this file asserts the *screen's* half so a
 * future edit cannot quietly re-open the gap.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MFA_POLICY, normalizeMfaPolicy } from "./mfa-policy";
import { PERMISSIONS } from "./permissions";

const ROOT = join(__dirname, "..");
const TEAM_MANAGER = readFileSync(join(ROOT, "app/dashboard/team/team-manager.tsx"), "utf8");
const ADMIN_LOGIN = readFileSync(join(ROOT, "app/admin/admin-login-form.tsx"), "utf8");
const PHONE_OTP_STEP = readFileSync(join(ROOT, "components/auth/phone-otp-step.tsx"), "utf8");
const BUSINESS_PICKER = readFileSync(join(ROOT, "components/auth/business-picker.tsx"), "utf8");
const TWO_FACTOR = readFileSync(join(ROOT, "app/(app)/settings/two-factor-settings.tsx"), "utf8");
const INVITATIONS_ROUTE = readFileSync(join(ROOT, "app/api/team/invitations/route.ts"), "utf8");

describe("team screen access gating (P2.1 / P2.4)", () => {
  it("separates 'sees the roster' from 'hands out capabilities'", () => {
    // Two permissions, two flags — a single `canManage` for both would make the
    // permission-free case either too permissive or unusable.
    expect(TEAM_MANAGER).toContain("PERMISSIONS.teamPermissionsManage");
    expect(TEAM_MANAGER).toContain("PERMISSIONS.teamManage");
    expect(TEAM_MANAGER).toMatch(/const canManagePermissions = isOwner \|\| granted\.includes/);
    expect(TEAM_MANAGER).toMatch(/const canManage = isOwner \|\| granted\.includes/);
  });

  it("renders the canonical permission editor read-only instead of a second catalogue", () => {
    // P2.3: the member editor must not carry its own permission list again.
    expect(TEAM_MANAGER).toContain("@/components/team/permission-editor");
    expect(TEAM_MANAGER).toContain("AccessChangeSummary");
    // The grid and the ~50-entry label map are gone, not merely unused: a
    // catalogue left in place is a catalogue the next edit copies from.
    expect(TEAM_MANAGER).not.toMatch(/ALL_PERMISSIONS\.(filter|map|forEach)/);
    expect(TEAM_MANAGER).not.toMatch(/const PERMISSION_LABELS/);
    expect(TEAM_MANAGER).not.toMatch(/PERMISSION_METADATA\.get/);
  });

  it("does not send the permission or role half of the edit without the permission for it", () => {
    // The request has to be shaped by the capability, not merely hidden by CSS.
    expect(TEAM_MANAGER).toMatch(
      /const accessFields = canManagePermissions && !isOwnerRole/,
    );
    expect(TEAM_MANAGER).toMatch(/\.\.\.\(canManagePermissions \? \{ role \} : \{\}\)/);
  });
});

describe("invitation form (P2.11 / P2.12)", () => {
  it("sends the branch policy the route validates", () => {
    expect(TEAM_MANAGER).toMatch(/\n        locationScope,/);
    expect(TEAM_MANAGER).toMatch(/locationIds: locationScope === "selected" \? branchIds : \[\]/);
    expect(TEAM_MANAGER).toMatch(/defaultLocationId: locationScope === "home"/);
    // The route rejects `selected` with no branches and `home` with no default,
    // so the form refuses to submit those shapes rather than round-tripping a 400.
    expect(TEAM_MANAGER).toMatch(/locationScope === "selected" && branchIds\.length === 0/);
    expect(TEAM_MANAGER).toMatch(/locationScope === "home" && !defaultLocationId/);
  });

  it("carries the custom role only for an actor allowed to grant one", () => {
    expect(TEAM_MANAGER).toMatch(/canManagePermissions \? \{ customRoleId: customRoleId \|\| null \} : \{\}/);
    expect(INVITATIONS_ROUTE).toContain("customRoleId");
  });

  it("stops offering invitations on a Hybrid site, where the route refuses them", () => {
    expect(TEAM_MANAGER).toMatch(/const invitesBlocked = deploymentProfile === "hybrid"/);
  });
});

describe("organization MFA policy (P1.1)", () => {
  it("has exactly two knobs, and owner/admin are not among them", () => {
    expect(DEFAULT_MFA_POLICY).toEqual({
      requireForManagers: false,
      requireForAccountants: false,
    });
    /**
     * The trap the UI has to avoid: the route normalises a partial body, so a
     * write that names one knob sends the other to `false`.
     */
    expect(normalizeMfaPolicy({ requireForManagers: true })).toEqual({
      requireForManagers: true,
      requireForAccountants: false,
    });
  });

  it("writes both knobs on every save, so one switch cannot clear the other", () => {
    expect(TWO_FACTOR).toMatch(/requireForManagers: next\.requireForManagers \?\? policy\.requireForManagers/);
    expect(TWO_FACTOR).toMatch(
      /requireForAccountants: next\.requireForAccountants \?\? policy\.requireForAccountants/,
    );
    // A single toggle handler for both switches is how the previous copy did it.
    expect(TWO_FACTOR).not.toContain("toggleManagers");
  });

  it("reads the policy from the policy endpoint, not from the personal factor state", () => {
    expect(TWO_FACTOR).toContain('"/api/settings/mfa-policy"');
    expect(TWO_FACTOR).toMatch(/if \(scope === "policy"\)/);
  });
});

describe("read-only roster (P2.1)", () => {
  it("tells a viewer what they would need, rather than showing dead buttons", () => {
    // `team.view` is what the settings gate admits the tab on (settings-tabs.ts,
    // asserted in its own test); the screen's half is that a viewer is told why
    // the action column is empty instead of being shown buttons that 403.
    expect(TEAM_MANAGER).toMatch(/!canManage \? \(\s*<InfoBox>/);
    expect(TEAM_MANAGER).toContain("مشاهدهٔ تیم");
    // Every mutating control is behind the flag, including the destructive pair.
    const gatedActions = TEAM_MANAGER.match(/canManage && \(isOwner \|\| member\.role !== "owner"\)/g) ?? [];
    expect(gatedActions.length).toBe(5);
  });
});

describe("custom roles screen (P2.4)", () => {
  it("locks its write controls on the permission its routes demand", () => {
    const ROLES = readFileSync(join(ROOT, "components/team/roles-manager.tsx"), "utf8");
    // Both write routes (`POST /api/team/roles`, `PATCH …/[id]`) guard on
    // `team.permissions.manage`; the screen's lock has to name the same rule.
    expect(ROLES).toMatch(/const locked=deploymentProfile==="hybrid"\|\|!canManagePermissions/);
    expect(ROLES).toContain("canManagePermissions");
  });
});

/**
 * Issue #854 (P1.18 / P1.19) — the multi-business step, on both doors.
 *
 * `/api/auth/login` and `/api/auth/phone-otp/verify` answer a member of more
 * than one business with `{ needsBusinessSelection: true, businesses }`, HTTP
 * 200 and **no session cookie**. The password door read `res.ok` as success and
 * navigated, so the destination bounced the member back to the login screen
 * with no explanation — a loop whose cause was invisible on both screens.
 *
 * The phone-OTP door handled it, but with its own inline state and markup. The
 * fix is not "teach the second screen the same trick": it is one shared step, so
 * a third door (or a change to the answer shape) cannot leave one of them
 * behind. These assertions pin the sharing, not just the handling.
 */
describe("multi-business selection is one shared step (P1.19)", () => {
  it("renders the shared picker from both doors", () => {
    expect(ADMIN_LOGIN).toContain("@/components/auth/business-picker");
    expect(PHONE_OTP_STEP).toMatch(/from "\.\/business-picker"/);
    expect(ADMIN_LOGIN).toMatch(/<BusinessPicker/);
    expect(PHONE_OTP_STEP).toMatch(/<BusinessPicker/);
  });

  it("keeps the pending choice in the shared hook, not in per-screen state", () => {
    expect(ADMIN_LOGIN).toMatch(/useBusinessSelection\(\)/);
    expect(PHONE_OTP_STEP).toMatch(/useBusinessSelection\(\)/);
    // The phone step used to declare its own `interface BusinessSelection` and
    // its own `useState`. A local copy is how the two drifted apart before.
    expect(PHONE_OTP_STEP).not.toMatch(/interface BusinessSelection/);
    expect(PHONE_OTP_STEP).not.toMatch(/useState<BusinessSelection/);
  });

  it("returns before the success path, so a selection answer is never read as a login", () => {
    // Order matters: `capture` must be checked before the destination redirect.
    expect(ADMIN_LOGIN).toMatch(/if \(res\.ok && capture\(data\)\) return;/);
    expect(PHONE_OTP_STEP).toMatch(/if \(capture\(data\)\) return;/);
  });

  it("re-sends the password credentials on the selection round (no token exists for it)", () => {
    // The password route verifies email+password on every call, so the chosen
    // business id rides along with them; there is no token to replay.
    expect(ADMIN_LOGIN).toMatch(
      /password, \.\.\.\(businessId \? \{ businessId \} : \{\}\)/,
    );
  });
});

/**
 * Issue #854 (P1.12) — the screen tells the administrator what the new role
 * needs *before* the save is refused.
 *
 * The server's refusal is the guarantee (`assertRoleTransitionKeepsLoginPath`):
 * it will not invent a password or a PIN for the member. But a refusal the admin
 * only meets by pressing «ذخیره» is a refusal they will read as a bug, so the
 * member editor warns first — from `member.hasLogin` / `member.hasPin`, which the
 * roster already carries.
 */
describe("role transitions state their credential requirement (P1.12)", () => {
  it("warns when the chosen role crosses the credential model", () => {
    expect(TEAM_MANAGER).toContain("loginCredentialModelForRole");
    expect(TEAM_MANAGER).toMatch(/const credentialModelChanges =/);
    expect(TEAM_MANAGER).toMatch(/const missingCredential =/);
    expect(TEAM_MANAGER).toContain("{missingCredential ? <InfoBox>");
  });

  it("names the missing credential rather than saying the change failed", () => {
    // Identity first for a password role, PIN for a staff role: the two
    // sentences point at the two screens that can actually provide it.
    expect(TEAM_MANAGER).toMatch(/هویت ورود ندارد/);
    expect(TEAM_MANAGER).toMatch(/رمز عددی تعیین کنید/);
  });
});
