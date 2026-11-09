import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { routeOrderTenders, routeWebsitePayment } from "./order-payment-routing-service";

vi.mock("./deployment-role", () => ({ deploymentRole: () => "central" }));

const tenant = "b6e91854-a734-4337-961f-7aa697157c24";
const branch = "92775d3d-b217-4d6d-81a3-4fa940ff573c";
const terminal = "fc7fd368-9338-4cb3-9b86-acd0fe4fc170";
const secondTerminal = "0d057304-f0db-450c-b6db-a683e36ba44b";
const firstGl = "34a547c6-2549-4e2b-89a1-dab10ed27722";
const secondGl = "8624e63c-8ed0-4766-a5e2-407165cb5930";
const connection = "51e76db7-0d19-4fcb-a90a-f809ca814adf";

function testClient(options: { enabled?: boolean; paired?: boolean } = {}) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("AS enabled")) return { rows: [{ enabled: options.enabled ?? true, paired: options.paired ?? false }] };
    if (sql.includes("AS routes")) return { rows: [{ routes: [{
      provider: "woocommerce", connectionId: connection, gateway: "confirmed-gateway",
      settlement: "online", financialAccountId: terminal,
    }] }] };
    if (sql.includes("FROM financial_accounts f")) return { rows: [
      { id: terminal, name: "First terminal", kind: "pos_psp", gl_account_id: firstGl, gl_account_code: "11201" },
      { id: secondTerminal, name: "Second terminal", kind: "pos_psp", gl_account_id: secondGl, gl_account_code: "11202" },
    ] };
    if (sql.includes("FROM accounts WHERE")) return { rows: [
      { id: firstGl, code: "11201", type: "asset", parentId: null },
      { id: secondGl, code: "11202", type: "asset", parentId: null },
    ] };
    return { rows: [] };
  });
  return { query, client: { query } as unknown as Pick<PoolClient, "query"> };
}

describe("account-specific payment routing", () => {
  it("keeps split card tenders on separate clearing accounts", async () => {
    const { client } = testClient();
    const routed = await routeOrderTenders(client, tenant, branch, [
      { methodId: null, settlement: "card", reference: null, amount: 400, financialAccountId: terminal },
      { methodId: null, settlement: "card", reference: null, amount: 600, financialAccountId: secondTerminal },
    ]);
    expect(routed.map(({ amount, financialAccountGlId, financialAccountGlCode }) => [amount, financialAccountGlId, financialAccountGlCode]))
      .toEqual([[400, firstGl, "11201"], [600, secondGl, "11202"]]);
  });

  it("requires the verified gateway and leaves an unactivated branch on its legacy route", async () => {
    const { client } = testClient();
    await expect(routeWebsitePayment(client, tenant, branch, "woocommerce", connection, "confirmed-gateway"))
      .resolves.toMatchObject({ financialAccountId: terminal, financialAccountGlId: firstGl, settlement: "online" });
    await expect(routeWebsitePayment(client, tenant, branch, "woocommerce", connection, "other-gateway"))
      .rejects.toThrow("website_payment_source_required");
    await expect(routeWebsitePayment(testClient({ enabled: false }).client, tenant, branch, "woocommerce", connection, "other-gateway"))
      .resolves.toBeNull();
  });

  it("blocks shared legacy sync even when there is no registered peer", async () => {
    vi.stubEnv("ALLOW_LEGACY_SYNC_TOKEN", "1");
    vi.stubEnv("REMOTE_SYNC_TOKEN", "legacy-test-token");
    try {
      await expect(routeWebsitePayment(testClient().client, tenant, branch, "woocommerce", connection, "confirmed-gateway"))
        .rejects.toThrow("payment_routing_peer_unsupported");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("blocks the new posting contract for paired branches", async () => {
    const { client, query } = testClient({ paired: true });
    await expect(routeWebsitePayment(client, tenant, branch, "woocommerce", connection, "confirmed-gateway"))
      .rejects.toThrow("payment_routing_peer_unsupported");
    expect(query.mock.calls.some(([sql]) => sql.includes("server_sync_tokens"))).toBe(true);
  });
});
