import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_INSTANCE_CHALLENGE_HEADER,
  HEALTH_TOKEN_HEADER,
  desktopInstanceProof,
  healthBody,
  healthTokenMatches,
} from "./health-response";

/**
 * Issue #1003 item 7 — the public liveness probe no longer hands out the build
 * commit or the desktop installation's secret nonce. `version` needs the
 * deploy token; the nonce is never sent, only an HMAC answer to a challenge.
 */

const NOW = new Date("2026-10-24T12:00:00.000Z");
const CHALLENGE = "c2Vzc2lvbi1jaGFsbGVuZ2UtZm9yLXRlc3Rz_-";

function headers(values: Record<string, string> = {}) {
  const map = new Headers(values);
  return { get: (name: string) => map.get(name) };
}

describe("healthBody", () => {
  it("is liveness alone for an anonymous caller — no version, no instance id", () => {
    const body = healthBody(headers(), {
      APP_IMAGE_SHA: "abc1234",
      DESKTOP_INSTANCE_ID: "instance-secret",
      HEALTH_VERSION_TOKEN: "deploy-token",
    }, NOW);
    expect(body).toEqual({ ok: true, at: NOW.toISOString() });
    expect(JSON.stringify(body)).not.toContain("instance-secret");
    expect(JSON.stringify(body)).not.toContain("abc1234");
  });

  it("adds the build commit for the deploy token, and only for it", () => {
    const env = { APP_IMAGE_SHA: "abc1234", HEALTH_VERSION_TOKEN: "deploy-token" };
    expect(healthBody(headers({ [HEALTH_TOKEN_HEADER]: "deploy-token" }), env, NOW).version).toBe("abc1234");
    expect(healthBody(headers({ [HEALTH_TOKEN_HEADER]: "Deploy-Token" }), env, NOW)).not.toHaveProperty("version");
    expect(healthBody(headers({ [HEALTH_TOKEN_HEADER]: "deploy" }), env, NOW)).not.toHaveProperty("version");
    expect(
      healthBody(headers({ [HEALTH_TOKEN_HEADER]: "deploy-token" }), { HEALTH_VERSION_TOKEN: "deploy-token" }, NOW).version,
    ).toBe("unknown");
  });

  it("answers a desktop challenge with the HMAC of it, never with the id", () => {
    const body = healthBody(
      headers({ [DESKTOP_INSTANCE_CHALLENGE_HEADER]: CHALLENGE }),
      { DESKTOP_INSTANCE_ID: "instance-secret" },
      NOW,
    );
    expect(body.instanceProof).toBe(
      createHmac("sha256", "instance-secret").update(`desktop-instance:${CHALLENGE}`).digest("hex"),
    );
    expect(JSON.stringify(body)).not.toContain("instance-secret");
  });

  it("ignores a challenge off the desktop, and a malformed one on it", () => {
    expect(healthBody(headers({ [DESKTOP_INSTANCE_CHALLENGE_HEADER]: CHALLENGE }), {}, NOW)).not.toHaveProperty(
      "instanceProof",
    );
    for (const challenge of ["short", "x".repeat(129), "has spaces in it!!!!", "a/b+c=d".repeat(4)]) {
      expect(
        healthBody(headers({ [DESKTOP_INSTANCE_CHALLENGE_HEADER]: challenge }), { DESKTOP_INSTANCE_ID: "id" }, NOW),
        challenge,
      ).not.toHaveProperty("instanceProof");
    }
  });
});

describe("healthTokenMatches", () => {
  it("matches only the configured token", () => {
    expect(healthTokenMatches("deploy-token", "deploy-token")).toBe(true);
    expect(healthTokenMatches("deploy-token", "  deploy-token\n")).toBe(true);
    expect(healthTokenMatches("other", "deploy-token")).toBe(false);
    expect(healthTokenMatches("deploy-token-longer", "deploy-token")).toBe(false);
  });

  it("matches nothing when no token is configured", () => {
    for (const configured of [undefined, null, "", "   "]) {
      expect(healthTokenMatches("", configured)).toBe(false);
      expect(healthTokenMatches("anything", configured)).toBe(false);
    }
    expect(healthTokenMatches(null, "deploy-token")).toBe(false);
  });
});

describe("desktopInstanceProof", () => {
  it("depends on both the id and the challenge", () => {
    const base = desktopInstanceProof("id-1", CHALLENGE);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(desktopInstanceProof("id-2", CHALLENGE)).not.toBe(base);
    expect(desktopInstanceProof("id-1", `${CHALLENGE}x`)).not.toBe(base);
  });
});
