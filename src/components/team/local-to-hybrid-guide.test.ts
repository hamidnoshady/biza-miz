import { describe, expect, it } from "vitest";
import { buildConversionPreview, type ConversionMember } from "./local-to-hybrid-guide";

const members: ConversionMember[] = [
  { id: "local-owner", fullName: "Owner", email: "owner@example.com", role: "owner", isActive: true },
  { id: "local-staff", fullName: "Staff", email: "staff@example.com", role: "staff", isActive: true },
  { id: "old", fullName: "Old", email: null, role: "staff", isActive: false },
];

describe("Local to Hybrid conversion guide", () => {
  it("requires a valid mapped active Owner and marks unmapped active members for invitation", () => {
    const preview = buildConversionPreview(members, {
      "local-owner": "10000000-0000-4000-8000-000000000001",
    });
    expect(preview.errors).toEqual([]);
    expect(preview.identityMap).toEqual({ "local-owner": "10000000-0000-4000-8000-000000000001" });
    expect(preview.mapped.map((member) => member.id)).toEqual(["local-owner"]);
    expect(preview.disabled.map((member) => member.id)).toEqual(["local-staff"]);
  });

  it("blocks malformed Cloud IDs and a conversion without a mapped Owner", () => {
    const preview = buildConversionPreview(members, { "local-staff": "not-a-cloud-id" });
    expect(preview.errors).toContain("شناسهٔ ابری «Staff» معتبر نیست.");
    expect(preview.errors).toContain("حداقل یک مالک فعال باید به هویت ابری نگاشت شود.");
    expect(preview.identityMap).toEqual({});
  });
});
