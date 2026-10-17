/**
 * Shutdown regression for the packaged desktop (issue #869): the
 * `embedded-postgres` module registers an `exit` hook whose handler calls
 * `done()` — an argument the `exit` event never provides — so `process.exit()`
 * (Electron's quit) logged `TypeError: done is not a function`. Main's fix
 * (`electron/embedded-postgres-exit.js`, released by `backend-manager.js`
 * right after the library loads) removes exactly that hook; the desktop
 * backend stops PostgreSQL itself on quit.
 *
 * The tests run the scenarios from scripts/repro-embedded-postgres-exit.mjs
 * against the dependency in THIS checkout, firing the `exit` event exactly as
 * `process.exit()` does and capturing the resulting rejection:
 *   - the baseline must still reject (the defect lives in the library, so a
 *     silent "fix" here would be misattribution);
 *   - the released-hook path must not reject, and the release must report
 *     that it actually removed a hook;
 *   - the patched-dependency path (issue #985) must not reject even with the
 *     hook still registered, because that is the case a shipped build hit
 *     after the release call was already in place.
 * A dependency upgrade that re-introduces the failing hook, a backend change
 * that stops releasing it, or a packaging step that skips the patch fails this
 * suite.
 */
import { describe, expect, it } from "vitest";
import { CHILD_BASELINE, CHILD_FIXED, CHILD_PATCHED, runChild } from "../scripts/repro-embedded-postgres-exit.mjs";

const SIGNATURE = /done is not a function/i;

/** The ERRORS=[...] the child captured from unhandledRejection. */
function capturedErrors(stdout: string): string[] | null {
  const match = stdout.match(/ERRORS=(\[.*\])/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : null;
  } catch {
    return null;
  }
}

describe("embedded-postgres exit-hook shutdown", () => {
  it("reproduces the packaged defect when the library's exit hook is left in place", async () => {
    const result = await runChild(CHILD_BASELINE);
    expect(result.code).toBe(0);
    const errors = capturedErrors(result.stdout);
    expect(errors).not.toBeNull();
    expect(errors?.some((message) => SIGNATURE.test(message))).toBe(true);
  }, 30_000);

  it("exits clean once backend-manager's release removes the exit hook", async () => {
    const result = await runChild(CHILD_FIXED);
    expect(result.code).toBe(0);
    const errors = capturedErrors(result.stdout);
    expect(errors).toEqual([]);
    // The release must have found and removed the hook — a "true" that came
    // from never having a hook would pass the rejection check while the fix
    // silently did nothing.
    expect(result.stdout).toContain("REMOVED=true");
  }, 30_000);

  it("exits clean with the exit hook still registered when the packaged dependency carries the #985 patch", async () => {
    const result = await runChild(CHILD_PATCHED);
    expect(result.code).toBe(0);
    expect(capturedErrors(result.stdout)).toEqual([]);
    // Proves the copy was actually rewritten before it was imported, rather
    // than the child passing because the patch silently did nothing.
    expect(result.stdout).toContain("PATCH=patched");
  }, 30_000);
});
