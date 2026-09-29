/**
 * The provisioning contract, as a source scan (issue #755 §14 and §16).
 *
 * Both of these are the kind of property that a future "let me just add a
 * password field back" change would break silently: no type error, no failing
 * behaviour test, nothing visibly wrong until somebody notices that platform
 * operators know their tenants' passwords again. So they are asserted directly.
 *
 * The behavioural half — that the identity really is created with a password
 * nobody knows, and that redeeming the link is where the owner's own second
 * factor appears — lives in `integration/owner-activation.integration.test.ts`,
 * which needs Postgres. This file is the cheap tripwire that runs everywhere.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const dialog = read("./components/provision-dialog.tsx");
const route = read("../../api/platform/businesses/route.ts");

describe("the console never handles an owner credential (§14)", () => {
  it("asks the API for activation and never forwards a password", () => {
    expect(route).toMatch(/ownerActivation:\s*true/);
    // A `password` in the request body would be ignored by `validateProvisionBody`
    // on this path — but the surest way to keep operators out of a tenant's
    // credentials is to never carry one across the wire at all.
    expect(route).not.toMatch(/input\.password/);
    expect(route).not.toMatch(/body\.password/);
  });

  it("has no password input and no password state to fill", () => {
    expect(dialog).not.toMatch(/type="password"/);
    expect(dialog).not.toMatch(/setPassword/);
    // The old handover panel printed TOTP secrets and recovery codes for the
    // operator to copy. Neither may come back.
    expect(dialog).not.toMatch(/recoveryCodes/);
    expect(dialog).not.toMatch(/totpSecret/);
  });

  it("hands over a single-use activation link on the business's own origin", () => {
    expect(dialog).toMatch(/\/activate\/\$\{token\}/);
    expect(route).toMatch(/activationToken/);
  });

  it("confirms before attaching a business to somebody's existing account", () => {
    expect(route).toMatch(/confirmExistingOwner/);
    expect(route).toMatch(/ExistingOwnerConfirmationRequiredError/);
    expect(route).toMatch(/email_already_registered/);
  });
});

describe("the wizard's UX cleanups (§16)", () => {
  it("shows the industry's label, not the raw key, in Review", () => {
    expect(dialog).toMatch(/INDUSTRY_LABELS\[industry\]/);
  });

  it("validates email and mobile before Review, not after Create", () => {
    expect(dialog).toMatch(/EMAIL_PATTERN\.test/);
    expect(dialog).toMatch(/isMobilePhone\(ownerPhone\)/);
    expect(dialog).toMatch(/invalid_owner_phone/);
  });

  it("marks every Latin-script field left-to-right inside the RTL page", () => {
    // Subdomain, email and mobile in one pass each: without an explicit `dir`
    // the browser reorders the dots and the operator approves the wrong address.
    const dirs = dialog.match(/dir="ltr"/g) ?? [];
    expect(dirs.length).toBeGreaterThanOrEqual(3);
  });

  it("handles a missing root domain instead of rendering `undefined` in a URL", () => {
    expect(dialog).toMatch(/window\.location\.origin/);
    expect(dialog).not.toMatch(/\$\{rootDomain\}\b(?!\s*\?)/);
  });

  it("shows the activation deadline as a Shamsi date", () => {
    expect(dialog).toMatch(/formatJalali\(owner\.activationExpiresAt/);
  });
});
