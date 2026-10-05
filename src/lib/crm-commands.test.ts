/**
 * The command field's grammar.
 *
 * The properties that matter, in order:
 *
 *  1. **Nothing typed becomes a query.** The interpreter returns keys from a
 *     closed vocabulary, and the only strings it ever emits are hrefs the app
 *     already has. A phrase with no alias is a person's name, and the directory
 *     — with its own permission — answers that.
 *  2. **The reader's keyboard is tolerated.** `ZWNJ`, Arabic `ي`/`ك`, Persian
 *     digits and a trailing question mark all fold away before matching.
 *  3. **A destination nobody can open is not a result.** Filtering happens
 *     before rendering, from the same permission table the layout uses.
 */
import { describe, expect, it } from "vitest";
import { effectivePermissions } from "./permissions";
import type { Role } from "./auth-edge";
import { CRM_SECTION_KEYS, canViewCrmSection, type CrmSectionKey } from "./crm-permissions";
import { CRM_QUEUE_KEYS, CRM_QUEUE_PRESENTATION } from "./crm-shared";
import {
  availableCrmCommands,
  interpretCrmCommand,
  normalizeCrmPhrase,
} from "./crm-commands";

const interpreted = (text: string) => interpretCrmCommand(text);
const sectionsOf = (text: string) =>
  interpreted(text)
    .matches.filter((match) => match.kind === "section")
    .map((match) => match.key);
const queuesOf = (text: string) =>
  interpreted(text)
    .matches.filter((match) => match.kind === "queue")
    .map((match) => match.key);

describe("normalizeCrmPhrase", () => {
  it("folds everything a Persian keyboard varies", () => {
    expect(normalizeCrmPhrase("پیگیری‌ها")).toBe("پیگیریها");
    expect(normalizeCrmPhrase("پيگيري ها")).toBe("پیگیری ها");
    expect(normalizeCrmPhrase("مریم؟")).toBe("مریم");
    expect(normalizeCrmPhrase("  کارهای   امروز ")).toBe("کارهای امروز");
    expect(normalizeCrmPhrase("۰۹۱۲")).toBe("0912");
    expect(normalizeCrmPhrase("٠٩١٢")).toBe("0912");
  });
});

