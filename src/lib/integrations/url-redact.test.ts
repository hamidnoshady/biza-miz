import { describe, expect, it } from "vitest";
import { capQueueError, redactPayload } from "./payload-redact";
import { scrubUrl, scrubUrls, scrubUrlsOrNull } from "./url-redact";

const SIGNED =
  "https://bucket.example.com/biz/a.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F20261027%2Fus%2Fs3%2Faws4_request&X-Amz-Date=20261027T100000Z&X-Amz-Expires=300&X-Amz-SignedHeaders=host&X-Amz-Signature=deadbeefcafe";

describe("scrubUrl", () => {
  it("masks every credential-bearing parameter of a presigned URL and keeps the object path", () => {
    const out = scrubUrl(SIGNED);
    expect(out).toContain("https://bucket.example.com/biz/a.jpg?");
    expect(out).not.toContain("deadbeefcafe");
    expect(out).not.toContain("AKIA");
    expect(out).toContain("X-Amz-Signature=•••");
    expect(out).toContain("X-Amz-Credential=•••");
  });

  it("keeps harmless parameters so the message stays diagnosable", () => {
    expect(scrubUrl("https://cdn.example.com/p.png?w=300&token=abc&v=2")).toBe(
      "https://cdn.example.com/p.png?w=300&token=•••&v=2",
    );
  });

  it("recognises a percent-encoded parameter name", () => {
    expect(scrubUrl("https://x.example/a?%74oken=abc")).toBe("https://x.example/a?%74oken=•••");
  });

  it("drops userinfo and leaves the fragment alone", () => {
    expect(scrubUrl("https://user:hunter2@host.example/a.jpg#top")).toBe("https://•••@host.example/a.jpg#top");
  });

  it("leaves a URL without a query untouched", () => {
    expect(scrubUrl("https://host.example/a.jpg")).toBe("https://host.example/a.jpg");
  });
});

describe("scrubUrls", () => {
  it("finds a URL inside a plugin error sentence", () => {
    const out = scrubUrls(`cURL error 28: Operation timed out after 30001 ms for ${SIGNED}, retrying`);
    expect(out).toContain("cURL error 28");
    expect(out).toContain(", retrying");
    expect(out).not.toContain("deadbeefcafe");
  });

  it("scrubs a URL cut off mid-signature by a length cap", () => {
    const cut = SIGNED.slice(0, SIGNED.indexOf("deadbeef") + 4);
    expect(scrubUrls(`failed: ${cut}`)).not.toContain("dead");
  });

  it("scrubs more than one URL and ignores text with none", () => {
    expect(scrubUrls("plain text")).toBe("plain text");
    const out = scrubUrls(`a ${SIGNED} b https://h.example/x?token=zzz`);
    expect(out).not.toContain("zzz");
    expect(out).not.toContain("deadbeefcafe");
  });

  it("is a no-op on empty input and tolerates null", () => {
    expect(scrubUrls("")).toBe("");
    expect(scrubUrlsOrNull(null)).toBeNull();
    expect(scrubUrlsOrNull(undefined)).toBeNull();
    expect(scrubUrlsOrNull(`x ${SIGNED}`)).not.toContain("deadbeefcafe");
  });
});

describe("queue display uses the scrub", () => {
  it("scrubs a signed URL in a stored error before the list shows it", () => {
    expect(capQueueError(`Could not download ${SIGNED}`)).not.toContain("deadbeefcafe");
  });

  it("scrubs a signed URL that a legacy row kept in its payload", () => {
    const out = redactPayload({ __mediaAssetId: "a", url: SIGNED, title: "x" }) as Record<string, string>;
    expect(out.url).not.toContain("deadbeefcafe");
    expect(out.url).toContain("bucket.example.com/biz/a.jpg");
    expect(out.title).toBe("x");
  });

  it("scrubs before truncating so a long URL cannot leave a signature prefix behind", () => {
    const long = `https://h.example/${"p".repeat(480)}?X-Amz-Signature=deadbeefcafe`;
    const out = redactPayload({ url: long }) as Record<string, string>;
    expect(out.url).not.toContain("deadbeef");
  });
});
