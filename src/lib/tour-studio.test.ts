/**
 * Issue #972 — the authored tour catalogue's rules, before anything reaches the
 * database.
 *
 * A Studio tour is content a platform admin writes without a code review, so
 * the checks here are the review: it must address a registered page at that
 * page's own route, every spotlight must name a registered anchor, the tour
 * must open with an explanation, and its eligibility must use the vocabulary
 * the member-side runtime actually evaluates.
 */
import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "./permissions";
import {
  STUDIO_ERROR_TEXT,
  STUDIO_STEP_BODY_MAX,
  isServableStudioTour,
  mergePublishedTours,
  parseStudioTourInput,
  studioTourDefinition,
  type StudioTourContent,
} from "./tour-studio";
import { TOUR_ANCHORS, TOURS, tourById, validateTours } from "./tours";

const VALID = {
  tourKey: "studio.crm.audit",
  pageKey: "page:/crm/audit",
  title: "آشنایی با سابقهٔ تصمیم‌ها",
  description: "این صفحه تصمیم‌های ثبت‌شده را نشان می‌دهد.",
  eligibility: { permissions: [PERMISSIONS.ledgerView], industries: ["cosmetics"] as const },
  steps: [
    { id: "intro", kind: "explain", title: "سابقهٔ تصمیم‌ها", body: "." },
    { id: "header", kind: "spotlight", anchor: TOUR_ANCHORS.pageHeader, title: "سرصفحه", body: "." },
  ],
};

const parse = (patch: Record<string, unknown> = {}) => parseStudioTourInput({ ...VALID, ...patch });

describe("authoring a tour", () => {
  it("accepts a payload a reviewer would sign off, and builds a valid definition", () => {
    const parsed = parse();
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.input).toMatchObject({
      tourKey: VALID.tourKey,
      pageKey: VALID.pageKey,
      route: "/crm/audit",
      title: VALID.title,
    });
    // The route is read from the registry, so a payload cannot address a page
    // at a route the registry does not give it.
    expect(parsed.input.route).toBe("/crm/audit");
    const definition = studioTourDefinition(parsed.input, 1);
    expect(validateTours([definition])).toEqual([]);
    expect(definition.pageKey).toBe("page:/crm/audit");
  });

  it("refuses a page the registry does not know, or a route that is not that page's", () => {
    expect(parse({ pageKey: "page:/nope" })).toMatchObject({ ok: false, error: "unknown_page" });
    expect(parse({ route: "/dashboard/crm/audit" })).toMatchObject({ ok: false, error: "route_mismatch" });
  });

  it("refuses an id that is malformed or reserved for the automatic baseline", () => {
    expect(parse({ tourKey: "Not A Key" })).toMatchObject({ ok: false, error: "invalid_tour_key" });
    expect(parse({ tourKey: `baseline.${"x".repeat(4)}` })).toMatchObject({
      ok: false,
      error: "baseline_key_reserved",
    });
  });

  it("refuses to reuse another page's code-tour id", () => {
    // `accounting.products.list` is the products page's id and is what progress
    // is stored under; it must not start pointing at the audit page.
    expect(parse({ tourKey: "accounting.products.list", pageKey: "page:/crm/audit" })).toMatchObject({
      ok: false,
      error: "tour_key_owned_by_another_page",
    });
  });

  it("checks the title and description bounds", () => {
    expect(parse({ title: "   " })).toMatchObject({ ok: false, error: "invalid_title" });
    expect(parse({ title: "x".repeat(121) })).toMatchObject({ ok: false, error: "invalid_title" });
    expect(parse({ description: "x".repeat(301) })).toMatchObject({
      ok: false,
      error: "invalid_description",
    });
  });
});

