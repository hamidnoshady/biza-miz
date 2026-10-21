import { describe, expect, it } from "vitest";
import {
  buildKbCategoryTree,
  decodeKbHeadingHash,
  kbCategoryAncestors,
  kbHeadingSlug,
  kbHeadingTargetForHash,
  kbHeadings,
  kbHighlightSegments,
  kbSnippet,
  isKbSlug,
  kbVideoKind,
  kbVideoSource,
  normalizeKbSearchText,
  normalizeSectionKeys,
  parseHttpUrl,
  stripMarkdown,
  suggestKbSlug,
} from "./knowledge";

describe("knowledge slugs", () => {
  it("accepts clean ASCII slugs only", () => {
    expect(isKbSlug("pos-basics")).toBe(true);
    expect(isKbSlug("pos")).toBe(true);
    expect(isKbSlug("pos_basics")).toBe(false);
    expect(isKbSlug("Pos-Basics")).toBe(false);
    expect(isKbSlug("-pos")).toBe(false);
    expect(isKbSlug("pos-")).toBe(false);
    expect(isKbSlug("fa-صندوق")).toBe(false);
    expect(isKbSlug("")).toBe(false);
  });

  it("suggests a slug from latin characters and drops the rest", () => {
    expect(suggestKbSlug("POS Basics")).toBe("pos-basics");
    expect(suggestKbSlug("راهنمای POS صندوق")).toBe("pos");
    expect(suggestKbSlug("  hello   world ")).toBe("hello-world");
  });

  it("suggests nothing for a fully Persian title — the console asks instead", () => {
    expect(suggestKbSlug("راهنمای صندوق")).toBe("");
  });
});

describe("kbHeadingSlug", () => {
  it("keeps Persian letters and turns spaces into dashes", () => {
    expect(kbHeadingSlug("ثبت سفارش جدید")).toBe("ثبت-سفارش-جدید");
  });

  it("turns نیم‌فاصله into a dash and strips diacritics and punctuation", () => {
    expect(kbHeadingSlug("میزبان‌ها (هاست)")).toBe("میزبان-ها-هاست");
    expect(kbHeadingSlug("ثبت‌نام: مرحلهٔ یک")).toBe("ثبت-نام-مرحله-یک");
  });

  it("lowercases latin text", () => {
    expect(kbHeadingSlug("API Token")).toBe("api-token");
  });

  it("returns an empty string for text that is only punctuation", () => {
    expect(kbHeadingSlug("!!!")).toBe("");
  });
});

describe("kbHeadings", () => {
  it("lists ##-#### headings in order with anchors, skipping the H1 title", () => {
    const md = ["# عنوان مقاله", "## بخش یک", "متن", "### جزئیات", "## بخش دو"].join("\n");
    expect(kbHeadings(md)).toEqual([
      { depth: 2, text: "بخش یک", id: "بخش-یک", line: 2 },
      { depth: 3, text: "جزئیات", id: "جزئیات", line: 4 },
      { depth: 2, text: "بخش دو", id: "بخش-دو", line: 5 },
    ]);
  });

  it("disambiguates repeated headings with a numeric suffix", () => {
    const md = "## معرفی\n## معرفی\n## معرفی";
    expect(kbHeadings(md).map((h) => h.id)).toEqual(["معرفی", "معرفی-2", "معرفی-3"]);
  });

  it("ignores headings inside fenced code blocks", () => {
    const md = ["```markdown", "## نه یک تیتر", "```", "## بله یک تیتر", "~~~", "### هم نه", "~~~"].join("\n");
    expect(kbHeadings(md).map((h) => h.text)).toEqual(["بله یک تیتر"]);
  });

  it("strips inline marks from the heading text", () => {
    const first = kbHeadings("## فروش **آنلاین** و [سایت](https://x.test)")[0];
    expect(first.depth).toBe(2);
    expect(first.text).toBe("فروش آنلاین و سایت");
    expect(first.id).toBe("فروش-آنلاین-و-سایت");
    expect(first.line).toBe(1);
  });

  it("falls back to a stable id for a markup-only heading", () => {
    expect(kbHeadings("## ![]()")[0].id).toBe("section");
  });
});

