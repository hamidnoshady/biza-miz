/**
 * Issue #984 — the desktop shell's support-companion launcher
 * (`electron/support-companion.js`): install resolution, deep-link shape and
 * detached spawn, all dependency-injected so they run on any OS. The real
 * Windows spawn path is covered by the packaged desktop checks in CI.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const launcher = require("../electron/support-companion.js") as {
  SUPPORT_PROTOCOL: string;
  COMPANION_EXE: string;
  candidateInstallPaths(env?: Record<string, string | undefined>): string[];
  resolveCompanionExe(input?: {
    env?: Record<string, string | undefined>;
    existsSync?: (path: string) => boolean;
  }): string | null;
  companionDeepLink(ticketId?: string | null): string;
  companionEnrollLink(input?: {
    server?: string | null;
    enrollmentId?: string | null;
    claim?: string | null;
  }): string | null;
  launchCompanion(input?: {
    ticketId?: string | null;
    exePath?: string | null;
    spawnFn?: (
      exe: string,
      args: string[],
      options: Record<string, unknown>,
    ) => { unref?: () => void };
  }): { ok: true; exe: string } | { ok: false; error: string; detail?: string };
  companionStatus(input?: {
    env?: Record<string, string | undefined>;
    existsSync?: (path: string) => boolean;
  }): { installed: boolean; exe: string | null; protocol: string };
};

describe("support companion launcher (issue #984)", () => {
  it("checks the machine install, then the per-user install", () => {
    const paths = launcher.candidateInstallPaths({
      ProgramFiles: "C:\\Program Files",
      LocalAppData: "C:\\Users\\op\\AppData\\Local",
    });
    expect(paths).toHaveLength(2);
    expect(paths[0]).toBe("C:\\Program Files\\Biza Support Companion\\BizaSupportCompanion.exe");
    expect(paths[1]).toBe("C:\\Users\\op\\AppData\\Local\\Biza Support Companion\\BizaSupportCompanion.exe");
  });

  it("honors the explicit EXE override and nothing else", () => {
    expect(
      launcher.candidateInstallPaths({
        BIZA_SUPPORT_COMPANION_EXE: "D:\\tools\\companion.exe",
        ProgramFiles: "C:\\Program Files",
      }),
    ).toEqual(["D:\\tools\\companion.exe"]);
    expect(launcher.candidateInstallPaths({})).toEqual([]);
  });

  it("resolves the first candidate that exists and tolerates unreadable ones", () => {
    const env = { ProgramFiles: "C:\\Program Files", LocalAppData: "C:\\Users\\op\\AppData\\Local" };
    expect(
      launcher.resolveCompanionExe({
        env,
        existsSync: (p) => p.includes("AppData"),
      }),
    ).toBe("C:\\Users\\op\\AppData\\Local\\Biza Support Companion\\BizaSupportCompanion.exe");
    expect(launcher.resolveCompanionExe({ env, existsSync: () => false })).toBeNull();
    expect(
      launcher.resolveCompanionExe({
        env,
        existsSync: () => {
          throw new Error("EACCES");
        },
      }),
    ).toBeNull();
  });

  it("builds the one accepted link shape", () => {
    expect(launcher.SUPPORT_PROTOCOL).toBe("biza-support");
    expect(launcher.companionDeepLink("ticket-1")).toBe("biza-support://ticket/ticket-1");
    expect(launcher.companionDeepLink("  ")).toBe("biza-support://open");
    expect(launcher.companionDeepLink()).toBe("biza-support://open");
  });

  it("builds enrollment links and refuses half links", () => {
    expect(
      launcher.companionEnrollLink({
        server: "https://support.example/",
        enrollmentId: "enr-1",
        claim: "ABCD-1234",
      }),
    ).toBe(
      "biza-support://enroll?server=https%3A%2F%2Fsupport.example&enrollmentId=enr-1&claim=ABCD-1234",
    );
    expect(launcher.companionEnrollLink({ server: "https://x", enrollmentId: "e" })).toBeNull();
    expect(launcher.companionEnrollLink()).toBeNull();
  });

  it("spawns detached with the ticket hint and reports absence truthfully", () => {
    const calls: { exe: string; args: string[]; options: Record<string, unknown> }[] = [];
    let unrefed = 0;
    const launched = launcher.launchCompanion({
      ticketId: "ticket-9",
      exePath: "C:\\Program Files\\Biza Support Companion\\BizaSupportCompanion.exe",
      spawnFn: (exe, args, options) => {
        calls.push({ exe, args, options });
        return { unref: () => { unrefed += 1; } };
      },
    });
    expect(launched).toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["--ticket", "ticket-9"]);
    expect(calls[0].options).toMatchObject({ detached: true, stdio: "ignore" });
    expect(unrefed).toBe(1);

    // No hint: no args, still detached.
    const calls2: string[][] = [];
    launcher.launchCompanion({
      exePath: "C:\\c.exe",
      spawnFn: (_exe, args) => {
        calls2.push(args);
        return {};
      },
    });
    expect(calls2).toEqual([[]]);

    // Absent install: honest error, no spawn attempt.
    let spawned = 0;
    const missing = launcher.launchCompanion({
      exePath: null,
      spawnFn: () => {
        spawned += 1;
        return {};
      },
    });
    expect(missing).toEqual({ ok: false, error: "not_installed" });
    expect(spawned).toBe(0);
  });

  it("maps spawn failures instead of throwing", () => {
    const failed = launcher.launchCompanion({
      exePath: "C:\\c.exe",
      spawnFn: () => {
        throw new Error("EPERM");
      },
    });
    expect(failed).toMatchObject({ ok: false, error: "launch_failed", detail: "EPERM" });
  });

  it("reports install status for truthful UI states", () => {
    expect(launcher.companionStatus({ env: {}, existsSync: () => false })).toEqual({
      installed: false,
      exe: null,
      protocol: "biza-support",
    });
    expect(
      launcher.companionStatus({
        env: { BIZA_SUPPORT_COMPANION_EXE: "D:\\c.exe" },
        existsSync: () => true,
      }),
    ).toEqual({ installed: true, exe: "D:\\c.exe", protocol: "biza-support" });
  });
});
