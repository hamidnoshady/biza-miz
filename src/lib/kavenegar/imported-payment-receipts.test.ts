import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Issue #902 §9 item 0 — every path that records a payment tells the customer,
 * or says in a comment why it deliberately does not.
 *
 * The trigger itself was proven by `lookup-triggers.ts`'s own suite; what went
 * missing was the *wiring*: the counter's checkout and the offline replay
 * notified, and the two importers and the CMS storefront did not, so a customer
 * who ordered online never received the receipt their neighbour at the counter
 * did. That is not a bug a unit test of the dispatcher can find — it is a
 * property of the callers, so it is checked here by reading them.
 *
 * The assertions are about *shape*, not exact text: the call must exist in each
 * importer, it must be after `COMMIT`, it must be scoped to the business (a
 * public webhook has no session, and the lookup tables are tenant-RLS), and it
 * must not be awaited on the response path.
 */

const repoRoot = path.resolve(__dirname, "../../..");
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), "utf8");

const IMPORTERS = [
  {
    file: "src/lib/integrations/webhook-ingest-service.ts",
    name: "the storefront (plugin/WooCommerce) importers",
    // Two functions: F&B tickets and retail sales.
    expected: 2,
  },
  {
    file: "src/lib/cms/order-ingest-service.ts",
    name: "the CMS storefront importer",
    expected: 1,
  },
];

describe("an imported paid order notifies the customer too", () => {
  for (const importer of IMPORTERS) {
    it(`wires the receipt trigger into ${importer.name}`, () => {
      const source = read(importer.file);
      const calls = source.match(/void withTenant\(businessId, \(\) =>\s*\n\s*notifyPaymentReceived\(/g) ?? [];
      expect(calls).toHaveLength(importer.expected);
      expect(source).toMatch(/import \{ notifyPaymentReceived \} from "\.\.\/kavenegar\/lookup-triggers"/);
    });

    it(`calls it after the commit and never awaits it (${importer.name})`, () => {
      const source = read(importer.file);
      for (const match of source.matchAll(/void withTenant\(businessId, \(\) =>/g)) {
        const before = source.slice(0, match.index);
        // The last thing that happened before the notification is the commit
        // of the import: notifying inside the transaction would send a receipt
        // for a sale that might still roll back.
        const lastCommit = before.lastIndexOf('query("COMMIT")');
        expect(lastCommit).toBeGreaterThan(-1);
        const between = before.slice(lastCommit + 1);
        expect(between).not.toMatch(/query\("BEGIN"\)/);
        // Never `await`: a provider round trip must not hold the webhook open,
        // and a failed message must not fail a committed import.
        expect(before.slice(-40)).not.toMatch(/await\s+withTenant\(businessId/);
      }
    });
  }

  it("gives each importer the amount the customer actually paid", () => {
    for (const importer of IMPORTERS) {
      const source = read(importer.file);
      // The inserted payment row and the notified amount are the same figure.
      expect(source).toMatch(/if \(total > 0n\)/);
      expect(source).toMatch(/amountRial: Number\(total\)/);
    }
  });
});

describe("a corrected order deliberately sends no new receipt", () => {
  it("keeps the amendment bridge out, and says why in the file", () => {
    const source = read("src/lib/order-amendment-service.ts");
    expect(source).not.toMatch(/notifyPaymentReceived/);
    // The reason has to live next to the code, or the next reader "fixes" it.
    expect(source).toMatch(/an amendment \*rewrites\* what was already paid/);
    expect(source).toMatch(/charged twice/);
  });
});
