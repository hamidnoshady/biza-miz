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

function sources(dir: string, filter: (name: string) => boolean): { name: string; source: string }[] {
  return readdirSync(`${ROOT}${dir}`, { recursive: true, encoding: "utf8" })
    .filter((name) => filter(name))
    .map((name) => ({ name: `${dir}${name}`, source: code(readFileSync(`${ROOT}${dir}${name}`, "utf8")) }));
}

const sourceFiles = [
  ...sources("src/lib/", (name) => name.endsWith(".ts") && !name.endsWith(".test.ts")),
  ...sources("src/app/", (name) => name.endsWith(".ts") || name.endsWith(".tsx")),
];

/** Every module that resolves the platform-auth transport — the OTP family. */
function authTransportFiles(): { name: string; source: string }[] {
  return sourceFiles.filter((file) =>
    /from\s+"(\.\.?\/)*(\.\.\/)*(@\/lib\/)?sms-config"/.test(file.source) ||
    /from\s+"@\/lib\/sms-config"/.test(file.source),
  );
}

describe("the auth OTP path never borrows a business's child account", () => {
  it("finds the OTP family it is checking", () => {
    // A rule that silently matches nothing is worse than no rule: the regexes
    // above would keep passing after the imports were renamed.
    const names = authTransportFiles().map((file) => file.name);
    expect(names).toContain("src/lib/phone-otp.ts");
    expect(names).toContain("src/lib/mfa-enrol.ts");
    expect(names.some((name) => name.includes("api/auth/phone-otp/"))).toBe(true);
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