describe("interpretCrmCommand", () => {
  it("sends a section name to that section", () => {
    expect(sectionsOf("تیکت‌ها")).toContain("cases");
    expect(sectionsOf("فرصت‌ها")).toContain("deals");
    expect(sectionsOf("امروز")).toContain("overview");
    expect(sectionsOf("رضایت")).toContain("consent");
  });

  it("sends a problem to the queue that names it", () => {
    expect(queuesOf("پیگیری‌های عقب‌افتاده")).toContain("overdue_follow_ups");
    expect(queuesOf("معامله‌های راکد")).toContain("stalled_deals");
    expect(queuesOf("خطر مهلت")).toContain("sla_risk");
    expect(queuesOf("کارهای عضو غیرفعال")).toContain("departed_owner");
    expect(queuesOf("مشتریان در خطر")).toContain("at_risk_customers");
  });

  it("prefers the longer phrase", () => {
    // «سرنخ تازه» is a queue; «سرنخ» alone is the section. Both match, and the
    // specific one comes first.
    const matches = interpreted("سرنخ تازه").matches;
    expect(matches[0].key).toBe("new_leads");
    expect(matches.map((match) => match.key)).toContain("leads");
  });

  it("points every queue at the screen that owns it", () => {
    for (const key of CRM_QUEUE_KEYS) {
      const owner = CRM_QUEUE_PRESENTATION[key].sections[0];
      const matches = interpreted(CRM_QUEUE_PRESENTATION[key].label).matches;
      const match = matches.find((entry) => entry.key === key);
      expect(match, `${key} — «${CRM_QUEUE_PRESENTATION[key].label}»`).toBeTruthy();
      expect(match!.href).toBe(`/crm/${owner}`);
      expect(match!.section).toBe(owner);
    }
  });

  it("names every menu destination in its own vocabulary", () => {
    // Every destination the menu offers must be reachable by *some* phrase, or
    // the field quietly cannot answer a question the menu can. `persons` is not
    // a destination — it is one customer's file, reached from the directory —
    // so it is deliberately excluded.
    const reachable = new Set<string>();
    for (const section of CRM_SECTION_KEYS) {
      const queries = [
        "امروز", "مشتریان", "سرنخ‌ها", "فرصت‌ها", "پیگیری‌ها", "تیکت‌ها",
        "بخش‌بندی", "رضایت", "کیفیت داده", "تکراری‌ها", "تطبیق", "سابقه", "تنظیمات",
        // Reached from the settings screen rather than the rail, but a person
        // who types «اتوماسیون» must still land on it.
        "اتوماسیون",
      ];
      for (const query of queries) if (sectionsOf(query).includes(section)) reachable.add(section);
    }
    expect(
      [...CRM_SECTION_KEYS].filter((key) => key !== "persons" && !reachable.has(key)),
    ).toEqual([]);
  });

  it("falls back to a person's name rather than guessing", () => {
    const person = interpreted("مریم احمدی");
    expect(person.matches).toEqual([]);
    expect(person.searchPeople).toBe(true);
    expect(person.normalized).toBe("مریم احمدی");
  });

  it("still searches people when a phrase is both a queue and a name", () => {
    // «معامله‌های مریم» matched the deals section, but it clearly names
    // somebody: answering only with the board would ignore half the question.
    const result = interpreted("معامله‌های مریم");
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.searchPeople).toBe(true);
  });

  it("does not search people for a phrase that is only a qualifier", () => {
    expect(interpreted("تیکت‌ها").searchPeople).toBe(false);
    expect(interpreted("").matches).toEqual([]);
    expect(interpreted("").searchPeople).toBe(false);
  });

  it("never returns a key outside the declared vocabularies", () => {
    const sectionKeys = new Set<string>(CRM_SECTION_KEYS);
    const queueKeys = new Set<string>(CRM_QUEUE_KEYS);
    const phrases = [
      "امروز", "مشتریان", "تیکت‌ها", "پیگیری‌های عقب‌افتاده", "معامله‌های راکد",
      "مریم", "۰۹۱۲۳۴۵۶۷۸۹", "select * from parties", "'; drop table parties; --",
      "کارهای عضو غیرفعال",
    ];
    for (const phrase of phrases) {
      const result = interpreted(phrase);
      for (const match of result.matches) {
        const keys = match.kind === "section" ? sectionKeys : queueKeys;
        expect(keys.has(match.key), `${phrase} → ${match.kind}:${match.key}`).toBe(true);
        // The href is one the app already has: a CRM path, and never a query.
        expect(match.href.startsWith("/crm/")).toBe(true);
        expect(match.href).not.toMatch(/[?&=]/);
      }
      // A phrase the vocabulary does not know is a *person search*, never a
      // statement: the only thing that can happen to it is a parameterised
      // `/api/parties?q=`.
      if (phrase.startsWith("select") || phrase.includes("drop table")) {
        expect(result.matches).toEqual([]);
        expect(result.searchPeople).toBe(true);
      }
    }
  });

  it("keeps the interpreted phrase visible for the reader", () => {
    const result = interpreted("معامله‌های راکد");
    expect(result.normalized.length).toBeGreaterThan(0);
    const queue = result.matches.find((match) => match.key === "stalled_deals");
    expect(queue!.matched.length).toBeGreaterThan(0);
  });
});

describe("availableCrmCommands", () => {
  const openFor = (role: string) => {
    const held = effectivePermissions(role as Role, null);
    return (section: CrmSectionKey) => canViewCrmSection(held, section);
  };

  it("offers a manager every destination it matched", () => {
    const matches = interpreted("تیکت‌ها").matches;
    expect(availableCrmCommands(matches, openFor("manager"))).toHaveLength(matches.length);
  });

  it("never offers a cashier a door they cannot open", () => {
    const cashier = openFor("cashier");
    const floor = new Set<CrmSectionKey>(["directory", "persons", "activities", "cases"]);
    for (const phrase of ["امروز", "فرصت‌ها", "بخش‌بندی", "تکراری‌ها", "سابقه", "رضایت", "تنظیمات", "قیف"]) {
      const offered = availableCrmCommands(interpreted(phrase).matches, cashier);
      // Not "empty": the floor is offered its *own* surfaces — «امروز» reaches
      // the activities queue, which is where a cashier's day actually is.
      for (const match of offered) {
        expect(floor.has(match.section), `${phrase} → ${match.section}`).toBe(true);
      }
      expect(offered.map((match) => match.section)).not.toContain("deals");
      expect(offered.map((match) => match.section)).not.toContain("segments");
      expect(offered.map((match) => match.section)).not.toContain("overview");
    }
    // The floor keeps its own surfaces: the directory and the service desk.
    expect(availableCrmCommands(interpreted("تیکت‌ها").matches, cashier).map((m) => m.section)).toEqual([
      "cases",
    ]);
    expect(
      availableCrmCommands(interpreted("مشتریان").matches, cashier).map((m) => m.section),
    ).toContain("directory");
  });

  it("returns nothing for a role the app does not admit at all", () => {
    for (const role of ["accountant", "waiter", "kitchen"]) {
      expect(availableCrmCommands(interpreted("امروز").matches, openFor(role))).toEqual([]);
    }
  });
});
