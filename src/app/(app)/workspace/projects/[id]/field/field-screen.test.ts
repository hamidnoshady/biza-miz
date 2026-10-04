/**
 * Issue #799 §25 — the field screen's own contract, asserted on its source.
 *
 * The board's data is proven against PostgreSQL
 * (`integration/aec-field.integration.test.ts`) and the catalogue in
 * `src/lib/aec-field.test.ts`; what is left is the part only the screen can get
 * wrong, and it is the part §25 wrote as *rules*: no desktop-only tables, fast
 * photo capture with real progress, drafts where safe, Shamsi dates, and links
 * into the panels rather than a second editor. A static scan is how this repo
 * already guards that class of rule (see `src/app/api/api-guards.test.ts`).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AEC_FIELD_ACTION_KEYS } from "@/lib/aec-field";
import { FIELD_SCREEN_ACTION_KEYS } from "./field-screen";

const HERE = join(process.cwd(), "src", "app", "(app)", "workspace", "projects", "[id]", "field");
const SCREEN = readFileSync(join(HERE, "field-screen.tsx"), "utf8");

describe("«حالت کارگاه» — the field screen", () => {
  it("puts every §25 flow on the screen, not only in the catalogue", () => {
    expect(FIELD_SCREEN_ACTION_KEYS).toEqual([...AEC_FIELD_ACTION_KEYS]);
    expect(FIELD_SCREEN_ACTION_KEYS.length).toBe(11);
  });

  it("is reachable from the project page and served by its own route", () => {
    expect(existsSync(join(HERE, "page.tsx"))).toBe(true);
    expect(existsSync(join(process.cwd(), "src", "app", "api", "aec", "projects", "[id]", "field", "route.ts"))).toBe(
      true,
    );
    expect(existsSync(join(process.cwd(), "src", "app", "api", "aec", "projects", "[id]", "field", "photo", "route.ts"))).toBe(
      true,
    );
    const detail = readFileSync(
      join(process.cwd(), "src", "app", "(app)", "workspace", "projects", "[id]", "project-detail.tsx"),
      "utf8",
    );
    expect(detail).toContain("/field`");
    expect(detail).toContain("HardHatIcon");
  });

  it("captures photos from the camera and shows real upload progress", () => {
    // §25's "fast file/photo capture" and "clear upload progress": a capture
    // input, an XHR (fetch cannot report upload progress), and a progressbar.
    expect(SCREEN).toContain('capture="environment"');
    expect(SCREEN).toContain("XMLHttpRequest");
    expect(SCREEN).toContain("upload.onprogress");
    expect(SCREEN).toContain('role="progressbar"');
    expect(SCREEN).toContain("toPersianDigits(progress)");
  });

  it("keeps a draft where §25 says it is safe, and never for a decision", () => {
    expect(SCREEN).toContain("localStorage");
    expect(SCREEN).toContain("readDraft");
    expect(SCREEN).toContain("writeDraft");
    // The two decisions say so on screen; the catalogue marks them draftSafe:false.
    expect(SCREEN).toContain("بدون پیش‌نویس");
    expect(SCREEN).toContain("وضعیت وظیفه بی‌درنگ ذخیره می‌شود؛ پیش‌نویس محلی ندارد.");
  });

  it("shows no desktop-only table for critical work, and no spinner", () => {
    expect(SCREEN).not.toContain("<table");
    expect(SCREEN).not.toContain("animate-spin");
    // Loading reserves its shape (docs/design-system.md §Charts and loading).
    expect(SCREEN).toContain("SectionCardSkeleton");
  });

  it("is touch friendly: every control reserves a thumb-sized target", () => {
    expect(SCREEN).toContain("min-h-12");
    expect(SCREEN).toContain("min-h-20");
    expect(SCREEN).toContain("min-h-24");
  });

  it("writes through the registers' own endpoints and links reviews to their tabs", () => {
    // The phone never gets a parallel API: the same routes the panels call.
    for (const endpoint of [
      "/api/aec/projects/${projectId}/site-logs",
      "/api/aec/projects/${projectId}/site-issues",
      "/api/aec/projects/${projectId}/rfis",
      "/api/aec/commitments/${chosen}/deliveries",
      "/api/aec/site-issues/${issueId}",
      "/api/workspace/tasks/${taskId}",
    ]) {
      expect(SCREEN, endpoint).toContain(endpoint);
    }
    // …and reviews hand off to the project page's own tab (§34: no duplicate
    // screens), which is what `?tab=` support in the project detail is for.
    expect(SCREEN).toContain("?tab=${action.section}");
    expect(SCREEN).toContain("?tab=submittals");
    expect(SCREEN).toContain("?tab=files");
  });

  it("lets the screen read the date the API already formatted (§25's Shamsi rule)", () => {
    expect(SCREEN).toContain("board.todayJalali");
    expect(SCREEN).toContain("dateJalali");
    // …and sends the Gregorian date the database stores.
    expect(SCREEN).toContain("logDate: board.today");
    expect(SCREEN).toContain('type="date"');
  });
});
