import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockQuery, mockGate, mockAudit, mockSettings } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGate: vi.fn(),
  mockAudit: vi.fn(),
  mockSettings: vi.fn(),
}));

vi.mock("../../db", () => ({
  query: mockQuery,
  withoutTenantScope: vi.fn(),
  withTenant: vi.fn(),
}));
vi.mock("../../service-activation/app-gate-service", () => ({
  isAppServiceOperational: vi.fn().mockResolvedValue(true),
}));
vi.mock("../connections-service", () => ({
  getConnection: vi.fn().mockResolvedValue({ id: "conn-1", source_of_truth: "pos" }),
}));
vi.mock("./connection-service", () => ({
  getHolooSettingsRow: mockSettings,
  holooSqlConfigFor: vi.fn(),
  holooWebServiceConfigFor: vi.fn(),
}));
vi.mock("../../import-reconciliation/entry-guards", () => ({
  canPublishAnyConnectionOutbound: mockGate,
}));
vi.mock("../audit", () => ({
  writeIntegrationAudit: mockAudit,
}));

import { pushForConnection } from "./push-service";

describe("Holoo push reconciliation gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings.mockResolvedValue({ businessId: "biz-1", connectionId: "conn-1", write_mode: "web_service" });
  });

  it("claims nothing and audits the reason while a run owns the connection", async () => {
    mockGate.mockResolvedValueOnce({ allowed: false, reason: "reconciliation_active" });

    await expect(pushForConnection("biz-1", "conn-1")).resolves.toEqual({ attempted: 0, sent: 0 });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "holoo.push_blocked",
        payload: { reason: "reconciliation_active" },
      }),
    );
  });

  it("claims the next batch once the gate is clear", async () => {
    mockGate.mockResolvedValueOnce({ allowed: true });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await expect(pushForConnection("biz-1", "conn-1")).resolves.toEqual({ attempted: 0, sent: 0 });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(String(mockQuery.mock.calls[0]?.[0])).toContain("integration_outbox_events");
  });
});
