/**
 * Issue #1003 item 7 — the desktop shell and its application server must
 * agree on how an instance proves itself, or the window never opens.
 *
 * The server half is `desktopInstanceProof`/`healthBody`
 * (src/lib/health-response.ts); the Electron half is `instanceProofFor`/
 * `healthProvesInstance` (electron/backend-manager.js), plain CommonJS that
 * cannot import the TypeScript. This runs one against the other.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { DESKTOP_INSTANCE_CHALLENGE_HEADER, desktopInstanceProof, healthBody } from "./health-response";

const require = createRequire(import.meta.url);
const backendManager = require("../../electron/backend-manager.js") as {
  instanceProofFor(instanceId: string, challenge: string): string;
  healthProvesInstance(
    response: unknown,
    instanceId: string,
    challenge: string,
    options?: { acceptLegacyInstanceId?: boolean },
  ): boolean;
};

const INSTANCE_ID = "6f1c2c4e-1a7b-4d3e-9f00-0123456789ab";
const CHALLENGE = "zv3V5mJ0cXbq0m2k7m9L1wQx8cN4yT6uR2eA0sD5fG7";

function serverAnswer(instanceId: string | undefined, challenge: string) {
  const headers = new Headers({ [DESKTOP_INSTANCE_CHALLENGE_HEADER]: challenge });
  // Round-tripped through JSON, as Electron receives it.
  return JSON.parse(JSON.stringify(healthBody(headers, { DESKTOP_INSTANCE_ID: instanceId })));
}

describe("desktop instance proof — server and shell agree", () => {
  it("computes the same HMAC on both sides", () => {
    expect(backendManager.instanceProofFor(INSTANCE_ID, CHALLENGE)).toBe(desktopInstanceProof(INSTANCE_ID, CHALLENGE));
  });

  it("accepts its own server's answer to the challenge it sent", () => {
    expect(backendManager.healthProvesInstance(serverAnswer(INSTANCE_ID, CHALLENGE), INSTANCE_ID, CHALLENGE)).toBe(true);
  });

  it("rejects another installation, a replayed answer and a server that is not the desktop's", () => {
    // Another install's server (different id) answering on the port.
    expect(backendManager.healthProvesInstance(serverAnswer("someone-else", CHALLENGE), INSTANCE_ID, CHALLENGE)).toBe(false);
    // An answer captured for an earlier challenge.
    const replay = serverAnswer(INSTANCE_ID, "an-earlier-challenge-value");
    expect(backendManager.healthProvesInstance(replay, INSTANCE_ID, CHALLENGE)).toBe(false);
    // A web server with no instance at all.
    expect(backendManager.healthProvesInstance(serverAnswer(undefined, CHALLENGE), INSTANCE_ID, CHALLENGE)).toBe(false);
    expect(backendManager.healthProvesInstance({ ok: true, instanceProof: "zz" }, INSTANCE_ID, CHALLENGE)).toBe(false);
    expect(backendManager.healthProvesInstance(null, INSTANCE_ID, CHALLENGE)).toBe(false);
  });

  it("accepts the old plain-id echo only when recognising a leftover server from an older build", () => {
    const legacy = { ok: true, instanceId: INSTANCE_ID };
    expect(backendManager.healthProvesInstance(legacy, INSTANCE_ID, CHALLENGE)).toBe(false);
    expect(
      backendManager.healthProvesInstance(legacy, INSTANCE_ID, CHALLENGE, { acceptLegacyInstanceId: true }),
    ).toBe(true);
    expect(
      backendManager.healthProvesInstance({ ok: true, instanceId: "other" }, INSTANCE_ID, CHALLENGE, {
        acceptLegacyInstanceId: true,
      }),
    ).toBe(false);
  });

  it("never puts the id itself on the wire", () => {
    expect(JSON.stringify(serverAnswer(INSTANCE_ID, CHALLENGE))).not.toContain(INSTANCE_ID);
  });
});
