/**
 * The CRM's boundaries, enforced by reading its own source.
 *
 * ## Why a source-level test
 *
 * `APP_DATA_RULES` states who owns what. A document stating a rule does not
 * keep it: the WooCommerce sync wrote `parties` directly for two years while
 * the rules file said the Website app was a reader, and nothing noticed
 * because nothing checked.
 *
 * These are the checks. They are cheap, they run in the normal unit suite, and
 * they fail on the pull request that breaks the boundary rather than in
 * production six months later when two screens start disagreeing about what a
 * customer owes.
 *
 * Each rule below names the specific damage it prevents. A rule nobody can
 * justify is a rule that gets deleted the first time it is inconvenient, so
 * none of them is here on general principle.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const LIB_DIR = fileURLToPath(new URL(".", import.meta.url));

/** Strip comments, so a rule's own explanation cannot trip it. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

function crmLibFiles(): { name: string; source: string }[] {
  return readdirSync(LIB_DIR)
    .filter((name) => name.startsWith("crm-") && name.endsWith(".ts"))
    .filter((name) => !name.endsWith(".test.ts"))
    .map((name) => ({ name, source: code(readFileSync(`${LIB_DIR}${name}`, "utf8")) }));
}

describe("the CRM does not re-derive money", () => {
  it("contains no SQL against the ledger tables", () => {
    // A/R attribution spans orders, receipts, cheques and the closed-order
    // amendment bridge, and the join is not the one anyone writes from memory.
    // A second implementation in the CRM will get some corner of it wrong, and
    // then two screens disagree about what a customer owes with no way to tell
    // which is lying. Everything financial comes through
    // crm-accounting-contract.ts, which delegates to ar-service.
    const offenders: string[] = [];
    for (const file of crmLibFiles()) {
      if (file.name === "crm-accounting-contract.ts") continue;
      // Importing Accounting's own exported SQL fragment is the approved way
      // for a set-based CRM query (the segment engine, over 100k parties) to
      // get balances without an N+1 of per-customer service calls. It is the
      // opposite of a second implementation: it is *the* implementation,
      // reused. What is banned is hand-written ledger SQL.
      const usesSharedFragment = /arBalanceByCustomerSql|AR_CUSTOMER_ATTRIBUTION_SQL/.test(
        file.source,
      );
      for (const table of ["journal_lines", "journal_entries", "ar_receipts"]) {
        if (usesSharedFragment) continue;
        // Word-boundary match, so `crm_accounts_something` would not trip it.
        if (new RegExp(`\\b${table}\\b`).test(file.source)) {
          offenders.push(`${file.name} references ${table}`);
        }
      }
    }
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `The CRM must read money through crm-accounting-contract.ts, not by querying the ledger:\n` +
          offenders.map((line) => `  - ${line}`).join("\n"),
    ).toEqual([]);
  });

  it("keeps the accounting contract free of arithmetic of its own", () => {
    // The contract is a facade. The moment it starts computing a balance
    // rather than passing one through, it becomes the second implementation
    // the rule above exists to prevent.
    const source = code(
      readFileSync(`${LIB_DIR}crm-accounting-contract.ts`, "utf8"),
    );
    expect(source).not.toMatch(/\bSELECT\b/i);
    expect(source).not.toMatch(/\bquery\s*</);
  });
});

describe("winning a deal posts nothing", () => {
  it("no CRM module writes an order, invoice or journal line", () => {
    // A pipeline is a forecast. If dragging a card could issue a financial
    // document, anyone with CRM access could move the income statement, and
    // the real invoice raised in Accounting would double-count the same sale.
    const offenders: string[] = [];
    const forbidden = [
      /INSERT\s+INTO\s+orders\b/i,
      /INSERT\s+INTO\s+order_items\b/i,
      /INSERT\s+INTO\s+journal_entries\b/i,
      /INSERT\s+INTO\s+journal_lines\b/i,
      /INSERT\s+INTO\s+ar_receipts\b/i,
    ];
    for (const file of crmLibFiles()) {
      for (const pattern of forbidden) {
        if (pattern.test(file.source)) offenders.push(`${file.name}: ${pattern.source}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the handoff prepares a document rather than creating one", () => {
    const source = code(readFileSync(`${LIB_DIR}crm-deal-handoff.ts`, "utf8"));
    // It links an order that already exists; it must never make one.
    expect(source).not.toMatch(/INSERT\s+INTO\s+orders/i);
    expect(source).toMatch(/UPDATE crm_deals SET order_id/);
  });
});

describe("identity stays canonical", () => {
  it("no CRM module creates a second customer table", () => {
    // `parties` is the one identity record. A "contacts" or "crm_customers"
    // table would split one person across two rows that can never be
    // reconciled, which is the exact failure the party model exists to avoid.
    const offenders: string[] = [];
    for (const file of crmLibFiles()) {
      if (/INSERT\s+INTO\s+(crm_)?(customers|contacts)\b/i.test(file.source)) {
        offenders.push(file.name);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never resolves an ambiguous person with ORDER BY created_at LIMIT 1", () => {
    // The bug that attached one customer's online orders to another's record:
    // two people sharing a phone, and the sync silently picked the older row.
    // Identity queries must return every candidate and let a human choose.
    const offenders: string[] = [];
    for (const file of crmLibFiles()) {
      // Only flag it on `parties` — the same clause over `locations` picks a
      // default branch, which is a legitimate and harmless use.
      const partyQueries = file.source.match(/FROM parties[\s\S]{0,400}?(?=`)/gi) ?? [];
      for (const fragment of partyQueries) {
        if (/ORDER BY\s+created_at\s+LIMIT\s+1/i.test(fragment)) offenders.push(file.name);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("consent is never manufactured", () => {
  it("no sync or import path grants consent", () => {
    // Buying something is not permission to be marketed to. Only an explicit
    // consent change writes these columns, and it writes an audit row with it.
    const offenders: string[] = [];
    const consentWrite = /(sms_consent|marketing_consent)\s*=\s*(true|\$)/i;
    for (const file of crmLibFiles()) {
      if (file.name === "crm-service.ts") continue; // the consent service itself
      if (consentWrite.test(file.source)) offenders.push(file.name);
    }
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `These modules write consent columns. Only the consent service may:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("the external identity path creates parties without touching consent", () => {
    const source = code(readFileSync(`${LIB_DIR}crm-external-identity.ts`, "utf8"));
    const insert = source.match(/INSERT INTO parties[\s\S]*?RETURNING id/i)?.[0] ?? "";
    expect(insert).not.toMatch(/consent/i);
  });
});

describe("merge stays human-only and irreversible-safe", () => {
  it("is absent from the assistant's action catalogue", () => {
    // Irreversible plus automatic is a combination this codebase does not
    // ship. An assistant that could merge customer records could destroy a
    // directory faster than anyone could notice.
    const catalogue = readdirSync(LIB_DIR).filter((name) => name.includes("action-catalog"));
    for (const name of catalogue) {
      const source = code(readFileSync(`${LIB_DIR}${name}`, "utf8"));
      expect(source).not.toMatch(/mergeCustomers|crm\/customers\/merge/);
    }
  });

  it("keeps every irreversible CRM act out of the AI surface", () => {
    // The full list, not just merge. Each of these makes a decision about a
    // real person that has to carry a human's name: merging two people,
    // deciding who may be marketed to, turning an enquiry into a customer
    // record, and reshaping a board every historical report is keyed to.
    //
    // Note `convertLead` in particular: it creates a party and can open a
    // deal, and its duplicate check is designed to *stop and ask a human*.
    // A caller that cannot be asked would have to either refuse always or
    // override always, and both are wrong.
    const forbidden = [
      "mergeCustomers",
      "setConsent",
      "recordConsent",
      "convertLead",
      "savePipelineStages",
      "resolveExternalProfile",
    ];
    const aiFiles = readdirSync(LIB_DIR).filter(
      (name) =>
        (name.startsWith("ai-") || name.includes("autopilot")) &&
        name.endsWith(".ts") &&
        !name.endsWith(".test.ts"),
    );
    const offenders: string[] = [];
    for (const name of aiFiles) {
      const source = code(readFileSync(`${LIB_DIR}${name}`, "utf8"));
      for (const symbol of forbidden) {
        if (new RegExp(`\\b${symbol}\\b`).test(source)) offenders.push(`${name} → ${symbol}`);
      }
    }
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `These AI modules reach an irreversible or judgement-bearing CRM action:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("keeps CRM client components off the server-only services", () => {
    // A `"use client"` file importing a service that imports `./db` pulls `pg`
    // into the browser bundle, and the build fails with `Can't resolve 'fs'` —
    // a message that names node_modules and not the import that caused it.
    // `crm-shared.ts` exists for the vocabulary both halves need; this keeps
    // the next component from reaching past it.
    //
    // tsc cannot catch this: the types are perfectly valid, and the failure is
    // a bundler concern that only surfaces during `next build`.
    const serverOnly = new Set(
      crmLibFiles()
        .filter(({ source }) => /from "\.\/db"/.test(source))
        .map(({ name }) => name.replace(/\.ts$/, "")),
    );

    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".tsx") && !entry.name.endsWith(".ts")) continue;
        if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) continue;
        const raw = readFileSync(full, "utf8");
        if (!/^\s*["']use client["']/m.test(raw)) continue;
        const source = code(raw);
        for (const service of serverOnly) {
          // `import type` is erased before bundling, so a type-only reference
          // to a server module is free. Only a value import pulls the runtime
          // in — that is the one that breaks the build.
          const valueImport = new RegExp(
            `import\\s+(?!type\\s)[^;]*?from "@/lib/${service}"`,
            "s",
          );
          if (valueImport.test(source)) {
            offenders.push(`${full.slice(full.indexOf("src/"))} → ${service}`);
          }
        }
      }
    };
    walk(fileURLToPath(new URL("../app/(app)/crm", import.meta.url)).replace(/\/$/, ""));

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `These client components import a server-only CRM service; move the shared vocabulary into crm-shared.ts:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("drives reference moves from the registry, not a hand-written list", () => {
    // The hand-written list fell one table behind every feature that linked
    // something to a customer, and the symptom was silent.
    const source = code(readFileSync(`${LIB_DIR}crm-service.ts`, "utf8"));
    expect(source).toMatch(/movedPartyReferences\(\)/);
    // The old shape: a literal array of table names iterated with a for..of.
    expect(source).not.toMatch(/for \(const table of \[\s*"customer_points"/);
  });
});

describe("the CRM triggers Growth but never sends", () => {
  /**
   * Every file the CRM owns: its library, its API, and its screens.
   *
   * Wider than `crmLibFiles()` on purpose. The rule is about a *capability*
   * rather than a module: a screen that fetched Growth's campaign endpoint, or a
   * route that inserted a recipient row, would break it exactly as a service
   * would.
   */
  function crmSurfaceFiles(): { name: string; source: string }[] {
    const files: { name: string; source: string }[] = crmLibFiles();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(?:ts|tsx)$/.test(entry.name)) continue;
        if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) continue;
        files.push({ name: full.slice(full.indexOf("src/")), source: code(readFileSync(full, "utf8")) });
      }
    };
    walk(fileURLToPath(new URL("../app/api/crm", import.meta.url)).replace(/\/$/, ""));
    walk(fileURLToPath(new URL("../app/(app)/crm", import.meta.url)).replace(/\/$/, ""));
    return files;
  }

  it("names nothing in Growth's sending half, anywhere in the CRM", () => {
    // The issue's line: the CRM may *trigger* Growth but must not send a
    // campaign itself. Growth builds audiences from segments, checks consent and
    // writes the outbox; a CRM file naming any of those tables or the service
    // that owns them is either sending or reading something it has no business
    // reading. Growth reading *the CRM* is the direction that keeps this
    // acyclic, and it is the direction that already exists.
    const forbidden = [
      "message-campaigns-service",
      "message_campaigns",
      "message_recipients",
      "message_outbox",
      "message_templates",
      "growth-settings",
      "growth_settings",
    ];
    const offenders: string[] = [];
    for (const file of crmSurfaceFiles()) {
      for (const name of forbidden) {
        if (file.source.includes(name)) offenders.push(`${file.name} → ${name}`);
      }
    }
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `The CRM must signal Growth rather than reach into it:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("gives the automations engine no table to write but its own records", () => {
    // An automation is the one part of the CRM that acts with nobody watching,
    // so its write surface is one file and is asserted here. A new INSERT in
    // this file is a new capability — it has to be added to this list
    // deliberately, which is the point.
    const source = code(readFileSync(`${LIB_DIR}crm-automation-service.ts`, "utf8"));
    const statements = [...source.matchAll(/`([^`]*)`/g)]
      .map((match) => match[1])
      .filter((statement) => /\b(INSERT INTO|UPDATE|DELETE FROM)\b/i.test(statement));

    expect(statements).toHaveLength(8);
    for (const statement of statements) {
      expect(statement).toMatch(
        /INSERT INTO crm_activities|INSERT INTO crm_automations\b|INSERT INTO crm_automation_runs|UPDATE crm_automations|UPDATE \$\{table\.name\}|DELETE FROM crm_automations/,
      );
    }

    // The three record tables its one owner-update reaches are named literally
    // in the same file — never built from a caller's input, and never a fourth.
    for (const literal of [
      "crm_deals",
      "crm_cases",
      "crm_leads",
      "owner_user",
      "owner_user_id",
      "assigned_to",
      "assignee_user_id",
      "owner_name",
    ]) {
      expect(source).toContain(literal);
    }

    // And no money, no message, no consent register.
    expect(source).not.toMatch(/journal|ledger|invoice|campaign|outbox|consent/i);
  });
});
