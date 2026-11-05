/**
 * Issue #902 — the boundary between "a business messaging its customer" and
 * "a member logging in", enforced by reading the source.
 *
 * The whole point of splitting the managed-SMS work into a child account per
 * business (§2) and a platform-auth transport (this file's subject) is that the
 * two must not be able to borrow each other's credentials. The failure modes
 * are specific and both are outages:
 *
 *   * A login OTP sent through a business's child account stops working the day
 *     that business's wallet is empty, its child is suspended, or Growth is
 *     switched off — issue #902 DoD #9, verbatim.
 *   * A transactional message sent on the *master* key is the platform paying
 *     for a tenant's message, which is the leak §5 closed.
 *
 * Nothing in the type system stops either import, so this test does: the files
 * that send an OTP may not touch the child send path, and the trigger path may
 * not touch the master key.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Strip comments, so a rule's own explanation cannot trip it. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/**
 * A hand-rolled walk rather than `readdirSync({recursive:true})`: the shape of
 * that option (and of the paths it hands back) is the one thing about this file
 * that would differ between the Node the sandbox runs and the Node CI runs, and
 * a boundary test that silently enumerates nothing is worse than no test.
 */
function sources(dir: string, filter: (name: string) => boolean): { name: string; source: string }[] {
  const found: { name: string; source: string }[] = [];
  const walk = (relative: string) => {
    for (const entry of readdirSync(`${ROOT}${dir}${relative}`, { withFileTypes: true })) {
      const path = `${relative}${entry.name}`;
      if (entry.isDirectory()) walk(`${path}/`);
      else if (filter(entry.name)) {
        found.push({ name: `${dir}${path}`, source: code(readFileSync(`${ROOT}${dir}${path}`, "utf8")) });
      }
    }
  };
  walk("");
  return found;
}

const sourceFiles = [
  ...sources("src/lib/", (name) => name.endsWith(".ts") && !name.endsWith(".test.ts")),
  ...sources("src/app/", (name) => name.endsWith(".ts") || name.endsWith(".tsx")),
];

/**
 * The files that carry the platform-auth transport, named rather than discovered.
 *
 * A sweep alone answers "who imports the config today"; it cannot tell a
 * reviewer that the sweep looked at anything at all. These are read
 * unconditionally — a renamed or deleted file fails here rather than quietly
 * leaving the family — and the sweep adds anything new that imports the config.
 */
const AUTH_TRANSPORT_FILES = [
  "src/lib/sms-config.ts",
  "src/lib/sms-kavenegar.ts",
  "src/lib/phone-otp.ts",
  "src/lib/mfa-enrol.ts",
  "src/lib/owner-activation.ts",
  "src/app/api/auth/phone-otp/request/route.ts",
  "src/app/api/auth/phone-otp/verify/route.ts",
  "src/app/api/platform/sms/route.ts",
];

const IMPORTS_SMS_CONFIG = /from\s+"(?:\.\.?\/)*(?:\.\.\/)*(@\/lib\/|\.\/)sms-config"/;

/** Every module that resolves the platform-auth transport — the OTP family. */
function authTransportFiles(): { name: string; source: string }[] {
  const named = AUTH_TRANSPORT_FILES.map((name) => ({
    name,
    source: code(readFileSync(`${ROOT}${name}`, "utf8")),
  }));
  const swept = sourceFiles.filter((file) => IMPORTS_SMS_CONFIG.test(file.source));
  const byName = new Map(named.map((file) => [file.name, file]));
  for (const file of swept) byName.set(file.name, file);
  return [...byName.values()];
}

describe("the auth OTP path never borrows a business's child account", () => {
  it("finds the OTP family it is checking", () => {
    // A rule that silently matches nothing is worse than no rule: the named
    // files are read whether or not the sweep finds them, and at least the two
    // modules that own the transport must be recognised as importing it.
    const names = authTransportFiles().map((file) => file.name);
    for (const expected of AUTH_TRANSPORT_FILES) {
      expect(names, `auth-path files found: ${names.join(", ")}`).toContain(expected);
    }
    const importers = names.filter((name) =>
      IMPORTS_SMS_CONFIG.test(code(readFileSync(`${ROOT}${name}`, "utf8"))),
    );
    expect(importers).toContain("src/lib/phone-otp.ts");
    expect(importers).toContain("src/app/api/auth/phone-otp/request/route.ts");
  });

  it("imports no child credential, no managed send and no trigger", () => {
    const offenders = authTransportFiles()
      .filter((file) =>
        /from\s+"[^"]*kavenegar\/(credentials|lookup-send-service|lookup-triggers)"/.test(file.source),
      )
      .map((file) => file.name);
    expect(offenders, `auth-path files reaching the managed child path: ${offenders.join(", ")}`).toEqual([]);
  });

  it("keeps the platform-auth transport on the platform singleton", () => {
    // `platform_sms_config` is the console's one connection, encrypted at rest,
    // with the environment variable as the bootstrap fallback — the same
    // precedence issue #902 §1 asked for. The trigger path must never resolve
    // a key from here: that would be the platform paying for tenant messages.
    const config = code(readFileSync(`${ROOT}src/lib/sms-config.ts`, "utf8"));
    expect(config).toContain("platform_sms_config");
    expect(config).toContain("getKavenegarMasterKey");

    const triggers = code(readFileSync(`${ROOT}src/lib/kavenegar/lookup-triggers.ts`, "utf8"));
    expect(triggers).not.toMatch(/sms-config/);
    expect(triggers).not.toMatch(/getKavenegarMasterKey|KAVENEGAR_API_KEY/);
    expect(triggers).toMatch(/from\s+"\.\/lookup-send-service"/);
  });
});

describe("the trigger vocabulary cannot grow a login code", () => {
  it("names only the two business events in code", () => {
    for (const file of ["lookup-trigger-facts.ts", "lookup-triggers.ts"]) {
      expect(code(readFileSync(`${ROOT}src/lib/kavenegar/${file}`, "utf8"))).not.toContain("login_code");
    }
  });

  it("is refused by the schema as well, not only by the module", () => {
    // The module could be refactored; the CHECK is what a future migration
    // would have to argue with.
    const migration = readFileSync(`${ROOT}migrations/0266_kavenegar_lookup_triggers.sql`, "utf8");
    expect(migration).toContain("trigger_key IN ('order_ready', 'payment_received')");
  });
});
