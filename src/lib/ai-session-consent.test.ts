import { beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "./db";
import { aiConsentSessionKey, hasAiSessionConsent } from "./ai-session-consent";
import { PERMISSIONS } from "./permissions";
vi.mock("./db", () => ({ query: vi.fn() }));
const input = { businessId: "a", actorUserId: "u", sessionId: "s", auditId: "11111111-1111-4111-8111-111111111111", permissions: new Set([PERMISSIONS.workspaceManage]) };
beforeEach(() => vi.resetAllMocks());
describe("execution-time session consent", () => {
  it("denies impersonation, legacy sessions, lost permissions and malformed proposals", async () => {
    expect(aiConsentSessionKey({ employeeSessionId: "s", imp: {} })).toBeNull();
    expect(aiConsentSessionKey({})).toBeNull();
    expect(await hasAiSessionConsent({ ...input, sessionId: null })).toBe(false);
    expect(await hasAiSessionConsent({ ...input, permissions: new Set() })).toBe(false);
    expect(await hasAiSessionConsent({ ...input, auditId: "bad" })).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
  it("binds the current audited task, tenant, actor and employee session", async () => {
    vi.mocked(query).mockResolvedValue({ rows: [{ allowed: true }] } as never);
    expect(await hasAiSessionConsent(input)).toBe(true);
    expect(vi.mocked(query).mock.calls[0][1]).toEqual(["a", "u", "s", input.auditId]);
    vi.mocked(query).mockResolvedValue({ rows: [{ allowed: false }] } as never);
    expect(await hasAiSessionConsent(input)).toBe(false);
  });
});
