import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ACTION_META, AUDIT_ACTION_FAMILIES, auditMetaFor } from "./action-meta";

/**
 * Issue #902 §6 — the audit log is the console's accountability story, and a
 * managed-SMS action that renders as a raw `sms.managed_account.suspend` string
 * is not an answer to "who suspended this business's messages, and when".
 *
 * The rule is a sweep rather than a list: the actions are read back out of the
 * code that writes them, so adding a tenth managed-account action without a
 * label fails here instead of on the day someone needs to read the log.
 */

const repoRoot = path.resolve(__dirname, "../../../..");

function source(relative: string): string {
  return readFileSync(path.join(repoRoot, relative), "utf8");
}

/** The SMS routes that write `platform_audit_log` rows. */
const WRITERS = ["src/app/api/platform/sms/accounts/route.ts", "src/app/api/platform/sms/route.ts"];

describe("the managed-SMS audit vocabulary", () => {
  it("labels every sms.* action the console actually writes", () => {
    const written = new Set<string>();
    for (const file of WRITERS) {
      for (const match of source(file).matchAll(/action:\s*"(sms\.[a-z0-9_.]+)"/g)) {
        written.add(match[1]!);
      }
    }

    expect(written.size).toBeGreaterThan(10);
    const unlabeled = [...written].filter((action) => !ACTION_META[action]);
    expect(unlabeled).toEqual([]);

    // Every label is a real Persian label, not the key echoed back.
    for (const action of written) {
      const meta = auditMetaFor(action);
      expect(meta.label).not.toBe(action);
      expect(meta.label.trim()).not.toBe("");
    }
  });

  it("follows the provisioning switch, so a new job kind cannot ship unlabeled", () => {
    // The queue endpoint writes `sms.managed_account.${action}` for the kinds
    // `jobKindFor` accepts; the switch is the only place that list lives.
    const route = source("src/app/api/platform/sms/accounts/route.ts");
    const switchBody = route.slice(route.indexOf("function jobKindFor"));
    const kinds = [...switchBody.matchAll(/case "([a-z_]+)":/g)]
      .map((match) => match[1]!)
      .filter((kind) => kind !== "default");

    expect(kinds).toContain("provision");
    const unlabeled = kinds.filter((kind) => !ACTION_META[`sms.managed_account.${kind}`]);
    expect(unlabeled).toEqual([]);
  });

  it("offers the family the console links to", () => {
    const smsFamily = AUDIT_ACTION_FAMILIES.find((family) => family.value === "sms");
    expect(smsFamily).toBeDefined();
    expect(smsFamily!.label.trim()).not.toBe("");

    // The API matches the family as a prefix (`action LIKE '<value>%'`), so the
    // family value must be a prefix of the actions it promises to show.
    const smsActions = Object.keys(ACTION_META).filter((action) => action.startsWith(`${smsFamily!.value}.`));
    expect(smsActions.length).toBeGreaterThan(10);
  });

  it("keeps the deep links the messaging console renders filterable", () => {
    const card = source("src/app/platform/messaging/managed-accounts-card.tsx");

    // Both links must carry the family, or "رویدادهای این حساب" lands the
    // operator on the unfiltered log — the gap §6 closed.
    expect(card).toMatch(/\/platform\/audit\?actionFamily=sms/);
    expect(card).toMatch(/\/platform\/audit\?actionFamily=sms&businessId=\$\{account\.businessId\}/);
  });
});
