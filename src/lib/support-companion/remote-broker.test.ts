import { WebSocketServer } from "ws";
import { beforeEach, describe, expect, it } from "vitest";
import {
  agentArchFromName,
  agentInstallUrl,
  createBrokerShare,
  listMeshNodes,
  listMeshNodesCached,
  matchNodeByHostname,
  meshcentralTransport,
  resetMeshNodesCacheForTests,
  resolveRemoteBrokerConfig,
  revokeBrokerShare,
  shareParamsForCaps,
  type BrokerTransport,
  type RemoteBrokerConfig,
} from "./remote-broker";

const CONFIG: RemoteBrokerConfig = {
  provider: "meshcentral",
  controlUrl: "wss://mesh.example.com/control.ashx",
  username: "biza-support",
  password: "s3cret",
  allowSelfSignedTls: false,
        meshId: "",
};

describe("remote broker config (issue #984)", () => {
  it("resolves to none when unconfigured", () => {
    expect(resolveRemoteBrokerConfig({})).toEqual({ provider: "none" });
    expect(resolveRemoteBrokerConfig({ MESHCENTRAL_URL: "  " })).toEqual({ provider: "none" });
  });

  it("normalizes https URLs to the wss control channel", () => {
    const resolved = resolveRemoteBrokerConfig({
      MESHCENTRAL_URL: "https://mesh.example.com",
      MESHCENTRAL_USER: "biza-support",
      MESHCENTRAL_PASS: "s3cret",
    });
    expect(resolved).toMatchObject({
      provider: "meshcentral",
      controlUrl: "wss://mesh.example.com/control.ashx",
      username: "biza-support",
    });
  });

  it("refuses to half-configure the service account", () => {
    expect(() =>
      resolveRemoteBrokerConfig({ MESHCENTRAL_URL: "wss://mesh.example.com" }),
    ).toThrow("MESHCENTRAL_USER");
    expect(() =>
      resolveRemoteBrokerConfig({ MESHCENTRAL_URL: "not a url", MESHCENTRAL_USER: "u", MESHCENTRAL_PASS: "p" }),
    ).toThrow("MESHCENTRAL_URL");
  });

  it("keeps strict TLS unless explicitly opted out", () => {
    const base = {
      MESHCENTRAL_URL: "wss://mesh.example.com",
      MESHCENTRAL_USER: "u",
      MESHCENTRAL_PASS: "p",
    };
    expect(resolveRemoteBrokerConfig(base)).toMatchObject({ allowSelfSignedTls: false });
    expect(resolveRemoteBrokerConfig({ ...base, MESHCENTRAL_ALLOW_SELF_SIGNED_TLS: "true" })).toMatchObject({
      allowSelfSignedTls: true,
    });
  });
});

describe("capability to share mapping", () => {
  it("is always desktop-only with notify+toolbar consent", () => {
    for (const caps of [[], ["view"], ["control"], ["view", "control", "elevation"]] as const) {
      const params = shareParamsForCaps([...caps]);
      expect(params.p).toBe(2);
      expect(params.consent).toBe(0x41);
    }
  });

  it("sets view-only unless control or elevation was approved", () => {
    expect(shareParamsForCaps([]).viewOnly).toBe(true);
    expect(shareParamsForCaps(["view"]).viewOnly).toBe(true);
    expect(shareParamsForCaps(["view", "control"]).viewOnly).toBe(false);
    expect(shareParamsForCaps(["elevation"]).viewOnly).toBe(false);
  });
});

