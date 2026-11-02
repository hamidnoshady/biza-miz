import { describe, expect, it } from "vitest";
import { publicationFailureCopy, storeListFailureCopy } from "./product-publication-copy";

/**
 * Issue #1207 §D — "friendly offline / plugin-incompatible states rather than
 * raw error codes". Every assertion here is about what a shop owner reads, so
 * they also check the absence of the code itself: a message that leaks
 * `publication_…` is the bug this module exists to fix.
 */
describe("publication failures in the reader's words", () => {
  it("says the store is offline and what to do, never the raw code", () => {
    const copy = publicationFailureCopy("publication_connection_unavailable");
    expect(copy.tone).toBe("offline");
    expect(copy.retryable).toBe(true);
    expect(copy.message).toContain("در دسترس نیست");
    expect(copy.message).not.toContain("publication_");
  });

  it("names the out-of-date plugin as the cause and asks for an update first", () => {
    const copy = publicationFailureCopy("publication_plugin_update_required");
    expect(copy.tone).toBe("plugin");
    // Nothing on this screen can fix a stale plugin, so a retry is not offered.
    expect(copy.retryable).toBe(false);
    expect(copy.message).toContain("افزونه");
    expect(copy.message).not.toContain("publication_");
  });

  it("tells the reader which local fact is missing instead of refusing silently", () => {
    expect(publicationFailureCopy("publication_sale_price_missing").message).toContain("قیمت فروش");
    expect(publicationFailureCopy("attribute_mapping_required").message).toContain("نگاشت ویژگی");
    expect(publicationFailureCopy("publication_permission_denied").tone).toBe("permission");
  });

  it("treats a changed plan as a re-review, not as a failure of the store", () => {
    const copy = publicationFailureCopy("publication_preview_changed");
    expect(copy.tone).toBe("review");
    expect(copy.message).toContain("بازبینی");
  });

  it("reads an unknown review sub-code as a review problem, not as 'unknown'", () => {
    // The review token carries a reason suffix; only the common ones have their
    // own sentence, but the tone is still the reader's next step.
    expect(publicationFailureCopy("publication_review:something_new")).toMatchObject({ tone: "review", retryable: true });
    expect(publicationFailureCopy("attribute_version_conflict").tone).toBe("data");
  });

  it("distinguishes a request that never arrived from a code it does not know", () => {
    const offline = publicationFailureCopy(undefined);
    expect(offline.tone).toBe("offline");
    expect(offline.message).toContain("ارتباط با سرور");
    const unknown = publicationFailureCopy("publication_something_new");
    expect(unknown.tone).toBe("unknown");
    expect(unknown.message).toContain("ارسال انجام نشد");
    // Both are retryable, and neither echoes the code.
    expect(unknown.retryable).toBe(true);
    expect(unknown.message).not.toContain("publication_");
    expect(publicationFailureCopy("").tone).toBe("offline");
    // The shared `api()` helper's own two transport codes are the same story.
    expect(publicationFailureCopy("network_error").tone).toBe("offline");
    expect(publicationFailureCopy("timeout").message).toContain("ارتباط با سرور");
  });

  it("covers the store-list read too", () => {
    expect(storeListFailureCopy("forbidden")).toContain("مدیریت اتصال");
    expect(storeListFailureCopy(undefined)).toContain("شبکه");
    expect(storeListFailureCopy("boom")).not.toContain("boom");
  });
});
