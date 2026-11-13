import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  query: vi.fn(),
  scope: vi.fn(),
  industry: vi.fn(),
}));
vi.mock("./db", () => ({
  query: m.query,
  withTenantTransaction: (_id: string, fn: () => unknown) => fn(),
}));
vi.mock("./workspace", () => ({ requireProjectCapability: m.scope }));
vi.mock("./agency-commercial-service", () => ({
  assertAgencyIndustry: m.industry,
}));
import { previewPostedCampaignAllocation } from "./agency-campaign-allocation-service";
const owner = {
  businessId: "tenant",
  actorUserId: "actor",
  actorName: "Actor",
};
const campaignId = "aaaaaaaa-0000-0000-0000-000000000001";
const input = {
  sourceLineId: "9007199254740993",
  targets: [{ campaignId, basisPoints: 2500 }],
};
beforeEach(() => {
  vi.clearAllMocks();
  m.scope.mockResolvedValue("owner");
  m.industry.mockResolvedValue(undefined);
  m.query.mockResolvedValue({
    rows: [
      {
        entry_id: "entry",
        account_code: "5197",
        amount_rial: "1000",
        eligible_campaign_ids: [campaignId],
      },
    ],
  });
});
describe("posted campaign allocation preview", () => {
  it("requires agency and project management before querying source facts", async () => {
    const result = await previewPostedCampaignAllocation(
      owner,
      "project",
      input,
    );
    expect(m.industry).toHaveBeenCalledWith("tenant");
    expect(m.scope).toHaveBeenCalledWith(owner, "project", "manage");
    expect(m.scope.mock.invocationCallOrder[0]).toBeLessThan(
      m.query.mock.invocationCallOrder[0],
    );
    expect(m.query).toHaveBeenCalledWith(
      expect.stringContaining("c.party_id=p.party_id"),
      ["tenant", "project", input.sourceLineId, [campaignId]],
    );
    expect(result).toMatchObject({
      previewOnly: true,
      sourceLineId: input.sourceLineId,
      sourceEntryId: "entry",
      sourceAmountRial: "1000",
      unassignedRial: "750",
    });
  });
  it("does not trust submitted amounts or source metadata", async () => {
    const result = await previewPostedCampaignAllocation(owner, "project", {
      ...input,
      amountRial: "1",
      sourceEntryId: "forged",
    });
    expect(result.sourceAmountRial).toBe("1000");
    expect(result.sourceEntryId).toBe("entry");
  });
  it("never queries after project or industry refusal", async () => {
    m.scope.mockRejectedValueOnce(new Error("project_not_found"));
    await expect(
      previewPostedCampaignAllocation(owner, "project", input),
    ).rejects.toThrow("project_not_found");
    expect(m.query).not.toHaveBeenCalled();
    m.industry.mockRejectedValueOnce(new Error("industry_mismatch"));
    await expect(
      previewPostedCampaignAllocation(owner, "project", input),
    ).rejects.toThrow("industry_mismatch");
    expect(m.query).not.toHaveBeenCalled();
  });
  it("rejects absent or ineligible sources generically", async () => {
    m.query.mockResolvedValue({ rows: [] });
    await expect(
      previewPostedCampaignAllocation(owner, "project", input),
    ).rejects.toThrow("allocation_source_not_found");
  });
  it("rejects a target outside the source project/client without returning the source", async () => {
    m.query.mockResolvedValue({
      rows: [{ amount_rial: "1000", eligible_campaign_ids: [] }],
    });
    await expect(
      previewPostedCampaignAllocation(owner, "project", input),
    ).rejects.toThrow("allocation_campaign_not_found");
  });
  it("malformed input never reaches source SQL", async () => {
    await expect(
      previewPostedCampaignAllocation(owner, "project", {
        ...input,
        sourceLineId: 1,
      }),
    ).rejects.toThrow("invalid_allocation");
    expect(m.query).not.toHaveBeenCalled();
  });
});
