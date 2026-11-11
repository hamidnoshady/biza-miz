import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDemoStartKey,
  demoStartProof,
  parseDemoCredential,
  requireDemoDeployment,
} from "./demo-session-credentials";

const demoId = "e43c5f6e-21b8-46d4-bcab-7c1a05bf835c";
const secret = "c5".repeat(32);

afterEach(() => vi.unstubAllEnvs());

function configure() {
  vi.stubEnv("BIZAMIZ_DEPLOYMENT_PROFILE", "demo");
  vi.stubEnv("DEMO_DATABASE_ID", demoId);
  vi.stubEnv("DEMO_SESSION_SECRET", secret);
}

describe("demo credentials", () => {
  it("rejects missing profiles, production and incomplete demo configuration", () => {
    vi.stubEnv("BIZAMIZ_DEPLOYMENT_PROFILE", undefined);
    expect(() => requireDemoDeployment()).toThrow("demo_deployment_required");
    configure();
    vi.stubEnv("BIZAMIZ_DEPLOYMENT_PROFILE", "production");
    expect(() => createDemoStartKey()).toThrow("demo_deployment_required");
    configure();
    vi.stubEnv("DEMO_DATABASE_ID", "production");
    expect(() => createDemoStartKey()).toThrow("demo_deployment_misconfigured");
  });

  it("derives the same opaque proof for a retry and rejects a forged start key", () => {
    configure();
    const key = createDemoStartKey();
    const proof = demoStartProof(key, requireDemoDeployment());
    expect(proof).toEqual(demoStartProof(key, requireDemoDeployment()));
    expect(proof?.secret).not.toEqual(key);
    expect(demoStartProof(key.replace(/^./, (c) => c === "1" ? "2" : "1"), requireDemoDeployment())).toBeNull();
    vi.stubEnv("DEMO_DATABASE_ID", "d2228127-19a9-4624-8747-1304d1046bdd");
    expect(demoStartProof(key, requireDemoDeployment())).toBeNull();
  });

  it("parses only well-formed scoped credentials", () => {
    expect(parseDemoCredential(`${demoId}.${secret}`)).toEqual({ businessId: demoId, secret });
    expect(parseDemoCredential(`${demoId}.${secret}.tail`)).toBeNull();
    expect(parseDemoCredential(`other.${secret}`)).toBeNull();
  });
});
