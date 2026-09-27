import { describe, expect, it } from "vitest";
import { isCentralExecutionPath } from "../middleware";

describe("public and bearer cloud API execution targets", () => {
  it("marks every cloud transport and OAuth surface central-only", () => {
    for (const path of [
      "/api/rollup/ingest", "/api/server-sync/push", "/api/server-sync/pull",
      "/api/server-sync/update-check", "/api/server-sync/media/abc", "/api/server-sync/config/generate-token",
      "/api/peer/backup/manifest",
      "/api/v1/orders", "/api/ai/chat", "/api/workspace/projects", "/api/billing/plans",
      "/api/messaging/campaigns", "/api/notifications/devices", "/api/notifications/public-key",
      "/api/notifications/test", "/api/growth/overview", "/api/cms/sites", "/api/website/sync",
      "/api/connections/website", "/api/integrations/wordpress/events",
      "/api/integrations/woocommerce/webhook/id", "/api/mcp", "/api/mcp/oauth/token",
      "/api/connections/mcp/consent", "/api/well-known/oauth-authorization-server/x",
      "/.well-known/oauth-protected-resource", "/api/cms/revalidate", "/api/cms/order-events", "/api/pairing/redeem",
      "/mcp/consent",
    ]) expect(isCentralExecutionPath(path), path).toBe(true);
  });

  it("leaves Local exceptions, auth, health, LAN printing and first-run pairing on site", () => {
    for (const path of [
      "/api/cloud-exceptions/relay", "/api/auth/login", "/api/health",
      "/api/printing/print", "/api/setup/pair", "/api/connection/status",
      "/api/server-sync/config", "/api/server-sync/reconcile",
    ]) expect(isCentralExecutionPath(path), path).toBe(false);
  });

  it("does not accept near-miss prefixes", () => {
    expect(isCentralExecutionPath("/api/mcpx")).toBe(false);
    expect(isCentralExecutionPath("/api/v10/orders")).toBe(false);
    expect(isCentralExecutionPath("/api/server-synchronize")).toBe(false);
  });
});
