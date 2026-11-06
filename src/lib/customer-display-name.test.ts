import { describe, expect, it } from "vitest";
import { customerDisplayName, customerPersonName } from "./customer-display-name";

describe("customer display-name policy", () => {
  it.each([
    [{ name: "  سارا   محمدی ", phone: "09332443370" }, "سارا محمدی"],
    [{ name: "", phone: "09332443370" }, "09332443370"],
    [{ name: "09332443370@zaniziba.com", phone: "09332443370" }, "09332443370"],
    [{ name: "۰۹۳۳۲۴۴۳۳۷۰", phone: "+98 933 244 3370" }, "+98 933 244 3370"],
    [{ name: "  ", phone: " " }, "مشتری آنلاین"],
    [{ name: null, phone: "unknown" }, "مشتری آنلاین"],
    [{ name: "", phone: "+44 7700 900123" }, "+44 7700 900123"],
  ])("chooses a usable name or phone for %j", (input, expected) => {
    expect(customerDisplayName(input)).toBe(expected);
  });

  it("joins real first/last names without treating contact values as names", () => {
    expect(customerPersonName(" سارا ", " محمدی ")).toBe("سارا محمدی");
    expect(customerPersonName("", "رضایی")).toBe("رضایی");
    expect(customerPersonName("09332443370@zaniziba.com", "")).toBe("");
    expect(customerPersonName("09332443370", "")).toBe("");
  });
});
