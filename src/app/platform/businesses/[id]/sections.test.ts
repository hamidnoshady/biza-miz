import { describe, expect, it } from "vitest";
import { CAPABILITIES_FOR } from "@/lib/platform-admin";
import { businessSections } from "./sections";

const BUSINESS_ID = "business-1";

function labelsFor(role: "support" | "engineer" | "owner") {
  return businessSections(BUSINESS_ID, CAPABILITIES_FOR(role)).map((section) => section.label);
}

describe("business workspace navigation", () => {
  it("gives the owner each distinct detail section beneath the selected business", () => {
    const sections = businessSections(BUSINESS_ID, CAPABILITIES_FOR("owner"));
    const hrefs = sections.map((section) => section.href);

    // Migration 0176: the `plan` section is gone — it redirects into the
    // consolidated commercial section (`billing?tab=subscription`).
    expect(hrefs).toEqual([
      "/platform/businesses/business-1",
      "/platform/businesses/business-1/profile",
      "/platform/businesses/business-1/settings",
      "/platform/businesses/business-1/billing",
      "/platform/businesses/business-1/features",
      "/platform/businesses/business-1/devices",
      "/platform/businesses/business-1/support",
      "/platform/businesses/business-1/danger",
    ]);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("separates devices & installations from the entitlement switches (issue #755 §15)", () => {
    // Pairing is owner-only operational device management; an engineer who may
    // toggle flags must not be offered a credential's controls.
    expect(labelsFor("owner")).toContain("دستگاه‌ها و نصب‌ها");
    expect(labelsFor("engineer")).not.toContain("دستگاه‌ها و نصب‌ها");
    expect(labelsFor("support")).not.toContain("دستگاه‌ها و نصب‌ها");

    const features = businessSections(BUSINESS_ID, CAPABILITIES_FOR("owner")).find(
      (section) => section.href.endsWith("/features"),
    );
    expect(features?.hint).not.toContain("جفت‌سازی");
    const devices = businessSections(BUSINESS_ID, CAPABILITIES_FOR("owner")).find(
      (section) => section.href.endsWith("/devices"),
    );
    expect(devices?.hint).toContain("اتصال");
  });

  it("shows the consolidated billing section to every admin (billing.view) while hiding destructive entries", () => {
    const support = labelsFor("support");
    expect(support).toContain("تنظیمات کسب‌وکار");
    expect(support).toContain("برنامه‌ها و قابلیت‌ها");
    expect(support).toContain("دسترسی پشتیبانی");
    // Billing reads ride `billing.view`, which every role holds; the write
    // actions inside the page are re-checked server-side per capability.
    expect(support).toContain("صورت‌حساب و اشتراک");
    expect(support).not.toContain("منطقهٔ خطر");
    // Owner & managers is a read surface for every role — support needs the
    // owner's contact to diagnose an account — while only an owner edits it.
    expect(support).toContain("مالک و مدیران");

    const engineer = labelsFor("engineer");
    expect(engineer).toContain("صورت‌حساب و اشتراک");
    expect(engineer).not.toContain("منطقهٔ خطر");
  });

  it("shows the destructive entry only to the role that holds an eligible destructive capability", () => {
    // Visibility is only UI honesty; platform API tests separately assert the
    // server-side capability guards. This makes the detail menu match, rather
    // than replace, that boundary.
    expect(labelsFor("owner")).toContain("منطقهٔ خطر");
    expect(labelsFor("support")).not.toContain("منطقهٔ خطر");
    expect(labelsFor("engineer")).not.toContain("منطقهٔ خطر");
  });
});