describe("kbVideoKind", () => {
  it("classifies direct video files as a player source", () => {
    expect(kbVideoKind("https://cdn.example.com/help/pos-intro.mp4")).toBe("file");
    expect(kbVideoKind("https://cdn.example.com/a.MP4")).toBe("file");
  });

  it("classifies video-host pages as iframe embeds", () => {
    expect(kbVideoKind("https://www.aparat.com/v/abc123")).toBe("embed");
    expect(kbVideoKind("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("embed");
  });

  it("rejects non-http and malformed URLs", () => {
    expect(kbVideoKind("file:///etc/passwd")).toBeNull();
    expect(kbVideoKind("javascript:alert(1)")).toBeNull();
    expect(kbVideoKind("not a url")).toBeNull();
    expect(kbVideoKind("")).toBeNull();
  });
});

describe("parseHttpUrl", () => {
  it("trims and parses http(s)", () => {
    expect(parseHttpUrl("  https://example.com/a ")?.host).toBe("example.com");
  });
  it("rejects everything else", () => {
    expect(parseHttpUrl("ftp://example.com")).toBeNull();
    expect(parseHttpUrl("https://bad url with space")).toBeNull();
  });
});

describe("stripMarkdown", () => {
  it("keeps prose and code, drops fence/list/heading/table markup", () => {
    const md = [
      "## سفارش",
      "- آیتم **یک**",
      "| a | b |",
      "|---|---|",
      "```ts",
      'const x = "keep me";',
      "```",
      "![کاور](https://x.test/c.png)",
    ].join("\n");
    const text = stripMarkdown(md);
    expect(text).toContain("سفارش");
    expect(text).toContain("آیتم یک");
    expect(text).toContain('const x = "keep me";');
    expect(text).toContain("کاور");
    expect(text).not.toContain("|---|");
    expect(text).not.toContain("![");
  });
});

describe("kbSnippet", () => {
  const text = stripMarkdown(
    "راهنمای کامل صندوق فروش شامل ثبت سفارش، اعمال تخفیف، تسویهٔ چندگانه و چاپ فاکتور است. در ادامه شیفت و صندوق را می‌بینید.",
  );

  it("windows around the first hit with ellipses on both sides", () => {
    const snippet = kbSnippet(text, "تخفیف", 10);
    expect(snippet).toContain("تخفیف");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("returns the leading text when the query misses (title-only hit)", () => {
    const snippet = kbSnippet(text, "هلو", 10);
    expect(snippet).toBe(stripMarkdown(text).slice(0, 20).trimEnd() + "…");
  });

  it("returns the whole text when it is short enough", () => {
    expect(kbSnippet("متن کوتاه", "", 90)).toBe("متن کوتاه");
  });
});

describe("kbHighlightSegments", () => {
  it("marks every term occurrence and keeps the misses verbatim", () => {
    const segments = kbHighlightSegments("فروش امروز و فروش دیروز", "فروش");
    expect(segments).toEqual([
      { text: "فروش", hit: true },
      { text: " امروز و ", hit: false },
      { text: "فروش", hit: true },
      { text: " دیروز", hit: false },
    ]);
  });

  it("treats regex metacharacters in the query literally", () => {
    const segments = kbHighlightSegments("قیمت (تومان) ثبت شد", "(تومان)");
    expect(segments.some((s) => s.hit && s.text === "(تومان)")).toBe(true);
  });

  it("returns the text as one miss for an empty query", () => {
    expect(kbHighlightSegments("متن", " ")).toEqual([{ text: "متن", hit: false }]);
  });
});

describe("buildKbCategoryTree", () => {
  const flat = [
    { id: "b", parentId: null, slug: "b", title: "ب", description: "", icon: "", tone: "", sortOrder: 2 },
    { id: "a", parentId: null, slug: "a", title: "الف", description: "", icon: "", tone: "", sortOrder: 1 },
    { id: "a1", parentId: "a", slug: "a1", title: "الف-۱", description: "", icon: "", tone: "", sortOrder: 0 },
  ];

  it("nests children under sorted roots", () => {
    const tree = buildKbCategoryTree(flat);
    expect(tree.map((n) => n.id)).toEqual(["a", "b"]);
    expect(tree[0].children.map((n) => n.id)).toEqual(["a1"]);
  });

  it("attaches orphans to the root instead of hiding them", () => {
    const tree = buildKbCategoryTree([...flat, { ...flat[2], id: "c1", parentId: "missing" }]);
    expect(tree.map((n) => n.id)).toContain("c1");
  });
});

describe("normalizeSectionKeys", () => {
  const known = new Set(["pos", "orders"]);

  it("keeps known keys, deduped, in order", () => {
    expect(normalizeSectionKeys(["pos", "orders", "pos"], known)).toEqual(["pos", "orders"]);
  });

  it("drops unknown keys and non-strings", () => {
    expect(normalizeSectionKeys(["pos", "nope", 3], known)).toEqual(["pos"]);
    expect(normalizeSectionKeys("pos", known)).toEqual([]);
  });
});

describe("kbVideoSource (issue #938)", () => {
  it("converts a YouTube watch URL to the no-cookie embed", () => {
    const source = kbVideoSource("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(source).toEqual({
      kind: "embed",
      provider: "youtube",
      src: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0",
      externalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
  });

  it("accepts youtu.be and shorts links", () => {
    expect(kbVideoSource("https://youtu.be/abc123XYZ_-")?.kind).toBe("embed");
    expect(kbVideoSource("https://www.youtube.com/shorts/abc123XYZ_-")?.src).toContain(
      "/embed/abc123XYZ_-",
    );
  });

  it("converts an Aparat page to its videohash frame", () => {
    expect(kbVideoSource("https://www.aparat.com/v/AbC123")?.src).toBe(
      "https://www.aparat.com/video/video/embed/videohash/AbC123/vt/frame",
    );
  });

  it("converts a Vimeo page to the player URL", () => {
    expect(kbVideoSource("https://vimeo.com/12345678")?.src).toBe(
      "https://player.vimeo.com/video/12345678",
    );
  });

  it("refuses to frame an arbitrary http(s) page", () => {
    expect(kbVideoSource("https://example.com/help/video")).toBeNull();
    expect(kbVideoSource("https://evil.example/watch?v=abc")).toBeNull();
    expect(kbVideoSource("javascript:alert(1)")).toBeNull();
    expect(kbVideoSource("file:///etc/passwd")).toBeNull();
  });
});

describe("normalizeKbSearchText (Persian/Arabic folding)", () => {
  it("folds Arabic Yeh/Kaf to the Persian forms", () => {
    expect(normalizeKbSearchText("جستجوي كالا")).toBe("جستجوی کالا");
  });

  it("folds Persian and Arabic-Indic digits to ASCII", () => {
    expect(normalizeKbSearchText("۱۲۳ و ٤٥٦")).toBe("123 و 456");
  });

  it("turns ZWNJ into a space and drops diacritics/tatweel", () => {
    expect(normalizeKbSearchText("می‌خواهم")).toBe("می خواهم");
    expect(normalizeKbSearchText("مُحَمَّد")).toBe("محمد");
    expect(normalizeKbSearchText("کـــتاب")).toBe("کتاب");
  });

  it("collapses whitespace and lowercases Latin", () => {
    expect(normalizeKbSearchText("  POS   Basics  ")).toBe("pos basics");
  });

  it("makes Arabic-spelled and Persian-spelled queries identical", () => {
    expect(normalizeKbSearchText("پشتيباني")).toBe(normalizeKbSearchText("پشتیبانی"));
  });
});

describe("kbSnippet and highlighting across spelling variants (issue #938)", () => {
  it("finds a Persian-spelled body with an Arabic-spelled query", () => {
    const text = "برای پشتیبانی با ما تماس بگیرید";
    expect(kbSnippet(text, "پشتيباني")).toContain("پشتیبانی");
  });

  it("highlights the variant that appears in the text", () => {
    const segments = kbHighlightSegments("پشتیبانی سریع", "پشتيباني");
    expect(segments.some((seg) => seg.hit && seg.text === "پشتیبانی")).toBe(true);
  });
});

describe("buildKbCategoryTree cycle safety (issue #938)", () => {
  const base = (id: string, parentId: string | null, sortOrder = 0) => ({
    id,
    parentId,
    slug: id,
    title: id,
    description: "",
    icon: "",
    tone: "",
    sortOrder,
  });

  it("keeps every category when A→B→C→A is stored", () => {
    const tree = buildKbCategoryTree([
      base("a", "c"),
      base("b", "a"),
      base("c", "b"),
    ]);
    const ids: string[] = [];
    const walk = (nodes: ReturnType<typeof buildKbCategoryTree>) => {
      for (const node of nodes) {
        ids.push(node.id);
        walk(node.children);
      }
    };
    walk(tree);
    expect(ids.sort()).toEqual(["a", "b", "c"]);
    expect(tree.length).toBeGreaterThan(0);
  });

  it("breaks a two-node loop without hiding either node", () => {
    const tree = buildKbCategoryTree([base("a", "b"), base("b", "a")]);
    const ids: string[] = [];
    const walk = (nodes: ReturnType<typeof buildKbCategoryTree>) => {
      for (const node of nodes) {
        ids.push(node.id);
        walk(node.children);
      }
    };
    walk(tree);
    expect(ids.sort()).toEqual(["a", "b"]);
  });

  it("lists the full ancestor chain of a deep category", () => {
    const flat = [base("root", null), base("mid", "root"), base("leaf", "mid")];
    expect(kbCategoryAncestors(flat, "leaf")).toEqual(["root", "mid", "leaf"]);
    expect(kbCategoryAncestors(flat, null)).toEqual([]);
  });

  it("does not loop forever when ancestors are already cyclic", () => {
    const flat = [base("a", "b"), base("b", "a")];
    expect(kbCategoryAncestors(flat, "a").sort()).toEqual(["a", "b"]);
  });
});

describe("deep-link heading hashes (issue #938)", () => {
  const headings = [
    { id: "بستن-صندوق", text: "بستن صندوق" },
    { id: "گزارش-روزانه", text: "گزارش روزانه" },
    { id: "گزارش-روزانه-2", text: "گزارش روزانه" },
    { id: "تسویه-چندگانه", text: "تسویهٔ چندگانه" },
  ];

  it("decodes a percent-encoded Persian fragment", () => {
    expect(decodeKbHeadingHash(`#${encodeURIComponent("بستن-صندوق")}`)).toBe("بستن-صندوق");
  });

  it("keeps a malformed fragment instead of throwing", () => {
    expect(decodeKbHeadingHash("#%E0%A4%A")).toBe("%E0%A4%A");
  });

  it("resolves an exact id, including a repeated heading's -2 suffix", () => {
    expect(kbHeadingTargetForHash("#گزارش-روزانه-2", headings)).toBe("گزارش-روزانه-2");
  });

  it("falls back to the heading text when the fragment uses spaces", () => {
    expect(kbHeadingTargetForHash("#بستن صندوق", headings)).toBe("بستن-صندوق");
  });

  it("resolves a fragment written from the heading text (combining hamza)", () => {
    expect(
      kbHeadingTargetForHash(`#${encodeURIComponent("تسویهٔ چندگانه")}`, headings),
    ).toBe("تسویه-چندگانه");
  });

  it("returns null for an unknown heading rather than scrolling somewhere else", () => {
    expect(kbHeadingTargetForHash("#ناموجود", headings)).toBeNull();
    expect(kbHeadingTargetForHash("", headings)).toBeNull();
  });
});
