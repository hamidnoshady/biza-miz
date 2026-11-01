import { describe, expect, it } from "vitest";
import { looksLikeHtml, storefrontText } from "./product-content-text";

describe("storefrontText — the readable half of a Gutenberg description", () => {
  it("keeps the copy and drops the blocks", () => {
    const html = "<!-- wp:paragraph -->\n<p>دستبند دست‌دوز</p>\n<!-- /wp:paragraph -->";
    expect(storefrontText(html)).toBe("دستبند دست‌دوز");
  });

  it("keeps paragraphs apart", () => {
    expect(storefrontText("<p>یک</p><p>دو</p>")).toBe("یک\nدو");
  });

  it("drops scripts and styles, which no shopper reads", () => {
    expect(storefrontText("<style>.a{color:red}</style><p>متن</p><script>alert(1)</script>")).toBe("متن");
  });

  it("decodes the entities WooCommerce actually emits", () => {
    expect(storefrontText("جعبه&nbsp;چوبی &amp; چرم&#8217;ی")).toBe("جعبه چوبی & چرم’ی");
  });

  it("collapses runs of blank lines but not the paragraphs themselves", () => {
    expect(storefrontText("<p>یک</p><br><br><br><p>دو</p>")).toBe("یک\n\nدو");
  });

  it("answers empty for a missing description rather than «null»", () => {
    expect(storefrontText(null)).toBe("");
    expect(storefrontText("")).toBe("");
    expect(storefrontText("   ")).toBe("");
  });

  it("knows when the text carries markup worth explaining to the editor", () => {
    expect(looksLikeHtml("<p>متن</p>")).toBe(true);
    expect(looksLikeHtml("متن ساده")).toBe(false);
    expect(looksLikeHtml("")).toBe(false);
  });
});
