/**
 * Issue #807 — the super-admin backup API's capability table, pinned.
 *
 * The audit's P1 finding was that one `backup.manage` capability guarded a
 * read, a schedule change, minting a token that hands a full copy of every
 * tenant's data to another machine, and a destructive restore. Splitting it is
 * only worth anything if every route asks for its *own* half, so this test reads
 * the route files and asserts the split route by route. `resolveRestorePlan`
 * decides which half a restore request needs — `backup.verify` for the
 * scratch-database dry run, `backup.restore` for the apply — and that decision
 * is asserted here too, because it is a permission boundary, not a detail.
 *
 * A file-reading test rather than a request-level one on purpose: the routes'
 * grant/deny behaviour for every role and business is the platform console's
 * integration surface, while what can silently regress in a refactor is *which
 * capability a route asks for*. This catches that in milliseconds.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const route = (path: string) => readFileSync(`src/app/api/platform/backup/${path}`, "utf8");

describe("platform backup routes and their capabilities", () => {
  it("gates reads with backup.read, and that is all support needs", () => {
    expect(route("status/route.ts")).toContain('requirePlatformCapability("backup.read")');
    expect(route("restore/route.ts")).toContain('requirePlatformCapability("backup.read")');
    expect(route("config/route.ts")).toContain('requirePlatformCapability("backup.read")');
  });

  it("gates running a backup with backup.run (not configure, not restore)", () => {
    const run = route("run/route.ts");
    expect(run).toContain('requirePlatformCapability("backup.run")');
    expect(run).not.toContain("backup.configure");
    expect(run).not.toContain("backup.restore");
  });

  it("gates destination/passphrase changes with backup.configure", () => {
    const config = route("config/route.ts");
    // The PUT is the mutation; the GET above it stays a read.
    expect(config).toContain('requirePlatformCapability("backup.configure")');
    expect(config.indexOf('requirePlatformCapability("backup.configure")')).toBeGreaterThan(
      config.indexOf('requirePlatformCapability("backup.read")'),
    );
  });

  it("gates serving tokens with backup.share and peer management with backup.peer.manage", () => {
    expect(route("tokens/route.ts")).toContain('requirePlatformCapability("backup.share")');
    expect(route("tokens/[id]/route.ts")).toContain('requirePlatformCapability("backup.share")');
    expect(route("peers/route.ts")).toContain('requirePlatformCapability("backup.peer.manage")');
    expect(route("peers/[id]/route.ts")).toContain('requirePlatformCapability("backup.peer.manage")');
    expect(route("peers/[id]/check/route.ts")).toContain('requirePlatformCapability("backup.peer.manage")');
    // A token is the credential that lets another machine read every tenant's
    // data: it is never minted by a capability that also runs a backup.
    expect(route("tokens/route.ts")).not.toContain("backup.run");
    expect(route("peers/route.ts")).not.toContain("backup.configure");
  });

  it("makes a destructive restore need backup.restore while a verify needs only backup.verify", () => {
    const restore = route("restore/route.ts");
    expect(restore).toContain('requirePlatformCapability(wantsApply ? "backup.restore" : "backup.verify")');
    // `wantsApply` must come from the strict `=== true`, so a string `"true"`
    // or a truthy value cannot turn a verify request into an apply request.
    expect(restore).toContain("const wantsApply = body.apply === true");
    // …and the audit record distinguishes the two, so the log says which ran.
    expect(restore).toContain('"platform_backup.restore.apply"');
    expect(restore).toContain('"platform_backup.restore.verify"');
  });

  it("never falls back to the deprecated backup.manage alias on its own", () => {
    // The alias exists for the operational half (read+run+verify) and is
    // granted to engineer/owner; no route may *require* it, because requiring
    // it would mean requiring a capability nobody has but the two roles that
    // hold everything, which is exactly the situation the split removed.
    for (const path of [
      "status/route.ts",
      "run/route.ts",
      "config/route.ts",
      "restore/route.ts",
      "peers/route.ts",
      "peers/[id]/route.ts",
      "peers/[id]/check/route.ts",
      "tokens/route.ts",
      "tokens/[id]/route.ts",
    ]) {
      expect(route(path), path).not.toContain('requirePlatformCapability("backup.manage")');
    }
  });
});
