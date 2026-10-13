import { describe, expect, it } from "vitest";
import type { Party } from "./parties-service";
import { projectPartyForRead } from "./party-read-projection";

const employee = {
  id: "party-1",
  displayName: "کارمند نمونه",
  name: "کارمند نمونه",
  roles: ["Employee"],
  role: "Employee",
  phone: "09120000000",
  email: "employee@example.test",
  address: "نشانی خصوصی",
  notes: "یادداشت خصوصی",
  birthday: "2000-01-01",
  generalInfo: { nationalId: "0012345678", economicCode: "123", taxPercentage: 9 },
  addressInfo: { city: "تهران" },
  contactInfo: { emergency: "09121111111" },
  financialInfo: { iban: "IR000000" },
  accountingCode: "130001",
  accountingCodeMode: "Automatic",
} as unknown as Party;

describe("projectPartyForRead", () => {
  it("returns only an operational Employee projection to generic party readers", () => {
    const projected = projectPartyForRead(employee, { personnelSensitive: false, financial: false });
    expect(projected).toMatchObject({ id: "party-1", displayName: "کارمند نمونه", roles: ["Employee"] });
    expect(projected).not.toHaveProperty("phone");
    expect(projected).not.toHaveProperty("email");
    expect(projected).not.toHaveProperty("financialInfo");
    expect(projected).not.toHaveProperty("accountingCode");
    expect(projected.generalInfo).toEqual({});
  });

  it("keeps personnel fields while independently withholding finance", () => {
    const projected = projectPartyForRead(employee, { personnelSensitive: true, financial: false });
    expect(projected.phone).toBe("09120000000");
    expect(projected.generalInfo).toMatchObject({ nationalId: "0012345678", economicCode: "123" });
    expect(projected).not.toHaveProperty("financialInfo");
  });

  it("returns the complete record to approved personnel and finance readers", () => {
    expect(projectPartyForRead(employee, { personnelSensitive: true, financial: true })).toEqual(employee);
  });
});
