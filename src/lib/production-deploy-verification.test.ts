import { describe, expect, it, vi } from "vitest";
import {
  DeploymentVerificationError,
  HEALTH_TOKEN_HEADER,
  PROTECTED_PATHS,
  deploymentUrls,
  parseOptions,
  verifyDeployment,
  waitForExpectedImage,
} from "../../scripts/verify-production-deploy.mjs";

const BASE = "https://cafe.example.test";
const SHA = "2fe770d";

function response(body: string, init: ResponseInit): Response {
  return new Response(body, init);
}

describe("production deployment verification", () => {
  it("accepts a bare origin or the health endpoint, but rejects a misleading path prefix", () => {
    expect(deploymentUrls(BASE).healthUrl.href).toBe(`${BASE}/api/health`);
    expect(deploymentUrls(`${BASE}/api/health`).baseUrl.href).toBe(`${BASE}/`);
    expect(() => deploymentUrls(`${BASE}/anything-else`)).toThrow(
      "bare origin or end exactly in /api/health",
    );
  });

  it("requires an explicit health URL and image SHA instead of accepting an unverified target", () => {
    const env = { NODE_ENV: "test" } as const;
    expect(() => parseOptions([], env)).toThrow("Both --health-url and --expected-sha are required");
    expect(() =>
      parseOptions(["--health-url", BASE, "--expected-sha", "not-a-sha"], env),
    ).toThrow("must be a Git SHA");
  });

  it("rejects an old-but-healthy image before it can be mistaken for a deployed route fix", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response(JSON.stringify({ ok: true, version: "16379b3" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      verifyDeployment(
        {
          ...deploymentUrls(BASE),
          expectedSha: SHA,
          attempts: 1,
          delayMs: 0,
        },
        { fetchImpl, log: vi.fn() },
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<DeploymentVerificationError>>({
        name: "DeploymentVerificationError",
        message: expect.stringContaining("APP_IMAGE_SHA=16379b3, expected 2fe770d"),
      }),
    );

    // No route verdict is meaningful until the actual image is known.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toEqual(new URL(`${BASE}/api/health`));
  });

  it("requires every affected canonical URL to take the normal signed-out login bounce", async () => {
    const fetchImpl = vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/health") {
        return response(JSON.stringify({ ok: true, version: SHA }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return response("", {
        status: 307,
        headers: { Location: `/login?next=${encodeURIComponent(url.pathname)}` },
      });
    });

    const result = await verifyDeployment(
      {
        ...deploymentUrls(`${BASE}/api/health`),
        expectedSha: SHA,
        attempts: 1,
        delayMs: 0,
      },
      { fetchImpl, log: vi.fn() },
    );

    expect(result.health.version).toBe(SHA);
    expect(result.routes).toEqual(PROTECTED_PATHS);
  });

  // Issue #1003 — the server reveals its build commit only to the deploy token.
  describe("the deploy token", () => {
    const TOKEN = "deploy-token-for-tests";

    function healthOnly(handler: (headers: Headers) => Record<string, unknown>) {
      return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        response(JSON.stringify(handler(new Headers(init?.headers))), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    it("is read from HEALTH_VERSION_TOKEN or --health-token, and omitted when blank", () => {
      const base = ["--health-url", BASE, "--expected-sha", SHA];
      const env = (extra: Record<string, string> = {}) => ({ NODE_ENV: "test" as const, ...extra });
      expect(parseOptions(base, env({ HEALTH_VERSION_TOKEN: TOKEN })).healthToken).toBe(TOKEN);
      expect(
        parseOptions([...base, "--health-token", "from-flag"], env({ HEALTH_VERSION_TOKEN: TOKEN })).healthToken,
      ).toBe("from-flag");
      expect(parseOptions(base, env({ HEALTH_VERSION_TOKEN: "  " }))).not.toHaveProperty("healthToken");
      expect(parseOptions(base, env())).not.toHaveProperty("healthToken");
    });

    it("is sent in the header the server reads, and unlocks the version", async () => {
      const fetchImpl = healthOnly((headers) =>
        headers.get(HEALTH_TOKEN_HEADER) === TOKEN ? { ok: true, version: SHA } : { ok: true },
      );
      const health = await waitForExpectedImage(
        { ...deploymentUrls(BASE), expectedSha: SHA, healthToken: TOKEN, attempts: 1, delayMs: 0 },
        { fetchImpl, log: vi.fn() },
      );
      expect(health.version).toBe(SHA);
      expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get(HEALTH_TOKEN_HEADER)).toBe(TOKEN);
    });

    it("stops at once, naming the missing secret, when the server hides its version and no token is set", async () => {
      const fetchImpl = healthOnly(() => ({ ok: true, at: "2026-10-24T00:00:00.000Z" }));
      const sleep = vi.fn(async () => {});
      await expect(
        waitForExpectedImage(
          { ...deploymentUrls(BASE), expectedSha: SHA, attempts: 60, delayMs: 10_000 },
          { fetchImpl, sleep, log: vi.fn() },
        ),
      ).rejects.toThrow("Set HEALTH_VERSION_TOKEN");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).has(HEALTH_TOKEN_HEADER)).toBe(false);
    });

    it("keeps polling an old image that still reports its version publicly", async () => {
      // The rollout window: the previous build answers without needing a token.
      const versions = ["16379b3", SHA];
      const fetchImpl = healthOnly(() => ({ ok: true, version: versions.shift() }));
      const health = await waitForExpectedImage(
        { ...deploymentUrls(BASE), expectedSha: SHA, healthToken: TOKEN, attempts: 3, delayMs: 0 },
        { fetchImpl, sleep: async () => {}, log: vi.fn() },
      );
      expect(health.version).toBe(SHA);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("reports a token the server did not accept, within the normal attempt budget", async () => {
      const fetchImpl = healthOnly(() => ({ ok: true }));
      await expect(
        waitForExpectedImage(
          { ...deploymentUrls(BASE), expectedSha: SHA, healthToken: "wrong", attempts: 2, delayMs: 0 },
          { fetchImpl, sleep: async () => {}, log: vi.fn() },
        ),
      ).rejects.toThrow("did not accept the deploy token");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });

  it("fails if a top-level route has been rewritten to its retired /dashboard address", async () => {
    const fetchImpl = vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/health") {
        return response(JSON.stringify({ ok: true, version: SHA }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/accounting/overview") {
        return response("", {
          status: 307,
          headers: { Location: "/login?next=%2Fdashboard%2Faccounting" },
        });
      }
      return response("", {
        status: 307,
        headers: { Location: `/login?next=${encodeURIComponent(url.pathname)}` },
      });
    });

    await expect(
      verifyDeployment(
        {
          ...deploymentUrls(BASE),
          expectedSha: SHA,
          attempts: 1,
          delayMs: 0,
        },
        { fetchImpl, log: vi.fn() },
      ),
    ).rejects.toThrow(
      "/accounting/overview: expected Location https://cafe.example.test/login?next=%2Faccounting%2Foverview, got https://cafe.example.test/login?next=%2Fdashboard%2Faccounting",
    );
  });
});
