import { describe, expect, it } from "vitest";
import { combineTours, parseTourStudioInput, TourStudioError } from "./tour-catalogue-service";
import { PERMISSIONS } from "./permissions";
import { TOURS } from "./tours";

const base = {
  id: "accounting.products.welcome",
  pageKey: "page:/accounting/products",
  title: "راهنمای محصولات",
  description: "شروع کار",
  status: "published" as const,
  eligibility: { permissions: [PERMISSIONS.inventoryView] },
  steps: [
    { id: "welcome", kind: "explain", title: "خوش آمدید", body: "این بخش برای مدیریت محصولات است." },
  ],
};
describe("platform-authored tour validation", () => {
  it("accepts a Persian explain-only tour for any known page", () => {
    expect(parseTourStudioInput({ ...base, pageKey: "page:/accounting/cosmetics" }))
      .toMatchObject({ status: "published", steps: [{ id: "welcome", kind: "explain" }] });
  });
  it("rejects unknown routes and unregistered highlight targets", () => {
    expect(() => parseTourStudioInput({ ...base, pageKey: "page:/private" })).toThrowError(TourStudioError);
    expect(() => parseTourStudioInput({ ...base,
      steps: [{ id: "x", kind: "spotlight", anchor: "fake.dom", title: "x", body: "x" }],
    })).toThrowError("unknown_anchor");
  });
  it("rejects invalid roles, industries, duplicate ids and oversized tour metadata", () => {
    expect(() => parseTourStudioInput({ ...base, eligibility: { permissions: ["platform-admin"] } })).toThrowError("unknown_permission");
    expect(() => parseTourStudioInput({ ...base, eligibility: { industries: ["unknown"] } })).toThrowError("unknown_industry");
    expect(() => parseTourStudioInput({ ...base, steps: [...base.steps, base.steps[0]] })).toThrowError("invalid_tour");
    expect(() => parseTourStudioInput({ ...base, title: "A".repeat(161) })).toThrowError("invalid_title");
  });
  it("does not allow public publishing of an unguarded page", () => {
    expect(() => parseTourStudioInput({ ...base, eligibility: {} })).toThrowError("publishing_requires_eligibility");
    expect(parseTourStudioInput({ ...base, status: "draft", eligibility: {} }).status).toBe("draft");
  });
  it("validates per-step eligibility and refuses malicious or unknown access flags", () => {
    expect(() => parseTourStudioInput({ ...base, steps: [{ ...base.steps[0], eligibility: { permissions: ["bogus"] } }] }))
      .toThrowError("unknown_permission");
    expect(() => parseTourStudioInput({ ...base, eligibility: { unexpected: true } })).toThrowError("invalid_eligibility");
  });
});
describe("backward compatible member catalogue", () => {
  it("preserves all existing code tours until a published one overrides its id", () => {
    const existing = TOURS.find((t) => t.id === "accounting.products.list")!;
    const newStep = { id: "hello", kind: "explain" as const, title: "درود", body: "شرح راهنما" };
    const authored = { ...existing, version: 2, steps: [newStep] };
    expect(combineTours([existing], [])).toEqual([existing]);
    expect(combineTours([existing], [authored])).toEqual([authored]);
    expect(combineTours([existing], [authored])).toHaveLength(1);
  });
});
