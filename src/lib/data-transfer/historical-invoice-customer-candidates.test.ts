import { describe, expect, it } from "vitest";
import { historicalCustomerCandidates } from "./historical-invoice-customer-candidates";
import type { CanonicalParty } from "../import-reconciliation/resolvers";

function party(id: string, options: Partial<CanonicalParty> = {}): CanonicalParty {
  return { id, name: "علی اکبری", phones: ["+989121234567"], verifiedPhones: [], emails: [], roles: ["customer"], isGuest: false, isArchived: false, ...options };
}
describe("historical customer review candidates", () => {
  it("offers normalized phone and name as hints, never as a verified binding", () => {
    const result = historicalCustomerCandidates({ sourceName: "علي اكبری", sourcePhone: "۰۹۱۲ ۱۲۳ ۴۵۶۷",
      customers: [party("1", { verifiedPhones: ["+989121234567"] })] });
    expect(result).toEqual({ candidates: [{ partyId: "1", name: "علی اکبری", matchedOn: ["phone", "name"] }], truncated: false });
    expect(result).not.toHaveProperty("partyId");
  });
  it("shows conflicting phone and name matches separately, and excludes ineligible records", () => {
    const result = historicalCustomerCandidates({ sourceName: "علی اکبری", sourcePhone: "09121234567", customers: [
      party("phone", { name: "Other" }), party("name", { phones: [] }),
      party("supplier", { roles: ["supplier"] }), party("archived", { isArchived: true }), party("guest", { isGuest: true }),
    ] });
    expect(result.candidates.map((c) => c.partyId).sort()).toEqual(["name", "phone"]);
    expect(result.candidates.find((c) => c.partyId === "phone")?.matchedOn).toEqual(["phone"]);
    expect(result.candidates.find((c) => c.partyId === "name")?.matchedOn).toEqual(["name"]);
  });
  it("reports truncated candidates and never creates a customer for missing hints", () => {
    expect(historicalCustomerCandidates({ sourceName: "علی اکبری", customers: [party("1"), party("2")], limit: 1 })).toMatchObject({ truncated: true, candidates: [{ name: "علی اکبری" }] });
    expect(historicalCustomerCandidates({ sourceName: "-", sourcePhone: "12", customers: [party("1")] })).toEqual({ candidates: [], truncated: false });
  });
});
