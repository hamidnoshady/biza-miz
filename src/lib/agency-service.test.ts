import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ industry: vi.fn(), setting: vi.fn() }));
vi.mock("./db", () => ({ query: vi.fn(), withTenantTransaction: vi.fn() }));
vi.mock("./industry-guard", () => ({ getBusinessIndustry: m.industry }));
vi.mock("./settings", () => ({
  getSetting: m.setting,
  setSetting: vi.fn(),
  SETTING_KEYS: { agencyProfile: "agency_profile" },
}));
import {
  readAgencyOperatingProfile,
  readAgencyOperatingProfiles,
} from "./agency-service";
beforeEach(() => {
  vi.clearAllMocks();
  m.industry.mockResolvedValue("advertising_agency");
  m.setting.mockResolvedValue(null);
});
describe("combined agency profile reader", () => {
  it("does not read/offer an agency setting for another industry", async () => {
    m.industry.mockResolvedValue("restaurant");
    expect(await readAgencyOperatingProfiles("tenant")).toEqual([]);
    expect(m.setting).not.toHaveBeenCalled();
  });
  it("preserves default primary behavior", async () => {
    const profiles = await readAgencyOperatingProfiles("tenant");
    expect(profiles).toEqual([await readAgencyOperatingProfile("tenant")]);
  });
  it("reads primary plus validated unique secondary specialties without mutating storage", async () => {
    m.setting.mockResolvedValue({
      operatingProfile: "outdoor_print",
      specialties: [
        "content_video",
        "content_video",
        "outdoor_print",
        "contractor",
      ],
      updatedAt: null,
    });
    expect(await readAgencyOperatingProfiles("tenant")).toEqual([
      "outdoor_print",
      "content_video",
    ]);
    expect(await readAgencyOperatingProfile("tenant")).toBe("outdoor_print");
  });
});
