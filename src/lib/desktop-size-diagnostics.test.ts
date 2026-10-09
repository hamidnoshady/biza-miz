import { describe, expect, it } from "vitest";
import {
  categoryOf,
  escapeWorkflowData,
  escapeWorkflowProperty,
  formatExactBytes,
  formatMiB,
  manifestTsv,
  noticesFor,
  packageOf,
  summarize,
  summaryMarkdown,
  workflowNotice,
} from "./desktop-size-diagnostics";

describe("categoryOf", () => {
  it.each([
    [".next/server/app/api/ledger/dimensions/route_client-reference-manifest.js", "Next client-reference manifests"],
    [".next/server/app/(app)/accounting/[section]/page_client-reference-manifest.js", "Next client-reference manifests"],
    [".next/server/app/api/ledger/dimensions/route.js.nft.json", "Next build traces (*.nft.json)"],
    [".next/server/app/(app)/accounting/[section]/page.js.nft.json", "Next build traces (*.nft.json)"],
    [".next/server/app/api/ledger/dimensions/route.js", "Next server app/api route bundles"],
    [".next/server/app/api/ledger/dimensions/notes.txt", "Next server app/api (other)"],
    [".next/server/app/(app)/accounting/overview/page.js", "Next server app pages and layouts"],
    [".next/server/chunks/13824.js", "Next server shared chunks"],
    [".next/server/webpack-runtime.js", "Next server (other)"],
    [".next/static/chunks/app/(app)/accounting/overview/page-abc.js", "Next client route chunks"],
    [".next/static/chunks/637fa903.80eaeb.js", "Next client shared chunks"],
    [".next/static/css/app.css", "Next static (other)"],
    [".next/BUILD_ID", "Next (other)"],
    ["node_modules/next/dist/server/next.js", "node_modules (traced packages)"],
    ["bin/server.cjs", "bin/ (custom server and migration bundles)"],
    ["migrations/0216_accounting_dimensions.sql", "migrations/"],
    ["public/icon.svg", "public/"],
    ["runtime-build.json", "other: root files"],
    ["resources/app.asar", "other: resources/app.asar"],
    ["locales/en-US.pak", "other: locales"],
  ])("classifies %s", (path, expected) => {
    expect(categoryOf(path)).toBe(expected);
  });

  it("normalises Windows separators before classifying", () => {
    expect(categoryOf(".next\\server\\chunks\\1.js")).toBe("Next server shared chunks");
  });
});

describe("packageOf", () => {
  it("groups scoped and unscoped packages under their name", () => {
    expect(packageOf("node_modules/@img/sharp-win32-x64/lib/sharp.node")).toBe("@img/sharp-win32-x64");
    expect(packageOf("node_modules/next/dist/server/next.js")).toBe("next");
  });

  it("returns null outside node_modules", () => {
    expect(packageOf("bin/server.cjs")).toBeNull();
    expect(packageOf("node_modules")).toBeNull();
  });
});

