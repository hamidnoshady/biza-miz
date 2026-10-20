import { canPushWpMedia } from "./wp-media";
import { describe, expect, it } from "vitest";
import {
  WP_MEDIA_TITLE_MAX,
  isWpMediaKind,
  parseWpMediaCreateInput,
  safeWpExternalUrl,
  wpMediaKindForMime,
} from "./wp-media";

describe("WordPress media MIME groups", () => {
  it("groups image, video and audio MIME types and treats every other file as a document", () => {
    expect(wpMediaKindForMime("image/webp")).toBe("image");
    expect(wpMediaKindForMime("VIDEO/mp4")).toBe("video");
    expect(wpMediaKindForMime(" audio/mpeg ")).toBe("audio");
    expect(wpMediaKindForMime("application/pdf")).toBe("document");
    expect(wpMediaKindForMime(null)).toBe("document");
  });

  it("accepts only the filter values the API understands", () => {
    for (const value of ["all", "image", "video", "audio", "document"]) {
      expect(isWpMediaKind(value)).toBe(true);
    }
    expect(isWpMediaKind("attachment")).toBe(false);
    expect(isWpMediaKind(null)).toBe(false);
  });
});

describe("WordPress external media URLs", () => {
  it("allows ordinary absolute HTTP and HTTPS links", () => {
    expect(safeWpExternalUrl("https://shop.example.com/uploads/عکس.jpg")).toBe(
      "https://shop.example.com/uploads/%D8%B9%DA%A9%D8%B3.jpg",
    );
    expect(safeWpExternalUrl(" http://cdn.example.com/file.pdf ")).toBe("http://cdn.example.com/file.pdf");
  });

  it("rejects executable, local, credential-bearing and oversized href values", () => {
    expect(safeWpExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeWpExternalUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeWpExternalUrl("/wp-content/a.jpg")).toBeNull();
    expect(safeWpExternalUrl("https://user:pass@shop.example.com/a.jpg")).toBeNull();
    expect(safeWpExternalUrl(`https://shop.example.com/${"a".repeat(2050)}`)).toBeNull();
  });
});

describe("parseWpMediaCreateInput", () => {
  it("accepts an http(s) URL and a trimmed optional title", () => {
    const parsed = parseWpMediaCreateInput({ url: " https://cdn.example.com/banner.jpg ", title: "  بنر " });
    expect(parsed).toEqual({ ok: true, input: { url: "https://cdn.example.com/banner.jpg", title: "بنر" } });

    const untitled = parseWpMediaCreateInput({ url: "http://cdn.example.com/a.png", title: "   " });
    expect(untitled).toEqual({ ok: true, input: { url: "http://cdn.example.com/a.png", title: null } });
  });

  it("rejects every URL safeWpExternalUrl rejects — scheme, credentials, relative, oversized, missing", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "https://user:pass@cdn.example.com/a.jpg",
      "/uploads/a.jpg",
      `https://cdn.example.com/${"a".repeat(2050)}`,
      "",
      undefined,
      42,
    ]) {
      expect(parseWpMediaCreateInput({ url })).toEqual({ ok: false, error: "invalid_media_url" });
    }
  });

  it("rejects a title longer than the cap and a non-string title becomes null", () => {
    expect(
      parseWpMediaCreateInput({ url: "https://cdn.example.com/a.jpg", title: "x".repeat(WP_MEDIA_TITLE_MAX + 1) }),
    ).toEqual({ ok: false, error: "media_title_too_long" });
    expect(parseWpMediaCreateInput({ url: "https://cdn.example.com/a.jpg", title: 7 })).toEqual({
      ok: true,
      input: { url: "https://cdn.example.com/a.jpg", title: null },
    });
  });
});

describe("current plugin importer MIME contract", () => {
  it.each(["image/jpeg", "image/png", "image/gif", "image/webp"])("permits %s", (mime) => {
    expect(canPushWpMedia(mime)).toBe(true);
  });
  it.each(["video/mp4", "audio/mpeg", "application/pdf", "image/svg+xml", "image/avif", "text/html", null, undefined])("does not advertise unsupported %s", (mime) => {
    expect(canPushWpMedia(mime)).toBe(false);
  });
});


it.each(["mp4", "mp3", "pdf", "svg", "avif"])("URL creation rejects unsupported .%s files before queuing", (ext) => {
  expect(parseWpMediaCreateInput({ url: `https://cdn.example.com/file.${ext}` })).toEqual({ ok: false, error: "unsupported_media_type" });
});

it("accepts supported image filenames with signed query strings", () => {
  expect(parseWpMediaCreateInput({ url: "https://cdn.example.com/file.png?signature=abc" }).ok).toBe(true);
});