describe("share lifecycle", () => {
  it("creates a time-boxed desktop share and reads the binding back", async () => {
    const seen: Record<string, unknown>[] = [];
    const transport: BrokerTransport = async (_config, message) => {
      seen.push(message);
      expect(_config.controlUrl).toBe(CONFIG.controlUrl);
      return {
        action: "createDeviceShareLink",
        result: "OK",
        publicid: "share-1",
        url: "https://mesh.example.com/share/share-1",
      };
    };
    const created = await createBrokerShare(
      CONFIG,
      { nodeId: "node//abc", guestName: "support-1234-5678", viewOnly: true, minutes: 30, nowSeconds: 1_700_000_000 },
      transport,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.binding).toMatchObject({
      provider: "meshcentral",
      nodeId: "node//abc",
      shareId: "share-1",
      viewOnly: true,
    });
    expect(created.operatorUrl).toBe("https://mesh.example.com/share/share-1");
    // The exact wire shape meshctrl.js sends (verified from source).
    expect(seen[0]).toMatchObject({
      action: "createDeviceShareLink",
      nodeid: "node//abc",
      guestname: "support-1234-5678",
      p: 2,
      consent: 0x41,
      start: 1_700_000_000,
      end: 1_700_000_000 + 30 * 60,
      viewOnly: true,
    });
  });

  it("clamps share lifetime and refuses empty node/guest", async () => {
    const transport: BrokerTransport = async () => ({ result: "OK", publicid: "x", url: "https://x/y" });
    await expect(
      createBrokerShare(CONFIG, { nodeId: "", guestName: "g", viewOnly: true, minutes: 15 }, transport),
    ).resolves.toMatchObject({ ok: false, error: "provider_error" });
    await expect(
      createBrokerShare(CONFIG, { nodeId: "n", guestName: "", viewOnly: true, minutes: 15 }, transport),
    ).resolves.toMatchObject({ ok: false, error: "provider_error" });
    const created = await createBrokerShare(
      CONFIG,
      { nodeId: "n", guestName: "g", viewOnly: false, minutes: 9999, nowSeconds: 1_000 },
      transport,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // 120-minute ceiling, not the requested 9999.
    expect(created.binding.endsAt).toBe(new Date((1_000 + 120 * 60) * 1000).toISOString());
  });

  it("maps transport failures and provider rejections honestly", async () => {
    const down: BrokerTransport = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    await expect(
      createBrokerShare(CONFIG, { nodeId: "n", guestName: "g", viewOnly: true, minutes: 15 }, down),
    ).resolves.toMatchObject({ ok: false, error: "provider_unreachable" });

    const refused: BrokerTransport = async () => ({ result: "Invalid node id" });
    await expect(
      createBrokerShare(CONFIG, { nodeId: "n", guestName: "g", viewOnly: true, minutes: 15 }, refused),
    ).resolves.toMatchObject({ ok: false, error: "provider_error", detail: "Invalid node id" });

    await expect(
      createBrokerShare({ provider: "none" }, { nodeId: "n", guestName: "g", viewOnly: true, minutes: 15 }, refused),
    ).resolves.toMatchObject({ ok: false, error: "provider_not_configured" });
  });

  it("revokes by share id", async () => {
    const seen: Record<string, unknown>[] = [];
    const transport: BrokerTransport = async (_config, message) => {
      seen.push(message);
      return { action: "removeDeviceShare", result: "OK" };
    };
    await expect(
      revokeBrokerShare(CONFIG, { nodeId: "node//abc", shareId: "share-1" }, transport),
    ).resolves.toEqual({ ok: true });
    expect(seen[0]).toMatchObject({ action: "removeDeviceShare", nodeid: "node//abc", publicid: "share-1" });

    const down: BrokerTransport = async () => {
      throw new Error("meshcentral_timeout");
    };
    await expect(
      revokeBrokerShare(CONFIG, { nodeId: "node//abc", shareId: "share-1" }, down),
    ).resolves.toMatchObject({ ok: false, error: "provider_unreachable" });
  });

  it("treats an already-gone share as revoked, not failed", async () => {
    // Live shape: the second of two racing revokes reports
    // "Invalid device share identifier." — the desired end state (no live
    // share) is achieved, so this must not journal engine_revoke_failed.
    const gone: BrokerTransport = async () => ({
      action: "removeDeviceShare",
      result: "Invalid device share identifier.",
    });
    await expect(
      revokeBrokerShare(CONFIG, { nodeId: "node//abc", shareId: "share-1" }, gone),
    ).resolves.toEqual({ ok: true });
  });

  it("skips the echo and resolves on the verdict (local control channel)", async () => {
    // MeshCentral first echoes some actions back with our responseid but
    // no `result`, then sends the verdict. A local WebSocket server replays
    // the exact removeDeviceShare sequence observed live.
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.on("listening", () => resolve()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const incoming = JSON.parse(raw.toString()) as { responseid: string };
        socket.send(
          JSON.stringify({
            action: "removeDeviceShare",
            responseid: incoming.responseid,
            nodeid: "node//abc",
            publicid: "share-1",
            removed: { _id: "deviceshare-share-1" },
          }),
        );
        socket.send(
          JSON.stringify({ action: "removeDeviceShare", responseid: incoming.responseid, result: "OK" }),
        );
      });
    });
    try {
      const local: RemoteBrokerConfig = { ...CONFIG, controlUrl: `ws://127.0.0.1:${port}/control.ashx` };
      const data = await meshcentralTransport(local, {
        action: "removeDeviceShare",
        nodeid: "node//abc",
        publicid: "share-1",
      });
      expect(data).toMatchObject({ result: "OK" });
      await expect(
        revokeBrokerShare(local, { nodeId: "node//abc", shareId: "share-1" }),
      ).resolves.toEqual({ ok: true });
    } finally {
      server.close();
    }
  });
});

