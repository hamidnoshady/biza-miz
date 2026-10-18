import { describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { GET } from "./route";

vi.mock("@/lib/db", () => ({
  withTenant: vi.fn(async (_businessId: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock("@/lib/support-companion/companion-auth", () => ({
  requireCompanionDevice: vi.fn(async () => ({
    device: {
      identity: { businessId: "biz-1", installationId: "inst-1" },
      installation: {
        id: "inst-1",
        generation: 3,
        displayName: "Till 1",
        enrollmentState: "active",
      },
    },
  })),
}));

vi.mock("@/lib/support-companion/diagnostics", () => ({
  listPendingInstallationRequests: vi.fn(async () => []),
  transitionDiagnosticRequest: vi.fn(async () => {}),
}));

vi.mock("@/lib/support-companion/assistance", () => ({
  listSessionsAwaitingConsent: vi.fn(async () => []),
  markSessionDelivered: vi.fn(async () => {}),
}));

const contactCalls: Array<Record<string, unknown>> = [];
vi.mock("@/lib/support-companion/installations", () => ({
  recordInstallationContact: vi.fn(async (_b: string, _i: string, attrs: Record<string, unknown>) => {
    contactCalls.push(attrs);
  }),
}));

vi.mock("@/lib/support-companion/access-tokens", () => ({
  offlinePublicKeysBundle: vi.fn(() => '[{"kty":"EC","crv":"P-256"}]'),
}));

function poll(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/support-companion/requests${query}`);
}

describe("GET requests poll additions (issue #984)", () => {
  it("serves the offline public-keys bundle", async () => {
    const res = await GET(poll());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { offlineKeys: string };
    expect(body.offlineKeys).toBe('[{"kty":"EC","crv":"P-256"}]');
  });

  it("records agent presence as capabilities without wiping other keys", async () => {
    contactCalls.length = 0;
    await GET(poll("?meshAgentPresent=true"));
    expect(contactCalls).toHaveLength(1);
    expect(contactCalls[0]).toMatchObject({ capabilities: { meshAgentPresent: true } });

    await GET(poll("?meshAgentPresent=false"));
    expect(contactCalls[1]).toMatchObject({ capabilities: { meshAgentPresent: false } });

    // Unprobed polls leave capabilities untouched.
    await GET(poll());
    expect(contactCalls[2]).toMatchObject({ capabilities: undefined });
  });

  it("still reports the mesh node id when the agent knows it", async () => {
    contactCalls.length = 0;
    await GET(poll("?meshNodeId=node-7&meshAgentPresent=true"));
    expect(contactCalls[0]).toMatchObject({
      meshNodeId: "node-7",
      capabilities: { meshAgentPresent: true },
    });
  });
});