describe("steps", () => {
  it("needs at least one step and must open with an explanation", () => {
    expect(parse({ steps: [] })).toMatchObject({ ok: false, error: "invalid_steps" });
    expect(
      parse({
        steps: [{ id: "header", kind: "spotlight", anchor: TOUR_ANCHORS.pageHeader, title: "x", body: "." }],
      }),
    ).toMatchObject({ ok: false, error: "invalid_steps" });
  });

  it("only highlights registered anchors — never a selector or a label", () => {
    const unregistered = parse({
      steps: [
        { id: "intro", kind: "explain", title: "x", body: "." },
        { id: "bad", kind: "spotlight", anchor: ".some-class", title: "x", body: "." },
      ],
    });
    expect(unregistered).toMatchObject({ ok: false, error: "invalid_steps" });
    if (!unregistered.ok) expect(unregistered.detail).toContain("not registered");

    const missing = parse({
      steps: [
        { id: "intro", kind: "explain", title: "x", body: "." },
        { id: "bad", kind: "spotlight", title: "x", body: "." },
      ],
    });
    expect(missing).toMatchObject({ ok: false, error: "invalid_steps" });
  });

  it("accepts a verified action step only with a registered verifier", () => {
    const valid = parse({
      steps: [
        { id: "intro", kind: "explain", title: "x", body: "." },
        {
          id: "do-it",
          kind: "action",
          verifier: "party.created",
          anchor: TOUR_ANCHORS.partiesAdd,
          title: "ثبت کنید",
          body: ".",
        },
      ],
    });
    expect(valid.ok).toBe(true);
    if (valid.ok) expect(valid.input.steps[1]).toMatchObject({ kind: "action", verifier: "party.created" });

    const noVerifier = parse({
      steps: [
        { id: "intro", kind: "explain", title: "x", body: "." },
        { id: "do-it", kind: "action", title: "ثبت کنید", body: "." },
      ],
    });
    expect(noVerifier).toMatchObject({ ok: false, error: "invalid_steps" });
    if (!noVerifier.ok) expect(noVerifier.detail).toContain("registered verifier");

    const unknownVerifier = parse({
      steps: [
        { id: "intro", kind: "explain", title: "x", body: "." },
        { id: "do-it", kind: "action", verifier: "made.up", title: "ثبت کنید", body: "." },
      ],
    });
    expect(unknownVerifier).toMatchObject({ ok: false, error: "invalid_steps" });
  });

  it("anchors an action step only at a registered anchor, and allows none", () => {
    const bad = parse({
      steps: [
        { id: "intro", kind: "explain", title: "x", body: "." },
        { id: "do-it", kind: "action", verifier: "party.created", anchor: "#save", title: "x", body: "." },
      ],
    });
    expect(bad).toMatchObject({ ok: false, error: "invalid_steps" });

    const unanchored = parse({
      steps: [
        { id: "intro", kind: "explain", title: "x", body: "." },
        { id: "do-it", kind: "action", verifier: "party.created", title: "x", body: "." },
      ],
    });
    expect(unanchored.ok).toBe(true);
    if (unanchored.ok) expect(unanchored.input.steps[1].anchor).toBeUndefined();
  });

  it("refuses a verifier on a step that asks for nothing real", () => {
    const mismatch = parse({
      steps: [
        { id: "intro", kind: "explain", title: "x", body: ".", verifier: "party.created" },
        { id: "anchor", kind: "spotlight", anchor: TOUR_ANCHORS.pageHeader, title: "x", body: "." },
      ],
    });
    expect(mismatch).toMatchObject({ ok: false, error: "invalid_steps" });
  });

  it("keeps explanations free of anchors, and refuses duplicates and empty copy", () => {
    const explainWithAnchor = parse({
      steps: [{ id: "intro", kind: "explain", anchor: TOUR_ANCHORS.pageHeader, title: "x", body: "." }],
    });
    expect(explainWithAnchor).toMatchObject({ ok: false, error: "invalid_steps" });

    const duplicate = parse({
      steps: [
        { id: "intro", kind: "explain", title: "x", body: "." },
        { id: "intro", kind: "explain", title: "y", body: "." },
      ],
    });
    expect(duplicate).toMatchObject({ ok: false, error: "invalid_steps" });

    const emptyBody = parse({ steps: [{ id: "intro", kind: "explain", title: "x", body: "  " }] });
    expect(emptyBody).toMatchObject({ ok: false, error: "invalid_steps" });

    const tooLong = parse({
      steps: [{ id: "intro", kind: "explain", title: "x", body: "ب".repeat(STUDIO_STEP_BODY_MAX + 1) }],
    });
    expect(tooLong).toMatchObject({ ok: false, error: "invalid_steps" });
  });
});

