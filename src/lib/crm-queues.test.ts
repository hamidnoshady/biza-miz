/**
 * The queue vocabulary, kept in one place.
 *
 * `crm-shared.ts` owns the keys, the words and the section each queue belongs
 * to; `crm-queues.ts` owns the rules. Two files, so they can drift — unless
 * something checks, which is this file. It asserts:
 *
 *   1. every declared key has a rule (`withQueueMeta("<key>"` in the source);
 *   2. no rule writes its own label, because that is the copy the client half
 *      cannot read and the second place a queue's name can be spelled;
 *   3. the presentation is complete and its section names are real sections.
 *
 * A rule that returns a label the shared table does not know would render a
 * heading nobody translated, and a queue added without a section would be
 * invisible on every screen that owns it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CRM_QUEUE_KEYS,
  CRM_QUEUE_PRESENTATION,
  NEW_LEAD_DAYS,
  STALLED_DEAL_DAYS,
  VIP_SILENCE_DAYS,
  queueKeysForSection,
} from "./crm-shared";
import { CRM_SECTION_KEYS, type CrmSectionKey } from "./crm-permissions";

const SOURCE = readFileSync(
  fileURLToPath(new URL("./crm-queues.ts", import.meta.url)),
  "utf8",
);

describe("CRM_QUEUE_PRESENTATION", () => {
  it("describes every key and nothing else", () => {
    expect(Object.keys(CRM_QUEUE_PRESENTATION).sort()).toEqual([...CRM_QUEUE_KEYS].sort());
  });

  it("gives each queue a label, a reason and an action", () => {
    for (const key of CRM_QUEUE_KEYS) {
      const queue = CRM_QUEUE_PRESENTATION[key];
      expect(queue.label.trim().length, key).toBeGreaterThan(0);
      expect(queue.why.trim().length, key).toBeGreaterThan(0);
      expect(queue.action.trim().length, key).toBeGreaterThan(0);
      // A queue's name must say something the reader has not seen: two queues
      // sharing a label make the feed unreadable.
      expect(queue.label).not.toContain("undefined");
    }
    const labels = CRM_QUEUE_KEYS.map((key) => CRM_QUEUE_PRESENTATION[key].label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("names only real sections", () => {
    for (const key of CRM_QUEUE_KEYS) {
      for (const section of CRM_QUEUE_PRESENTATION[key].sections) {
        expect(CRM_SECTION_KEYS, `${key} → ${section}`).toContain(section);
      }
    }
  });

  it("is what queueKeysForSection reads", () => {
    for (const section of CRM_SECTION_KEYS) {
      const expected = CRM_QUEUE_KEYS.filter((key) =>
        CRM_QUEUE_PRESENTATION[key].sections.includes(section),
      );
      expect(queueKeysForSection(section), section).toEqual(expected);
    }
    // An unknown section returns nothing rather than everything: a typo must
    // not turn a section header into a copy of the home page.
    expect(queueKeysForSection("nonsense")).toEqual([]);
  });

  it("keeps the thresholds it quotes in the copy", () => {
    // The numbers in a queue's «why» come from these constants, so the copy and
    // the SQL can never disagree about what "stalled" means.
    expect(CRM_QUEUE_PRESENTATION.stalled_deals.why).toContain(String(STALLED_DEAL_DAYS));
    expect(CRM_QUEUE_PRESENTATION.new_leads.why).toContain(String(NEW_LEAD_DAYS));
    expect(CRM_QUEUE_PRESENTATION.vip_follow_up.why).toContain(String(VIP_SILENCE_DAYS));
    expect(VIP_SILENCE_DAYS).toBeGreaterThan(0);
  });

  it("renders no source code into a heading", () => {
    // These strings are read by shop staff, not by us. A `why` written as a
    // double-quoted string containing `${…}` shows the *variable name* on the
    // screen — «`${VIP_SILENCE_DAYS} روز است…» — which is how the golden-customer
    // queue shipped until this test existed. Interpolation is fine; the syntax
    // surviving into the text is not.
    for (const key of CRM_QUEUE_KEYS) {
      const queue = CRM_QUEUE_PRESENTATION[key];
      for (const [field, value] of Object.entries(queue)) {
        if (typeof value !== "string") continue;
        expect(value, `${key}.${field}`).not.toContain("${");
        expect(value, `${key}.${field}`).not.toContain("`");
      }
    }
  });
});

describe("the rules in crm-queues.ts", () => {
  it("has one rule per declared key", () => {
    const offenders = CRM_QUEUE_KEYS.filter(
      (key) => !SOURCE.includes(`withQueueMeta("${key}"`),
    );
    expect(offenders, "these queues are declared but never built").toEqual([]);
  });

  it("writes no label of its own", () => {
    // Labels, reasons and actions live in crm-shared.ts. A `label:` literal
    // here is a second copy of product copy — the one the client cannot read.
    expect(SOURCE).not.toMatch(/\blabel:\s*"/);
    expect(SOURCE).not.toMatch(/\bwhy:\s*"/);
    expect(SOURCE).not.toMatch(/\baction:\s*"/);
  });

  it("keeps the section mapping out of the SQL builders", () => {
    // Moving it into the presentation table is what let the command field name
    // a queue's section without importing this module.
    expect(SOURCE).not.toMatch(/switch \(section\)/);
    expect(SOURCE).toMatch(/queueKeysForSection/);
  });
});

describe("sections that own queues", () => {
  it("covers the surfaces a member actually works in", () => {
    const owning = new Set(
      CRM_QUEUE_KEYS.flatMap((key) => CRM_QUEUE_PRESENTATION[key].sections),
    );
    for (const section of ["activities", "cases", "deals", "directory", "leads"]) {
      expect(owning.has(section as CrmSectionKey), section).toBe(true);
    }
  });
});
