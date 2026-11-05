import { describe, expect, it } from "vitest";
import {
  MAX_LATIN_TEMPLATE_CHARS,
  MAX_PERSIAN_TEMPLATE_CHARS,
  lookupTemplateName,
  needsProviderUpdate,
  revisionPlan,
  stateForProviderApproval,
  tenantTemplateStatus,
  toTenantLookupTemplates,
  validateLookupTemplate,
} from "./template-service";

const businessId = "9f1d2c3b-4a5e-4f60-8a7b-0c1d2e3f4a5b";

describe("template validation", () => {
  it("accepts a Persian verification message with a token", () => {
    const result = validateLookupTemplate({
      title: "کد ورود",
      body: "کد ورود شما %token است.",
      purpose: "verification",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.title).toBe("کد ورود");
  });

  it("accepts numbered tokens up to %token20", () => {
    expect(
      validateLookupTemplate({ title: "یادآوری", body: "سفارش %token2 آماده است", purpose: "transactional" }).ok,
    ).toBe(true);
  });

  it("rejects an unknown placeholder — it would be sent literally", () => {
    const result = validateLookupTemplate({
      title: "کد",
      body: "سلام %نام، کد شما %token است",
      purpose: "verification",
    });
    expect(result).toEqual({ ok: false, code: "unsupported_token" });
  });

  it("requires a token at all", () => {
    expect(validateLookupTemplate({ title: "کد", body: "کد شما آماده است", purpose: "verification" })).toEqual({
      ok: false,
      code: "missing_token",
    });
  });

  it("applies the provider's per-script length limit", () => {
    const persian = validateLookupTemplate({
      title: "کد",
      body: `${"ا".repeat(MAX_PERSIAN_TEMPLATE_CHARS)} %token`,
      purpose: "verification",
    });
    expect(persian).toEqual({ ok: false, code: "body_too_long" });

    const latin = validateLookupTemplate({
      title: "code",
      body: `${"a".repeat(MAX_LATIN_TEMPLATE_CHARS)} %token`,
      purpose: "verification",
    });
    expect(latin).toEqual({ ok: false, code: "body_too_long" });
  });

  it("requires a first-party title the tenant can recognise", () => {
    expect(validateLookupTemplate({ title: "   ", body: "%token", purpose: "verification" })).toEqual({
      ok: false,
      code: "title_required",
    });
    expect(
      validateLookupTemplate({ title: "x".repeat(81), body: "%token", purpose: "verification" }),
    ).toEqual({ ok: false, code: "title_too_long" });
  });

  it("rejects a purpose the provider does not know", () => {
    expect(validateLookupTemplate({ title: "کد", body: "%token", purpose: "marketing" })).toEqual({
      ok: false,
      code: "unknown_purpose",
    });
  });
});

describe("provider template names", () => {
  it("are ASCII, stable and derived from the content", () => {
    const name = lookupTemplateName({ businessId, title: "کد ورود", body: "%token", purpose: "verification" });
    expect(name).toMatch(/^bmv[0-9a-f]{10}$/);
    expect(
      lookupTemplateName({ businessId, title: "کد ورود", body: "%token", purpose: "verification" }),
    ).toBe(name);
  });

  it("differ per business, purpose and body", () => {
    const base = { businessId, title: "کد ورود", body: "%token" as const };
    const first = lookupTemplateName({ ...base, purpose: "verification" });
    expect(lookupTemplateName({ ...base, purpose: "transactional" })).not.toBe(first);
    expect(lookupTemplateName({ ...base, body: "%token2", purpose: "verification" })).not.toBe(first);
    expect(
      lookupTemplateName({
        ...base,
        businessId: "00000000-0000-4000-8000-000000000000",
        purpose: "verification",
      }),
    ).not.toBe(first);
  });
});

describe("tenant-facing template status", () => {
  it("maps provider approval to an internal lifecycle and then to first-party words", () => {
    expect(stateForProviderApproval("approved")).toBe("approved");
    expect(stateForProviderApproval("pending")).toBe("submitted");
    expect(stateForProviderApproval("rejected")).toBe("rejected");
    expect(stateForProviderApproval("unknown")).toBe("submitted");

    expect(tenantTemplateStatus("approved")).toBe("ready");
    expect(tenantTemplateStatus("draft")).toBe("in_review");
    expect(tenantTemplateStatus("rejected")).toBe("needs_action");
    expect(tenantTemplateStatus("disabled")).toBe("disabled");
  });

  it("serialises only first-party fields", () => {
    const [template] = toTenantLookupTemplates([
      {
        id: "t1",
        business_id: businessId,
        name: "bmv0123456789",
        title: "کد ورود",
        body: "کد ورود شما %token است",
        purpose: "verification",
        state: "approved",
        provider_template_id: "998877",
        last_sync_error: null,
        revision: 0,
        submitted_title: "کد ورود",
        submitted_body: "کد ورود شما %token است",
        supersedes_id: null,
        // Issue #902 §5 lineage: a template a tenant wrote by hand has no
        // library origin and no declared variables.
        master_template_id: null,
        master_version: null,
        // A message a tenant wrote by hand has no declared mapping; the managed
        // send path refuses it rather than guessing one (issue #902 §5).
        variables: [],
        archived_at: null,
        submitted_at: new Date(),
        decided_at: new Date(),
        last_synced_at: new Date(),
        created_at: new Date(),
        updated_at: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);
    expect(template.statusLabel).toBe("آمادهٔ استفاده");
    expect(template).not.toHaveProperty("body");
    expect(template).not.toHaveProperty("name");
    expect(JSON.stringify(template)).not.toMatch(/998877/);
    // The provider's vocabulary must not appear anywhere in the payload.
    expect(JSON.stringify(template)).not.toMatch(/approved|pending|rejected/i);
    // No declared mapping means no automation can be attached, so the screen
    // offers none (issue #902 §5).
    expect(template!.triggers).toEqual([]);
  });

  it("offers an approved message only for the events its variables can fill", () => {
    const base = {
      id: "t1",
      business_id: businessId,
      name: "bmv0123456789",
      title: "آمادهٔ تحویل سفارش",
      body: "%token عزیز، سفارش شما در %token2 آماده است",
      purpose: "transactional" as const,
      provider_template_id: "998877",
      last_sync_error: null,
      revision: 0,
      submitted_title: null,
      submitted_body: null,
      supersedes_id: null,
      master_template_id: null,
      master_version: null,
      archived_at: null,
      submitted_at: null,
      decided_at: new Date(),
      last_synced_at: null,
      created_at: new Date(),
      updated_at: new Date("2026-01-01T00:00:00.000Z"),
    };
    const [approved] = toTenantLookupTemplates([
      { ...base, state: "approved", variables: ["customer_name", "store_name"] },
    ]);
    // An order-ready event has a customer name and a store name — and no amount.
    expect(approved!.triggers).toEqual(["order_ready"]);

    const [inReview] = toTenantLookupTemplates([
      { ...base, state: "submitted", variables: ["customer_name", "store_name"] },
    ]);
    expect(inReview!.triggers).toEqual([]);

    const [payment] = toTenantLookupTemplates([
      { ...base, state: "approved", variables: ["amount", "store_name"] },
    ]);
    expect(payment!.triggers).toEqual(["payment_received"]);
  });
});

describe("revision decisions (issue #902 §5)", () => {
  const base = {
    provider_template_id: 12345 as string | number | null,
    submitted_body: "کد ورود شما %token است",
    submitted_title: "کد ورود",
    body: "کد ورود شما %token است",
    title: "کد ورود",
  };

  it("says nothing is owed while the provider already holds this text", () => {
    expect(needsProviderUpdate(base)).toBe(false);
  });

  it("owes an update as soon as the text or the title changes", () => {
    expect(needsProviderUpdate({ ...base, body: "کد تازهٔ شما %token است" })).toBe(true);
    expect(needsProviderUpdate({ ...base, title: "کد ورود تازه" })).toBe(true);
  });

  it("owes an update when the provider copy exists but was never recorded", () => {
    // Rows created before 0260 have no snapshot; the first submit after the
    // upgrade must reconcile rather than assume the provider is current.
    expect(needsProviderUpdate({ ...base, submitted_body: null, submitted_title: null })).toBe(true);
  });

  it("never owes an update for a template the provider has not seen", () => {
    // A draft has no provider id, so the next submit is an ADDTEMPLATE, not an
    // update of something that does not exist.
    expect(needsProviderUpdate({ ...base, provider_template_id: null })).toBe(false);
  });

  it("revises a draft or a rejected template in place", () => {
    expect(revisionPlan({ state: "draft", archived_at: null })).toEqual({ kind: "in_place" });
    expect(revisionPlan({ state: "rejected", archived_at: null })).toEqual({ kind: "in_place" });
  });

  it("creates a successor for a template that is live or under review", () => {
    // Editing an approved template must not stop the automation that is
    // sending with it today, and must not replace a review already running.
    expect(revisionPlan({ state: "approved", archived_at: null })).toEqual({ kind: "new_version" });
    expect(revisionPlan({ state: "submitted", archived_at: null })).toEqual({ kind: "new_version" });
  });

  it("refuses to revise a retired template", () => {
    expect(revisionPlan({ state: "disabled", archived_at: null })).toEqual({
      kind: "forbidden",
      reason: "archived",
    });
    expect(revisionPlan({ state: "approved", archived_at: new Date() })).toEqual({
      kind: "forbidden",
      reason: "archived",
    });
  });
});
