import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTION_FAMILIES,
  auditFamily,
  expandAuditActionFamily,
} from "@/lib/audit-families";
import { ACTION_META, auditMetaFor } from "./action-meta";

/**
 * Issue #1296 follow-up — two defects found while closing the audit, both in
 * the audit log itself:
 *
 *  1. `platform_backup.cloud.retry` had no label, so the console showed the raw
 *     key for the very action the retry button writes. 121 of the 146 platform
 *     actions had the same gap; the sweep below is what stops it recurring.
 *  2. The «پشتیبان‌گیری» family filter was a bare `LIKE 'backup%'`, which matched
 *     one row of twenty-eight, because the routes write `platform_backup.*` and
 *     `tenant_backup.*`. «سایت‌ساز» (`cms`) matched nothing at all — every CMS
 *     action is `platform_cms.*`.
 *
 * The rule is a sweep rather than a list: the actions are read back out of the
 * code that writes them, so a new action without a label — or a family whose
 * prefixes do not cover the actions it promises — fails here instead of on the
 * day someone needs to read the log.
 */

const repoRoot = path.resolve(__dirname, "../../../..");

function source(relative: string): string {
  return readFileSync(path.join(repoRoot, relative), "utf8");
}

/**
 * Every audit action the code writes, from both shapes the repo uses:
 *
 *  - `action: "family.thing"` — the object form every route calls.
 *  - `'family.thing'` inside an `INSERT INTO platform_audit_log` — the SQL form
 *    the support-session lifecycle uses, because it writes the row in the same
 *    statement that closes the session. `support_session.*` was a dead filter
 *    for exactly this reason: nothing with an `action:` field writes it.
 */
function writtenActions(): Set<string> {
  const files = execSync("git ls-files 'src/**/*.ts' 'src/**/*.tsx'", { cwd: repoRoot, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((file) => file && !/\.test\.tsx?$/.test(file));

  const actions = new Set<string>();
  for (const file of files) {
    const source = readFileSync(path.join(repoRoot, file), "utf8");
    for (const match of source.matchAll(/action:\s*[`"]([a-z][a-z0-9_]*\.[a-z0-9_.]+)[`"]/g)) {
      actions.add(match[1]!);
    }
    // Only the window after each INSERT, so table names quoted elsewhere in the
    // same file (`public.business_desktop_update_policies`) are not mistaken for
    // actions.
    for (const insert of source.matchAll(/INSERT INTO platform_audit_log/g)) {
      const window = source.slice(insert.index, insert.index + 2500);
      for (const match of window.matchAll(/'([a-z][a-z0-9_]*\.[a-z0-9_.]+)'/g)) {
        actions.add(match[1]!);
      }
    }
  }
  return actions;
}

describe("the audit action vocabulary", () => {
  it("labels every action inside every family the dropdown offers", () => {
    const actions = writtenActions();
    expect(actions.size).toBeGreaterThan(250);

    // Only the actions a family claims are held to the label rule. The log also
    // holds tenant-scoped integration events whose prefixes are not console
    // families at all; requiring labels for those would mean inventing a family
    // per integration, which is a different decision.
    const inFamily = [...actions].filter((action) =>
      AUDIT_ACTION_FAMILIES.some((family) =>
        family.prefixes.some((prefix) => action.startsWith(prefix)),
      ),
    );
    expect(inFamily.length).toBeGreaterThan(80);

    const unlabeled = inFamily.filter((action) => !ACTION_META[action]).sort();
    expect(unlabeled).toEqual([]);

    // …and each label is a real Persian label, not the key echoed back, which is
    // what the fallback in `auditMetaFor` does.
    for (const action of inFamily) {
      const meta = auditMetaFor(action);
      expect(meta.label).not.toBe(action);
      expect(meta.label.trim()).not.toBe("");
    }
  });

  it("labels the retry action the backup console writes", () => {
    // The exact gap the #1296 audit named. Asserted explicitly as well as by the
    // sweep, because this one shipped and an operator read the raw key.
    expect(source("src/app/api/platform/backup/retry/route.ts")).toContain(
      '"platform_backup.cloud.retry"',
    );
    expect(ACTION_META["platform_backup.cloud.retry"]).toBeDefined();
    expect(auditMetaFor("platform_backup.cloud.retry").label).toContain("دوباره");
  });

  it("expands a family to every prefix it promises", () => {
    // A family's prefixes must be non-empty, and every one must be a prefix of
    // the family's own value or a documented sibling namespace — otherwise the
    // filter is asking for rows that cannot exist.
    for (const family of AUDIT_ACTION_FAMILIES) {
      expect(family.label.trim()).not.toBe("");
      expect(family.prefixes.length).toBeGreaterThan(0);
      for (const prefix of family.prefixes) {
        expect(prefix.trim()).toBe(prefix);
        expect(prefix.length).toBeGreaterThan(0);
      }
    }

    // The backup family covers all three namespaces the console writes.
    expect(expandAuditActionFamily("backup").sort()).toEqual([
      "backup",
      "platform_backup",
      "tenant_backup",
    ]);
    // The CMS family covers what `platform_cms.*` actually writes.
    expect(expandAuditActionFamily("cms")).toEqual(["platform_cms"]);
    // A value that is not a registered family stays a literal prefix, so the
    // MCP's `platform_mcp` hint and the exact-match filter keep working.
    expect(expandAuditActionFamily("platform_mcp")).toEqual(["platform_mcp"]);
    expect(expandAuditActionFamily("business.suspended")).toEqual(["business.suspended"]);
    expect(auditFamily("mcp")?.prefixes).toEqual(["platform_mcp"]);
    expect(auditFamily("nope")).toBeUndefined();
  });

  it("no family is a dead filter", () => {
    // A family whose prefixes match nothing the code writes is a dropdown entry
    // that silently returns an empty log — the «سایت‌ساز» defect.
    const actions = writtenActions();
    const dead = AUDIT_ACTION_FAMILIES.filter(
      (family) =>
        ![...actions].some((action) => family.prefixes.some((prefix) => action.startsWith(prefix))),
    ).map((family) => family.value);
    expect(dead).toEqual([]);
  });

  it("keeps the SMS vocabulary and family from issue #902", () => {
    // The older guarantee, still enforced from the source of truth.
    const smsFamily = AUDIT_ACTION_FAMILIES.find((family) => family.value === "sms");
    expect(smsFamily).toBeDefined();
    const smsActions = Object.keys(ACTION_META).filter((action) => action.startsWith("sms."));
    expect(smsActions.length).toBeGreaterThan(10);

    const card = source("src/app/platform/messaging/managed-accounts-card.tsx");
    expect(card).toMatch(/\/platform\/audit\?actionFamily=sms/);
  });
});
