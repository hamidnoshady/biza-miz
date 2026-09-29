/**
 * The media usage fallback shape (issue #755 §6).
 *
 * The bug this pins: the business Billing read falls back to a zeroed usage
 * object when the media tables are unreachable, and that fallback used to be
 * `{ totalBytes: 0, assetCount: 0, byKind: {} }`. The UI reads
 * `usage.byKind.image.count` / `.video.count`, so the *recovery* path — the one
 * that exists to keep the page working — was the one that threw.
 *
 * The rollups themselves (`mediaUsageFor` against real rows: image-only,
 * document-only, mixed, per-tenant emptiness) are covered by
 * `integration/media-library.integration.test.ts`, which needs Postgres. What is
 * cheap to assert here is the contract every caller depends on: the zero case
 * has every kind, with no `undefined` anywhere a caller dereferences.
 */
import { describe, expect, it } from "vitest";
import { emptyMediaUsage } from "./media-service";

/** Every kind the UI dereferences by name. */
const KINDS = ["image", "video", "document"] as const;

describe("emptyMediaUsage", () => {
  it("carries every kind, zeroed, so no caller has to null-check", () => {
    const usage = emptyMediaUsage();
    for (const kind of KINDS) {
      expect(usage.byKind[kind], `${kind} missing from the fallback`).toEqual({
        count: 0,
        bytes: 0,
      });
    }
    expect(usage.totalBytes).toBe(0);
    expect(usage.assetCount).toBe(0);
  });

  it("is a fresh object each call, so one caller cannot poison another's fallback", () => {
    const first = emptyMediaUsage();
    first.byKind.image.count = 7;
    first.totalBytes = 1234;
    expect(emptyMediaUsage()).toEqual({
      totalBytes: 0,
      assetCount: 0,
      byKind: {
        image: { count: 0, bytes: 0 },
        video: { count: 0, bytes: 0 },
        document: { count: 0, bytes: 0 },
      },
    });
  });

  it("has no key outside the known kinds", () => {
    // A kind the UI does not know about is harmless; a *missing* one is not. This
    // keeps the two in step when a media kind is added.
    expect(Object.keys(emptyMediaUsage().byKind).sort()).toEqual([...KINDS].sort());
  });
});
