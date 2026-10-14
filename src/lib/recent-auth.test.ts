import { describe, expect, it } from "vitest";
import {
  isRecentAuth,
  nowEpochSeconds,
  RECENT_AUTH_WINDOW_SECONDS,
  requireRecentAuth,
  sessionAuthEpoch,
} from "./recent-auth";

describe("recent-auth policy", () => {
  const now = new Date("2026-10-03T12:00:00Z");
  const nowSec = nowEpochSeconds(now);

  it("extracts recentAuthAt ahead of iat", () => {
    expect(sessionAuthEpoch({ recentAuthAt: nowSec - 60, iat: nowSec - 3600 })).toBe(nowSec - 60);
    expect(sessionAuthEpoch({ iat: nowSec - 120 })).toBe(nowSec - 120);
    expect(sessionAuthEpoch({})).toBeNull();
    expect(sessionAuthEpoch(null)).toBeNull();
  });

  it("accepts authentication within the 15-minute window and rejects stale sessions", () => {
    expect(isRecentAuth({ recentAuthAt: nowSec }, now)).toBe(true);
    expect(isRecentAuth({ recentAuthAt: nowSec - RECENT_AUTH_WINDOW_SECONDS }, now)).toBe(true);
    expect(isRecentAuth({ recentAuthAt: nowSec - RECENT_AUTH_WINDOW_SECONDS - 1 }, now)).toBe(
      false,
    );
    expect(isRecentAuth({ iat: nowSec - 3600 }, now)).toBe(false);
    expect(isRecentAuth(null, now)).toBe(false);
  });

  it("requireRecentAuth returns null when fresh or inlineVerified, and 403 otherwise", async () => {
    expect(requireRecentAuth({ recentAuthAt: nowSec - 300 }, { now })).toBeNull();
    expect(
      requireRecentAuth({ recentAuthAt: nowSec - 7200 }, { now, inlineVerified: true }),
    ).toBeNull();

    const rejected = requireRecentAuth({ recentAuthAt: nowSec - 7200 }, { now });
    expect(rejected).not.toBeNull();
    expect(rejected!.status).toBe(403);
    await expect(rejected!.json()).resolves.toMatchObject({
      error: "recent_auth_required",
      maxAgeSeconds: RECENT_AUTH_WINDOW_SECONDS,
    });
  });
});
