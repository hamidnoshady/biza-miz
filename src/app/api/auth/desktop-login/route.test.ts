import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Issue #885, gap 4 — the desktop consumer's assurance.
 *
 * «ورود با حساب ابری» is the one login path that does not verify a primary
 * credential of its own, and that is worth pinning precisely because it is
 * easy to misread as a hole. The desktop app never sees the password or the
 * PIN for this flow: the member signs in on the *cloud* origin through the
 * ordinary password or PIN door (both covered above, both consulting device
 * trust), and this route only converts an already-proven session into a
 * one-time code bound to one paired install.
 *
 * So the assurance question here is not "is a second factor owed" — there is
 * no primary verification happening to owe one. It is: can this route mint a
 * way in on the strength of anything *less* than a live, non-impersonated
 * session? The answer has to be no, on every branch:
 *
 *  - `requireMember` walks the full chain, so a revoked global identity (a
 *    password changed elsewhere) or an inactive member/business mints nothing;
 *  - a platform operator's support session is refused, because it acts *in*
 *    the business and must not sign the member in on their own till;
 *  - the code is bound to a specific paired device and to branches the member
 *    may actually work in, so a code cannot be replayed onto another install
 *    or used to reach a location outside the member's scope.
 *
 * This path deliberately does not consult trusted-device state. Device trust
 * exempts a *routine challenge*; there is no challenge here to exempt, and the
 * cloud door that produced the session already made that decision.
 */

type AnyFn = ReturnType<typeof vi.fn>;

const SESSION = {
  sub: "user-1",
  businessId: "biz-1",
  locationId: null,
  role: "manager",
  imp: undefined as string | undefined,
};

const mocks = vi.hoisted(() => ({
  requireMember: vi.fn() as AnyFn,
  withTenant: vi.fn(
    async (_id: string, fn: () => Promise<unknown>) => fn(),
  ) as AnyFn,
  issueDeviceLoginCode: vi.fn(async () => ({ code: "login-code-1" })) as AnyFn,
  accessibleLocationsFor: vi.fn(async () => ({
    locations: [{ id: "loc-1" }, { id: "loc-2" }],
  })) as AnyFn,
  desktopLoginLink: vi.fn((code: string, state: string) => `businesssuite://login?code=${code}&state=${state}`) as AnyFn,
  // Spies on the exemption machinery. Asserted *not* to have been called: this
  // path has no routine challenge, so there is nothing for trust to waive.
  verifyTrustedDevice: vi.fn(async () => ({ trusted: true, reason: "trusted" })) as AnyFn,
  readTrustedDeviceToken: vi.fn(() => "tdev_presented") as AnyFn,
  issueTrustedDevice: vi.fn(async () => ({ token: "tdev_new", expiresAt: new Date() })) as AnyFn,
}));

vi.mock("@/lib/auth", () => ({ requireMember: mocks.requireMember }));
vi.mock("@/lib/db", () => ({ withTenant: mocks.withTenant }));
vi.mock("@/lib/desktop-cloud-login-service", () => ({
  issueDeviceLoginCode: mocks.issueDeviceLoginCode,
}));
vi.mock("@/lib/setup-state", () => ({
  accessibleLocationsFor: mocks.accessibleLocationsFor,
}));
vi.mock("@/lib/trusted-device", () => ({
  verifyTrustedDevice: mocks.verifyTrustedDevice,
  readTrustedDeviceToken: mocks.readTrustedDeviceToken,
  issueTrustedDevice: mocks.issueTrustedDevice,
}));
vi.mock("@/lib/desktop-cloud-login", () => ({
  desktopLoginLink: mocks.desktopLoginLink,
  isLoginToken: (v: unknown) => typeof v === "string" && v.length === 64,
}));

const { POST } = await import("./route");

const DEVICE = "11111111-2222-4333-8444-555555555555";
const STATE = "a".repeat(64);

function post(body: Record<string, unknown> = {}) {
  return new NextRequest("http://localhost/api/auth/desktop-login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state: STATE, device: DEVICE, ...body }),
  });
}

