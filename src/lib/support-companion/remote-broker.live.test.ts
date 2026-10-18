import { beforeAll, describe, expect, it } from "vitest";
import {
  createBrokerShare,
  resolveRemoteBrokerConfig,
  revokeBrokerShare,
  type ResolvedRemoteBroker,
} from "./remote-broker";

/**
 * Issue #984 §3 — live MeshCentral conformance. Skipped unless a real
 * server is provided:
 *
 *   MESHCENTRAL_URL=wss://host:port MESHCENTRAL_USER=u MESHCENTRAL_PASS=p \
 *   MESHCENTRAL_ALLOW_SELF_SIGNED_TLS=true MESHCENTRAL_LIVE_NODE='node//…' \
 *   [MESHCENTRAL_LIVE_OUTSIDER_USER=u2 MESHCENTRAL_LIVE_OUTSIDER_PASS=p2] \
 *   npx vitest run src/lib/support-companion/remote-broker.live.test.ts
 *
 * The node needs an online agent in a mesh the user can share from (see
 * docs/support-companion.md §3 for the one-time setup). The outsider
 * account needs no rights at all — its bind must be refused. First green
 * run: MeshCentral 1.2.5, 2026-10-18.
 */
const LIVE_NODE = process.env.MESHCENTRAL_LIVE_NODE?.trim() ?? "";
const live = LIVE_NODE.length > 0;
const outsiderLive =
  live &&
  (process.env.MESHCENTRAL_LIVE_OUTSIDER_USER?.trim() ?? "").length > 0 &&
  (process.env.MESHCENTRAL_LIVE_OUTSIDER_PASS ?? "").length > 0;

let broker: ResolvedRemoteBroker = { provider: "none" };

async function guestPageStatus(url: string): Promise<number | string> {
  try {
    const res = await fetch(url, { redirect: "manual" });
    return res.status;
  } catch (err) {
    return err instanceof Error ? `fetch failed: ${err.message}` : "fetch failed";
  }
}

describe.skipIf(!live)("remote broker live conformance (issue #984 §3)", () => {
  beforeAll(() => {
    // Live runs target test servers with self-signed certificates; the
    // product transport carries its own opt-in flag, but the guest-page
    // fetches below use global fetch, which only honors the env switch.
    // Set here so normal CI (which skips this file) is unaffected.
    if (process.env.MESHCENTRAL_ALLOW_SELF_SIGNED_TLS === "true") {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    }
    broker = resolveRemoteBrokerConfig();
  });

  it("binds a view-only share whose guest URL serves, then revokes it", async () => {
    const created = await createBrokerShare(broker, {
      nodeId: LIVE_NODE,
      guestName: "live-view-probe",
      viewOnly: true,
      minutes: 15,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.binding.shareId.length).toBeGreaterThan(0);
    expect(created.operatorUrl).toContain("/sharing?c=");
    expect(await guestPageStatus(created.operatorUrl)).toBe(200);
    await expect(
      revokeBrokerShare(broker, { nodeId: LIVE_NODE, shareId: created.binding.shareId }),
    ).resolves.toEqual({ ok: true });
  });

  it("binds a control share and revokes it", async () => {
    const created = await createBrokerShare(broker, {
      nodeId: LIVE_NODE,
      guestName: "live-control-probe",
      viewOnly: false,
      minutes: 15,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.binding.viewOnly).toBe(false);
    await expect(
      revokeBrokerShare(broker, { nodeId: LIVE_NODE, shareId: created.binding.shareId }),
    ).resolves.toEqual({ ok: true });
  });

  it("keeps double revoke a success (operator revoke + customer Stop race)", async () => {
    const created = await createBrokerShare(broker, {
      nodeId: LIVE_NODE,
      guestName: "live-race-probe",
      viewOnly: true,
      minutes: 15,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const binding = { nodeId: LIVE_NODE, shareId: created.binding.shareId };
    await expect(revokeBrokerShare(broker, binding)).resolves.toEqual({ ok: true });
    await expect(revokeBrokerShare(broker, binding)).resolves.toEqual({ ok: true });
  });

  it("refuses an unknown node honestly", async () => {
    await expect(
      createBrokerShare(
        broker,
        { nodeId: "node//no-such-node", guestName: "live-bad-node", viewOnly: true, minutes: 15 },
      ),
    ).resolves.toMatchObject({ ok: false, error: "provider_error" });
  });

  it("lets the share die at its end (guest URL 200 -> 404)", async () => {
    const created = await createBrokerShare(broker, {
      nodeId: LIVE_NODE,
      guestName: "live-expiry-probe",
      viewOnly: true,
      minutes: 1,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(await guestPageStatus(created.operatorUrl)).toBe(200);
    const waitMs = Date.parse(created.binding.endsAt) - Date.now() + 12_000;
    expect(waitMs).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    expect(await guestPageStatus(created.operatorUrl)).toBe(404);
    // Post-expiry revoke resolves success (already gone), never a failure.
    await expect(
      revokeBrokerShare(broker, { nodeId: LIVE_NODE, shareId: created.binding.shareId }),
    ).resolves.toEqual({ ok: true });
  }, 150_000);

  it.skipIf(!outsiderLive)("refuses a cross-tenant bind (isolation)", async () => {
    const outsider = resolveRemoteBrokerConfig({
      MESHCENTRAL_URL: process.env.MESHCENTRAL_URL,
      MESHCENTRAL_USER: process.env.MESHCENTRAL_LIVE_OUTSIDER_USER,
      MESHCENTRAL_PASS: process.env.MESHCENTRAL_LIVE_OUTSIDER_PASS,
      MESHCENTRAL_ALLOW_SELF_SIGNED_TLS: process.env.MESHCENTRAL_ALLOW_SELF_SIGNED_TLS,
    });
    await expect(
      createBrokerShare(outsider, {
        nodeId: LIVE_NODE,
        guestName: "live-isolation-probe",
        viewOnly: true,
        minutes: 15,
      }),
    ).resolves.toMatchObject({ ok: false, error: "provider_error", detail: "Access denied" });
  });
});