describe("meshcentralTransport result-less actions", () => {
  it("resolves the `nodes` answer even though it carries no `result` field", async () => {
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.on("listening", () => resolve()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const incoming = JSON.parse(raw.toString()) as { responseid: string };
        socket.send(
          JSON.stringify({
            action: "nodes",
            responseid: incoming.responseid,
            nodes: { "mesh//g": [{ _id: "node//abc", name: "shop-pc", host: "", conn: 1 }] },
          }),
        );
      });
    });
    try {
      const local: RemoteBrokerConfig = { ...CONFIG, controlUrl: `ws://127.0.0.1:${port}/control.ashx` };
      await expect(meshcentralTransport(local, { action: "nodes", meshid: "mesh//g" })).resolves.toMatchObject({
        action: "nodes",
      });
    } finally {
      server.close();
    }
  });
});

describe("node discovery", () => {
  beforeEach(() => {
    resetMeshNodesCacheForTests();
  });

  const nodesTransport: BrokerTransport = async (_broker, message) => {
    expect(message.action).toBe("nodes");
    return {
      action: "nodes",
      responseid: "r",
      nodes: {
        "mesh//g": [
          { type: "node", _id: "node//one", name: "shop-pc", host: "10.0.0.4", conn: 1 },
          { type: "node", _id: "node//two", name: "office-pc", host: "", conn: 0 },
          { type: "node", _id: "", name: "ghost" },
        ],
      },
    };
  };

  it("parses the node list, skipping entries without an id", async () => {
    await expect(listMeshNodes(CONFIG, "mesh//g", nodesTransport)).resolves.toEqual({
      ok: true,
      nodes: [
        { nodeId: "node//one", name: "shop-pc", host: "10.0.0.4", connected: true },
        { nodeId: "node//two", name: "office-pc", host: "", connected: false },
      ],
    });
  });

  it("refuses discovery without a configured mesh", async () => {
    const seen: string[] = [];
    const spy: BrokerTransport = async (_broker, message) => {
      seen.push(String(message.action));
      return nodesTransport(_broker, message);
    };
    await expect(listMeshNodes(CONFIG, "  ", spy)).resolves.toEqual({
      ok: false,
      error: "provider_not_configured",
    });
    expect(seen).toEqual([]);
  });

  it("caches the node list for a minute and never caches failures", async () => {
    let calls = 0;
    let fail = true;
    const flaky: BrokerTransport = async (broker, message) => {
      calls += 1;
      if (fail) throw new Error("dial tcp: connection refused");
      return nodesTransport(broker, message);
    };
    const first = await listMeshNodesCached(CONFIG, "mesh//g", flaky, 1_000);
    expect(first.ok).toBe(false);
    fail = false;
    const second = await listMeshNodesCached(CONFIG, "mesh//g", flaky, 2_000);
    expect(second.ok).toBe(true);
    // The failure was not cached; the success is served from cache.
    const third = await listMeshNodesCached(CONFIG, "mesh//g", flaky, 3_000);
    expect(third.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("matches hostnames case-insensitively and refuses ambiguity", () => {
    const nodes = [
      { nodeId: "node//one", name: "shop-pc", host: "", connected: true },
      { nodeId: "node//uno", name: "SHOP-pc", host: "", connected: false },
      { nodeId: "node//two", name: "office-pc", host: "", connected: true },
    ];
    expect(matchNodeByHostname(nodes, "  OFFICE-pc ")).toBe("node//two");
    expect(matchNodeByHostname(nodes, "shop-pc")).toBeNull();
    expect(matchNodeByHostname(nodes, "nope")).toBeNull();
    expect(matchNodeByHostname(nodes, "  ")).toBeNull();
  });

  it("surfaces the server's error detail when the node list is refused", async () => {
    const refused: BrokerTransport = async () => ({
      action: "nodes",
      responseid: "r",
      result: "Invalid group id",
    });
    await expect(listMeshNodes(CONFIG, "mesh//bogus", refused)).resolves.toEqual({
      ok: false,
      error: "provider_error",
      detail: "Invalid group id",
    });
  });
});

describe("agent provisioning", () => {
  const MESH = "mesh//uUch0zE23EyFEeFkpVPj2p6eovT6VGIkzBCcik5IHw@kbBrIxDax$I96SJW$TM$x";
  const TOKEN = "uUch0zE23EyFEeFkpVPj2p6eovT6VGIkzBCcik5IHw@kbBrIxDax$I96SJW$TM$x";

  it("builds the invite-page installer URL per arch, wss → https", () => {
    const control = "wss://mesh.example.com:4433/control.ashx";
    expect(agentInstallUrl(control, MESH, "x64")).toBe(
      `https://mesh.example.com:4433/meshagents?id=4&meshid=${encodeURIComponent(TOKEN)}`,
    );
    expect(agentInstallUrl(control, MESH, "x86")).toContain("/meshagents?id=3&meshid=");
    expect(agentInstallUrl(control, MESH, "arm64")).toContain("/meshagents?id=43&meshid=");
    // Bare tokens (no mesh/ prefix) pass through.
    expect(agentInstallUrl(control, TOKEN)).toContain(`meshid=${encodeURIComponent(TOKEN)}`);
  });

  it("keeps a subpath prefix and maps ws → http", () => {
    expect(agentInstallUrl("ws://127.0.0.1:8080/sub/control.ashx", MESH)).toContain(
      "http://127.0.0.1:8080/sub/meshagents?id=4&",
    );
  });

  it("returns null when provisioning is not configured", () => {
    expect(agentInstallUrl("wss://mesh.example.com/control.ashx", "  ")).toBeNull();
    expect(agentInstallUrl("not a url", MESH)).toBeNull();
    expect(agentInstallUrl("https://mesh.example.com/control.ashx", MESH)).toBeNull();
  });

  it("maps architecture names with an x64 fallback", () => {
    expect(agentArchFromName("x64")).toBe("x64");
    expect(agentArchFromName("X86")).toBe("x86");
    expect(agentArchFromName("arm64")).toBe("arm64");
    expect(agentArchFromName("weird")).toBe("x64");
    expect(agentArchFromName(null)).toBe("x64");
  });
});