beforeEach(() => {
  // Re-established each time: clearAllMocks wipes call history but not
  // implementations, so a test that installs a refusal would otherwise leak.
  vi.clearAllMocks();
  mocks.requireMember.mockResolvedValue({ error: null, session: { ...SESSION } });
  mocks.withTenant.mockImplementation(async (_id: string, fn: () => Promise<unknown>) => fn());
  mocks.issueDeviceLoginCode.mockResolvedValue({ code: "login-code-1" });
  mocks.accessibleLocationsFor.mockResolvedValue({ locations: [{ id: "loc-1" }, { id: "loc-2" }] });
});

describe("desktop cloud-login hand-off — assurance rides the existing session (gap 4)", () => {
  it("mints a hand-off link for a live, own session", async () => {
    const res = await POST(post());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.url).toContain("login-code-1");
    expect(mocks.issueDeviceLoginCode).toHaveBeenCalledTimes(1);
  });

  it("refuses an unauthenticated caller and mints nothing", async () => {
    mocks.requireMember.mockResolvedValue({
      error: new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
      session: null,
    });

    const res = await POST(post());

    expect(res.status).toBe(401);
    expect(mocks.issueDeviceLoginCode).not.toHaveBeenCalled();
  });

  it("refuses a session the chain no longer backs (identity revoked elsewhere)", async () => {
    mocks.requireMember.mockResolvedValue({
      error: new Response(JSON.stringify({ error: "session_expired" }), { status: 401 }),
      session: null,
    });

    const res = await POST(post());

    expect(res.status).toBe(401);
    expect(mocks.issueDeviceLoginCode).not.toHaveBeenCalled();
  });

  it("refuses a platform operator's support session: it acts in the business, not as the member", async () => {
    mocks.requireMember.mockResolvedValue({
      error: null,
      session: { ...SESSION, imp: "platform-admin-9" },
    });

    const res = await POST(post());

    expect(res.status).toBe(403);
    expect(mocks.issueDeviceLoginCode).not.toHaveBeenCalled();
  });

  it("binds the code to one paired device and to the branches the member may work in", async () => {
    await POST(post());

    expect(mocks.issueDeviceLoginCode).toHaveBeenCalledWith({
      businessId: SESSION.businessId,
      userId: SESSION.sub,
      devicePublicId: DEVICE,
      state: STATE,
      accessibleLocationIds: ["loc-1", "loc-2"],
    });
  });

  it("refuses a malformed state or device before issuing anything", async () => {
    const badState = await POST(post({ state: "short" }));
    expect(badState.status).toBe(400);

    const badDevice = await POST(post({ device: "not-a-uuid" }));
    expect(badDevice.status).toBe(400);

    expect(mocks.issueDeviceLoginCode).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON at all", async () => {
    const res = await POST(post({ state: null, device: null }));

    expect(res.status).toBe(400);
    expect(mocks.issueDeviceLoginCode).not.toHaveBeenCalled();
  });

  it("answers 404 when the device is not a paired install of this business", async () => {
    mocks.issueDeviceLoginCode.mockResolvedValue({ error: "unknown_device" });

    const res = await POST(post());

    expect(res.status).toBe(404);
  });

  it("never consults trusted-device state: the cloud door already made that call", async () => {
    const res = await POST(post());

    // Asserted on a hand-off that actually succeeded, so a short-circuited
    // response cannot pass this vacuously.
    expect(res.status).toBe(200);
    expect(mocks.issueDeviceLoginCode).toHaveBeenCalledTimes(1);

    // Device trust exempts a *routine challenge*. This path runs no challenge
    // — the password or PIN door on the cloud origin already made that
    // decision — so a stale seven-day row must have no purchase here.
    expect(mocks.verifyTrustedDevice).not.toHaveBeenCalled();
    expect(mocks.readTrustedDeviceToken).not.toHaveBeenCalled();
    expect(mocks.issueTrustedDevice).not.toHaveBeenCalled();
  });
});