describe("summarize", () => {
  const files = [
    { path: ".next/server/app/api/a/route.js", bytes: 1000 },
    { path: ".next/server/app/api/a/route_client-reference-manifest.js", bytes: 70000 },
    { path: "node_modules/next/dist/x.js", bytes: 5000 },
    { path: "node_modules/@img/sharp-win32-x64/lib/sharp.node", bytes: 9000 },
    { path: "bin/server.cjs", bytes: 12000 },
  ];

  it("totals bytes and files and orders top-level rows largest first", () => {
    const summary = summarize(files);
    expect(summary.totalBytes).toBe(97000);
    expect(summary.fileCount).toBe(5);
    expect(summary.topLevel.map((row) => [row.key, row.bytes, row.files])).toEqual([
      [".next", 71000, 2],
      ["node_modules", 14000, 2],
      ["bin", 12000, 1],
    ]);
  });

  it("groups categories and packages", () => {
    const summary = summarize(files);
    expect(summary.categories[0]).toEqual({ key: "Next client-reference manifests", bytes: 70000, files: 1 });
    expect(summary.packages.map((row) => row.key)).toEqual(["@img/sharp-win32-x64", "next"]);
  });

  it("removes stripPrefix before classifying, but keeps the unstripped top level", () => {
    const packaged = summarize(
      [
        { path: "resources/desktop-runtime/.next/static/chunks/a.js", bytes: 300 },
        { path: "resources/app.asar", bytes: 700 },
        { path: "LICENSE", bytes: 10 },
      ],
      { stripPrefix: "resources/desktop-runtime/" },
    );
    expect(packaged.categories.map((row) => row.key)).toEqual([
      "other: resources/app.asar",
      "Next client shared chunks",
      "other: root files",
    ]);
    expect(packaged.topLevel.map((row) => row.key)).toEqual(["resources", "LICENSE"]);
  });

  it("lists the largest files, ties broken by path, limited by largestCount", () => {
    const summary = summarize(
      [
        { path: "b.bin", bytes: 5 },
        { path: "a.bin", bytes: 5 },
        { path: "c.bin", bytes: 9 },
      ],
      { largestCount: 2 },
    );
    expect(summary.largestFiles.map((file) => file.path)).toEqual(["c.bin", "a.bin"]);
  });

  it("summarises an empty listing without inventing rows", () => {
    const summary = summarize([]);
    expect(summary).toMatchObject({ totalBytes: 0, fileCount: 0, topLevel: [], categories: [], packages: [], largestFiles: [] });
  });
});

describe("byte formatting", () => {
  it("reports MiB with binary megabytes, so the 200 MiB gate boundary is exact", () => {
    expect(formatMiB(209715200)).toBe("200.0 MiB");
    expect(formatMiB(1048576)).toBe("1.0 MiB");
    expect(formatMiB(223507293, 3)).toBe("213.153 MiB");
  });

  it("prints exact bytes with thousands separators", () => {
    expect(formatExactBytes(223507293)).toBe("223,507,293");
    expect(formatExactBytes(999)).toBe("999");
    expect(formatExactBytes(0)).toBe("0");
  });
});

describe("manifestTsv", () => {
  it("writes one bytes-tab-path line per file, sorted, with forward slashes", () => {
    expect(
      manifestTsv([
        { path: "b\\two.js", bytes: 2 },
        { path: "a.js", bytes: 1 },
      ]),
    ).toBe("1\ta.js\n2\tb/two.js\n");
  });

  it("is an empty file for an empty listing", () => {
    expect(manifestTsv([])).toBe("");
  });
});

describe("workflow command escaping", () => {
  it("escapes percent, carriage return and line feed in message data", () => {
    expect(escapeWorkflowData("100%\r\nnext")).toBe("100%25%0D%0Anext");
  });

  it("also escapes colon and comma in properties such as title", () => {
    expect(escapeWorkflowProperty("staged: runtime, total")).toBe("staged%3A runtime%2C total");
  });

  it("builds a single notice line with escaped title and message", () => {
    expect(workflowNotice("a:b,c", "line1\nline2")).toBe("::notice title=a%3Ab%2Cc::line1%0Aline2");
  });
});

describe("noticesFor and summaryMarkdown", () => {
  const summary = summarize([
    { path: ".next/server/chunks/1.js", bytes: 2 * 1048576 },
    { path: "node_modules/next/x.js", bytes: 1048576 },
  ]);

  it("emits a headline with the exact total, then category, package and file notices", () => {
    const lines = noticesFor("staged-runtime", summary);
    expect(lines).toHaveLength(4);
    expect(lines.every((line) => line.startsWith("::notice title="))).toBe(true);
    expect(lines[0]).toContain("staged-runtime total");
    expect(lines[0]).toContain("3,145,728 bytes (3.000 MiB) in 2 files");
    expect(lines[1]).toContain("Next server shared chunks");
    expect(lines[2]).toContain("next");
  });

  it("renders the full markdown report with its headings and totals", () => {
    const markdown = summaryMarkdown(
      { label: "staged-runtime", root: ".desktop-runtime", sha: "abc123", generatedAt: "2026-10-09T00:00:00.000Z" },
      summary,
    );
    expect(markdown).toContain("# staged-runtime size");
    expect(markdown).toContain("**3,145,728 bytes** (3.000 MiB), 2 files");
    expect(markdown).toContain("## Categories");
    expect(markdown).toContain("## Largest files");
  });
});
