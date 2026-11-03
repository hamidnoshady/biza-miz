import { describe, expect, it } from "vitest";
import {
  decodeWpEntities,
  editableWpField,
  excerptPreview,
  mirroredContent,
  plainTitle,
  safeWpUrl,
} from "./wp-content-service";

/**
 * The title/entity normalisation is the one part of the WordPress content
 * mirror that is pure — and the part a user reads on every row of the WP
 * Manager's content list. WordPress runs titles through `wptexturize`, so a
 * post literally called «Café's “Menu”…» arrives with typographic entities;
 * a decoder that misses them leaves raw `&#8217;` in front of the owner.
 */
describe("decodeWpEntities", () => {
  it("decodes the decimal numeric entities wptexturize emits", () => {
    // Apostrophe, curly quotes, ellipsis, en/em dashes — the common ones.
    expect(decodeWpEntities("Caf&#233;&#8217;s")).toBe("Café’s");
    expect(decodeWpEntities("&#8220;quoted&#8221;")).toBe("\u201cquoted\u201d");
    expect(decodeWpEntities("wait&#8230;")).toBe("wait…");
    expect(decodeWpEntities("a&#8211;b&#8212;c")).toBe("a–b—c");
  });

  it("decodes hex numeric entities in either case", () => {
    expect(decodeWpEntities("&#x2019;")).toBe("\u2019");
    expect(decodeWpEntities("&#X2019;")).toBe("\u2019");
    expect(decodeWpEntities("&#x2013;")).toBe("–");
  });

  it("decodes the named entities WordPress uses", () => {
    expect(decodeWpEntities("A&nbsp;B")).toBe("A B");
    expect(decodeWpEntities("Tom&hellip;")).toBe("Tom…");
    expect(decodeWpEntities("&laquo;نقل&raquo;")).toBe("«نقل»");
    expect(decodeWpEntities("&copy;2026 &reg; &trade;")).toBe("©2026 ® ™");
    expect(decodeWpEntities("&lt;tag&gt; &quot;q&quot; &apos;a&apos;")).toBe("<tag> \"q\" 'a'");
  });

  it("resolves &amp; last so a double-encoded entity survives one pass", () => {
    // `&amp;#8217;` must become `&#8217;`, never `&` mid-entity — otherwise
    // the rest of the entity is stranded as literal text.
    expect(decodeWpEntities("&amp;#8217;")).toBe("&#8217;");
    expect(decodeWpEntities("Ben &amp; Jerry")).toBe("Ben & Jerry");
  });

  it("leaves an unknown or malformed entity untouched rather than dropping text", () => {
    expect(decodeWpEntities("100&percnt; sure")).toBe("100&percnt; sure");
    expect(decodeWpEntities("plain text")).toBe("plain text");
  });

  it("drops an out-of-range numeric code point instead of throwing", () => {
    // 0x110000 is past the Unicode ceiling; String.fromCodePoint would throw.
    expect(decodeWpEntities("&#1114112;")).toBe("");
    expect(decodeWpEntities("&#xFFFFFFFF;")).toBe("");
  });
});

describe("editableWpField and safeWpUrl", () => {
  it("prefers raw editor text and falls back to rendered text", () => {
    expect(editableWpField("plugin body")).toBe("plugin body");
    expect(editableWpField({ raw: "raw body", rendered: "rendered body" })).toBe("raw body");
    expect(editableWpField({ rendered: "rendered body" })).toBe("rendered body");
    expect(editableWpField({ raw: 42, rendered: null })).toBe("");
  });

  it("allows only absolute HTTP(S) links", () => {
    expect(safeWpUrl("https://example.com/post?q=1")).toBe("https://example.com/post?q=1");
    expect(safeWpUrl("http://example.com/media.jpg")).toBe("http://example.com/media.jpg");
    expect(safeWpUrl("javascript:alert(1)")).toBe("");
    expect(safeWpUrl("data:text/html,test")).toBe("");
    expect(safeWpUrl("/relative-link")).toBe("");
  });
});

describe("plainTitle", () => {
  it("reads a bare string and a WordPress { rendered } object alike", () => {
    expect(plainTitle("Hello")).toBe("Hello");
    expect(plainTitle({ rendered: "Hello" })).toBe("Hello");
  });

  it("strips HTML tags and then decodes entities", () => {
    expect(plainTitle("<span>Caf&#233;</span> &amp; Co")).toBe("Café & Co");
    expect(plainTitle({ rendered: "<em>سلام</em> &#8211; دنیا" })).toBe("سلام – دنیا");
  });

  it("trims surrounding whitespace the tags left behind", () => {
    expect(plainTitle("  <b>x</b>  ")).toBe("x");
  });

  it("is empty for a missing or wrong-shaped input, never throws", () => {
    expect(plainTitle(undefined)).toBe("");
    expect(plainTitle(null)).toBe("");
    expect(plainTitle(42)).toBe("");
    expect(plainTitle({})).toBe("");
  });
});

describe("mirroredContent", () => {
  it("returns the plugin's raw string content untouched", () => {
    expect(mirroredContent("<p>متن کامل نوشته.</p>")).toBe("<p>متن کامل نوشته.</p>");
  });

  it("prefers content.raw when the payload carries the REST edit-context shape", () => {
    expect(mirroredContent({ raw: "<p>raw</p>", rendered: "<p>rendered</p>", protected: false })).toBe(
      "<p>raw</p>",
    );
  });

  it("refuses rendered-only content — writing it back would rewrite the live HTML", () => {
    expect(mirroredContent({ rendered: "<p>wpautop wrapped</p>", protected: false })).toBeNull();
  });

  it("is null for missing or wrong-shaped payloads, never throws", () => {
    expect(mirroredContent(undefined)).toBeNull();
    expect(mirroredContent(null)).toBeNull();
    expect(mirroredContent(42)).toBeNull();
    expect(mirroredContent({ raw: 7 })).toBeNull();
    expect(mirroredContent("")).toBe("");
  });
});

/**
 * The excerpt preview is what a card shows under a post's title. It must read
 * as one clean line — a raw `&hellip;`, a stray `</p>` or a mid-word cut is
 * visible to the owner on every row.
 */
describe("excerptPreview", () => {
  it("strips tags, decodes entities and collapses whitespace", () => {
    expect(excerptPreview("<p>فرش&nbsp;دستبافت</p>\n<p>با &#8217;رنگ</p>")).toBe("فرش دستبافت با ’رنگ");
  });

  it("cuts a long excerpt on a word and marks the cut", () => {
    const preview = excerptPreview("کلمه ".repeat(60), 60);
    expect(preview.length).toBeLessThanOrEqual(61);
    expect(preview.endsWith("…")).toBe(true);
    // No half-word: the cut falls on the last space, not inside a word.
    expect(preview.replace(/…$/, "").split(" ").every((word) => word === "کلمه")).toBe(true);
  });

  it("keeps a short excerpt whole and an empty one empty", () => {
    expect(excerptPreview("خلاصهٔ کوتاه")).toBe("خلاصهٔ کوتاه");
    expect(excerptPreview("")).toBe("");
    expect(excerptPreview(null)).toBe("");
  });
});