describe("eligibility", () => {
  it("accepts the vocabulary the member runtime evaluates", () => {
    const parsed = parse({
      eligibility: {
        permissions: [PERMISSIONS.inventoryView],
        withoutPermissions: [PERMISSIONS.ledgerView],
        industries: ["jewelry"],
        features: ["ledger"],
        withoutFeatures: ["ai_assistant"],
        inventorySystem: "periodic",
        anyOf: [{ permissions: [PERMISSIONS.reportsView] }, { withoutPermissions: [] }],
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.input.eligibility.inventorySystem).toBe("periodic");
    expect(parsed.input.eligibility.anyOf).toHaveLength(2);
  });

  it("names an unknown permission, trade, flag or rule instead of silently never matching", () => {
    expect(parse({ eligibility: { permissions: ["nope.everything"] } })).toMatchObject({
      ok: false,
      error: "invalid_eligibility",
    });
    expect(parse({ eligibility: { industries: ["spaceships"] } })).toMatchObject({
      ok: false,
      error: "invalid_eligibility",
    });
    expect(parse({ eligibility: { inventorySystem: "weekly" } })).toMatchObject({
      ok: false,
      error: "invalid_eligibility",
    });
    expect(parse({ eligibility: { sometimes: [] } })).toMatchObject({
      ok: false,
      error: "invalid_eligibility",
    });
    expect(parse({ eligibility: { anyOf: [] } })).toMatchObject({
      ok: false,
      error: "invalid_eligibility",
    });
    // A nested alternative is checked exactly like the top level.
    expect(parse({ eligibility: { anyOf: [{ permissions: ["nope"] }] } })).toMatchObject({
      ok: false,
      error: "invalid_eligibility",
    });
  });
});

describe("serving and precedence", () => {
  const content: StudioTourContent = {
    tourKey: "studio.crm.audit",
    pageKey: "page:/crm/audit",
    route: "/crm/audit",
    title: "تور",
    description: "",
    eligibility: {},
    steps: [
      { id: "intro", kind: "explain", title: "شروع", body: "." },
      { id: "header", kind: "spotlight", anchor: TOUR_ANCHORS.pageHeader, title: "سرصفحه", body: "." },
    ],
  };

  it("serves a stored tour only while its page and anchors still exist", () => {
    expect(isServableStudioTour(content)).toBe(true);
    expect(isServableStudioTour({ ...content, pageKey: "page:/gone", route: "/gone" })).toBe(false);
    expect(isServableStudioTour({ ...content, route: "/crm" })).toBe(false);
    expect(
      isServableStudioTour({
        ...content,
        steps: [
          { id: "intro", kind: "explain", title: "x", body: "." },
          // A stored row can only get here if the source anchor was removed.
          { id: "gone", kind: "spotlight", anchor: "retired.anchor" as never, title: "x", body: "." },
        ],
      }),
    ).toBe(false);
  });

  it("lets a published tour replace the code tour with the same id, and append the rest", () => {
    const code = tourById("accounting.products.list")!;
    const replacement = { ...code, title: "نسخهٔ استودیو", version: 7 };
    const extra = { ...code, id: "studio.products", title: "تور دوم" };

    const merged = mergePublishedTours([code], [replacement]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(replacement);

    const withExtra = mergePublishedTours([code], [replacement, extra]);
    expect(withExtra.map((tour) => tour.id)).toEqual([code.id, "studio.products"]);
    expect(withExtra[0].title).toBe("نسخهٔ استودیو");
  });

  it("never touches the code catalogue when nothing is published", () => {
    expect(mergePublishedTours(TOURS, [])).toEqual([...TOURS]);
    expect(mergePublishedTours(TOURS, [])).not.toBe(TOURS);
  });
});

describe("operator messages", () => {
  // Every code the parse (`StudioTourInputError`) or the service can emit.
  const CODES = [
    "bad_request",
    "unknown_page",
    "route_mismatch",
    "invalid_tour_key",
    "baseline_key_reserved",
    "tour_key_owned_by_another_page",
    "invalid_title",
    "invalid_description",
    "invalid_steps",
    "invalid_eligibility",
    "invalid_content",
    "not_found",
    "version_conflict",
    "not_draft",
  ];

  it("answers every code with a Persian sentence, never the code itself", () => {
    for (const code of CODES) {
      const text = STUDIO_ERROR_TEXT[code];
      expect(text, `${code} needs an operator sentence`).toBeTruthy();
      expect(text, `${code} must not echo the code`).not.toContain(code);
      // Persian letters — the console is Persian-first.
      expect(text).toMatch(/[\u0600-\u06FF]/);
    }
  });

  it("does not borrow the knowledge-article sentence for a tour conflict", () => {
    // The shared vocabulary says «این راهنما …» — wrong noun for a tour.
    expect(STUDIO_ERROR_TEXT.version_conflict).toContain("تور");
    expect(STUDIO_ERROR_TEXT.version_conflict).not.toContain("راهنما");
  });
});
