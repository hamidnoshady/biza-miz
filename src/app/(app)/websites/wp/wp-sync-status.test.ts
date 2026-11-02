/**
 * Issue #944 — the overview's pure rules: sync replies classified honestly
 * (OVR-04), buttons live only where the API would say yes (OVR-08), transport
 * health named apart from configured status (OVR-07), stores named by
 * name + domain (OVR-09), and the store-list failure copy (OVR-02).
 */
import { describe, expect, it } from "vitest";
import {
  classifySyncResponse,
  describeSyncOutcome,
  PLUGIN_PULL_INTERVAL_MS,
  pluginPullIntervalMs,
  queuedPollPlan,
  storeDisplayName,
  syncAvailability,
  transportHealthPresentation,
  waitMinutesLabel,
} from "./wp-sync-status";
import { describeStoreLoadFailure } from "./wp-store-states";
import { resolveSelection, storageKeyFor } from "./wp-store-context";
import { connectionOptionLabel } from "./connection-lite";
import { describeCallSuccess } from "./store-section-host";

const allow = () => true;
const deny = () => false;

const restStore = {
  status: "active" as const,
  linkMode: "rest_api" as const,
  syncProducts: true,
  syncOrders: true,
  syncCustomers: true,
  pluginCapabilities: null,
};

describe("classifySyncResponse", () => {
  it("REST full success is completed, with counts", () => {
    const outcome = classifySyncResponse({ ok: true, status: 200, data: { ok: true, result: "completed", created: 2, updated: 3 } });
    expect(outcome).toEqual({ kind: "completed", counts: { created: 2, updated: 3 } });
    expect(describeSyncOutcome("products", outcome).message).toContain("انجام شد");
  });

  it("plugin queued is queued, not done", () => {
    const outcome = classifySyncResponse({ ok: true, status: 200, data: { ok: true, queued: true } });
    expect(outcome.kind).toBe("queued");
    const text = describeSyncOutcome("orders", outcome);
    expect(text.message).toContain("در صف");
    expect(text.message).not.toContain("انجام شد");
  });

  it("a queued reply carries its job ids and names the substep an older plugin cannot apply", () => {
    const outcome = classifySyncResponse({
      ok: true,
      status: 200,
      data: { ok: true, queued: true, result: "queued", jobIds: ["j1", "j2"], skippedSteps: [{ step: "content", reason: "plugin_job_unsupported" }] },
    });
    expect(outcome).toEqual({ kind: "queued", jobIds: ["j1", "j2"], skippedSteps: [{ step: "content", reason: "plugin_job_unsupported" }] });
    const text = describeSyncOutcome("products", outcome);
    expect(text.tone).toBe("warn");
    expect(text.message).toContain("۲ کار");
    expect(text.message).toContain("محتوای وردپرس");
    expect(text.message).toContain("افزونه را به‌روز کنید");
  });

  it("HTTP 200 with contentError is partial — never «انجام شد» — and offers the content sync alone", () => {
    const outcome = classifySyncResponse({
      ok: true,
      status: 200,
      data: { ok: true, created: 1, updated: 0, contentError: "HTTP 401 on /wp-json/wp/v2/posts" },
    });
    expect(outcome.kind).toBe("partial");
    const text = describeSyncOutcome("products", outcome);
    expect(text.tone).toBe("warn");
    expect(text.message).toContain("ناقص");
    expect(text.message).toContain("محتوای وردپرس");
    expect(text.message).not.toMatch(/(?<!ناقص )انجام شد\./);
    expect(text.retryKind).toBe("content");
  });

  it("the structured `result: partial` + failedSteps shape is read the same way", () => {
    const outcome = classifySyncResponse({
      ok: true,
      status: 200,
      data: { ok: true, result: "partial", failedSteps: [{ step: "content", error: "fetch failed" }] },
    });
    expect(outcome.kind).toBe("partial");
    if (outcome.kind === "partial") expect(outcome.failedSteps).toEqual([{ step: "content", error: "fetch failed" }]);
  });

  it("a 409 for a disabled or paused sync is failed with the mapped sentence", () => {
    const disabled = classifySyncResponse({ ok: false, status: 409, data: { ok: false, error: "sync_products_disabled" } });
    expect(disabled.kind).toBe("failed");
    if (disabled.kind === "failed") expect(disabled.message).toContain("غیرفعال");
    const paused = classifySyncResponse({ ok: false, status: 409, data: { ok: false, error: "connection_paused" } });
    if (paused.kind === "failed") expect(paused.message).toContain("توقف");
    const unsupported = classifySyncResponse({ ok: false, status: 409, data: { ok: false, error: "plugin_job_unsupported" } });
    if (unsupported.kind === "failed") expect(unsupported.message).toContain("افزونه");
  });

  it("403, offline and 5xx are told apart", () => {
    const forbidden = classifySyncResponse({ ok: false, status: 403, data: { error: "forbidden" } });
    if (forbidden.kind === "failed") expect(forbidden.message).toContain("مجوز");
    const offline = classifySyncResponse({ ok: false, status: 0, data: {} });
    if (offline.kind === "failed") expect(offline.message).toContain("اینترنت");
    const gateway = classifySyncResponse({ ok: false, status: 502, data: { ok: false, error: "ETIMEDOUT" } });
    if (gateway.kind === "failed") expect(gateway.message.length).toBeGreaterThan(0);
  });
});

describe("syncAvailability", () => {
  it("is live for an active REST store with the sync ability", () => {
    for (const kind of ["products", "orders", "customers", "content"] as const) {
      expect(syncAvailability(restStore, allow, kind)).toEqual({ enabled: true });
    }
  });

  it("is off, with a reason, without the sync ability", () => {
    const result = syncAvailability(restStore, deny, "products");
    expect(result.enabled).toBe(false);
    expect(result.reason).toContain("همگام‌سازی ووکامرس");
  });

  it("honours the per-connection flags and the paused state", () => {
    expect(syncAvailability({ ...restStore, syncOrders: false }, allow, "orders").enabled).toBe(false);
    expect(syncAvailability({ ...restStore, syncOrders: false }, allow, "products").enabled).toBe(true);
    expect(syncAvailability({ ...restStore, syncCustomers: false }, allow, "customers").reason).toContain("غیرفعال");
    expect(syncAvailability({ ...restStore, status: "paused" }, allow, "content").reason).toContain("توقف");
  });

  it("honours what the plugin advertised: a legacy plugin cannot sync content", () => {
    const legacyPlugin = { ...restStore, linkMode: "plugin" as const, pluginCapabilities: null };
    expect(syncAvailability(legacyPlugin, allow, "products").enabled).toBe(true);
    const content = syncAvailability(legacyPlugin, allow, "content");
    expect(content.enabled).toBe(false);
    expect(content.reason).toContain("افزونه");
    const modern = { ...legacyPlugin, pluginCapabilities: { jobTypes: ["catalogue_export", "content_export"] } };
    expect(syncAvailability(modern, allow, "content").enabled).toBe(true);
    expect(syncAvailability(modern, allow, "orders").enabled).toBe(false);
  });

  it("is off with no store selected", () => {
    expect(syncAvailability(null, allow, "products").enabled).toBe(false);
  });
});

describe("transportHealthPresentation", () => {
  it("an active-but-stale plugin store is not shown as healthy", () => {
    const health = transportHealthPresentation({
      linkMode: "plugin",
      status: "active",
      lastSyncAt: "2026-01-01T00:00:00Z",
      transportHealth: { state: "stale", lastSeenAt: "2026-01-01T00:00:00Z" },
    });
    expect(health.tone).toBe("danger");
    expect(health.label).toContain("بی‌پاسخ");
    expect(health.explanation).toContain("صف");
  });

  it("never_connected, site_mismatch and paused each explain the queue's behaviour", () => {
    for (const state of ["never_connected", "site_mismatch", "paused"]) {
      const health = transportHealthPresentation({ linkMode: "plugin", status: "active", lastSyncAt: null, transportHealth: { state, lastSeenAt: null } });
      expect(health.explanation, state).toBeTruthy();
      expect(health.tone, state).not.toBe("positive");
    }
  });

  it("a REST store is only 'configured' until a sync has succeeded", () => {
    const untested = transportHealthPresentation({ linkMode: "rest_api", status: "active", lastSyncAt: null, transportHealth: { state: "healthy", lastSeenAt: null } });
    expect(untested.tone).toBe("neutral");
    expect(untested.label).toContain("آزمایش‌نشده");
    const verified = transportHealthPresentation({ linkMode: "rest_api", status: "active", lastSyncAt: "2026-01-01T00:00:00Z", transportHealth: { state: "healthy", lastSeenAt: null } });
    expect(verified.tone).toBe("positive");
  });
});

describe("store naming", () => {
  it("adds the domain so two stores that share a name are told apart", () => {
    expect(storeDisplayName({ name: "فروشگاه", baseUrl: "https://shop-a.example.com/" })).toBe("فروشگاه — shop-a.example.com");
    expect(storeDisplayName({ name: "فروشگاه", baseUrl: "https://shop-b.example.com/wp" })).toBe("فروشگاه — shop-b.example.com");
    expect(storeDisplayName({ name: "shop.example.com", baseUrl: "https://shop.example.com" })).toBe("shop.example.com");
    expect(storeDisplayName({ name: "بدون آدرس", baseUrl: undefined })).toBe("بدون آدرس");
    expect(connectionOptionLabel({ id: "1", name: "فروشگاه", linkMode: "plugin", baseUrl: "https://a.example.com" })).toBe(
      "فروشگاه — a.example.com (افزونهٔ وردپرس)",
    );
  });
});

describe("resolveSelection precedence", () => {
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
  it("the member's own pick outranks the URL, which outranks the remembered store, which outranks the first", () => {
    expect(resolveSelection(list, { chosen: "c", query: "b", remembered: "a" })).toBe("c");
    expect(resolveSelection(list, { chosen: "", query: "b", remembered: "a" })).toBe("b");
    expect(resolveSelection(list, { chosen: "", query: "", remembered: "a" })).toBe("a");
    expect(resolveSelection(list, { chosen: "", query: "", remembered: "" })).toBe("a");
  });
  it("skips candidates that no longer exist (a deleted store, another business's remembered id)", () => {
    expect(resolveSelection(list, { chosen: "gone", query: "also-gone", remembered: "b" })).toBe("b");
    expect(resolveSelection(list, { chosen: "gone", query: "", remembered: "other-biz" })).toBe("a");
    expect(resolveSelection([], { chosen: "a", query: "a", remembered: "a" })).toBe("");
  });
  it("remembers the selection per business", () => {
    expect(storageKeyFor("biz-1")).not.toBe(storageKeyFor("biz-2"));
    expect(storageKeyFor("biz-1")).toContain("wp-manager:selected-connection");
  });
});

describe("store-list failure copy", () => {
  it("distinguishes signed-out, forbidden, feature-locked, offline and server errors", () => {
    expect(describeStoreLoadFailure({ status: 401, code: "unauthorized" }).signedOut).toBe(true);
    expect(describeStoreLoadFailure({ status: 403, code: "forbidden" }).title).toContain("دسترسی");
    expect(describeStoreLoadFailure({ status: 403, code: "feature_disabled" }).title).toContain("فعال نیست");
    expect(describeStoreLoadFailure({ status: 0, code: "" }).title).toContain("ارتباط");
    expect(describeStoreLoadFailure({ status: 500, code: "" }).detail).toContain("۵۰۰");
    expect(describeStoreLoadFailure({ status: 502, code: "invalid_connections_response" }).title).toContain("معتبر");
    for (const failure of [{ status: 403, code: "forbidden" }, { status: 0, code: "" }, { status: 500, code: "" }]) {
      const text = describeStoreLoadFailure(failure);
      expect(`${text.title} ${text.detail}`).not.toContain("هنوز فروشگاهی متصل نیست");
    }
  });
});

describe("describeCallSuccess", () => {
  it("says queued, done or partial from the response rather than always «در صف»", () => {
    expect(describeCallSuccess({ queued: true })).toContain("در صف");
    expect(describeCallSuccess({ result: "queued" })).toContain("در صف");
    expect(describeCallSuccess({ ok: true, updated: 1 })).toBe("عملیات انجام شد.");
    expect(describeCallSuccess({ ok: true, contentError: "x" })).toContain("ناقص");
    expect(describeCallSuccess(null)).toBe("عملیات انجام شد.");
  });
});

describe("queuedPollPlan (OVR-06)", () => {
  const now = Date.parse("2026-10-27T10:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const healthy = (seenMsAgo: number | null, caps: Record<string, unknown> | null = null) => ({
    pluginCapabilities: caps,
    lastPluginSeenAt: seenMsAgo === null ? null : ago(seenMsAgo),
    transportHealth: { state: "healthy", lastSeenAt: seenMsAgo === null ? null : ago(seenMsAgo) },
  });

  it("defaults to the plugin's five-minute fast lane and gives up after three missed pulls", () => {
    expect(pluginPullIntervalMs(null)).toBe(PLUGIN_PULL_INTERVAL_MS);
    const plan = queuedPollPlan(healthy(60_000), now);
    expect(plan.intervalMs).toBe(300_000);
    expect(plan.maxWaitMs).toBe(15 * 60_000);
  });

  it("aims at the next expected pull instead of polling every minute", () => {
    // Seen 60 s ago → next pull in ~240 s, plus the apply grace.
    expect(queuedPollPlan(healthy(60_000), now).delayMs).toBe(240_000 + 20_000);
    // Seen 4 min ago → the pull is imminent; look just after it.
    expect(queuedPollPlan(healthy(240_000), now).delayMs).toBe(60_000 + 20_000);
  });

  it("looks more often when the plugin is overdue or has no heartbeat yet", () => {
    expect(queuedPollPlan(healthy(10 * 60_000), now).delayMs).toBe(30_000);
    expect(queuedPollPlan(healthy(null), now).delayMs).toBe(30_000);
  });

  it("never schedules a look sooner than the floor", () => {
    // Expected pull + grace is 1 s away.
    expect(queuedPollPlan(healthy(300_000 + 20_000 - 1_000), now).delayMs).toBe(15_000);
  });

  it("waits a whole interval when the plugin cannot pull at all", () => {
    for (const state of ["stale", "never_connected", "site_mismatch", "paused", "error"]) {
      const plan = queuedPollPlan({ pluginCapabilities: null, lastPluginSeenAt: ago(1_000), transportHealth: { state, lastSeenAt: ago(1_000) } }, now);
      expect(plan.delayMs).toBe(300_000);
    }
  });

  it("follows a cadence the plugin advertised, clamped and never trusted blindly", () => {
    expect(pluginPullIntervalMs({ pullIntervalSeconds: 900 })).toBe(900_000);
    expect(queuedPollPlan(healthy(60_000, { pullIntervalSeconds: 900 }), now).maxWaitMs).toBe(45 * 60_000);
    expect(pluginPullIntervalMs({ pullIntervalSeconds: 1 })).toBe(60_000);
    expect(pluginPullIntervalMs({ pullIntervalSeconds: 10 ** 9 })).toBe(3_600_000);
    for (const junk of ["300", -5, 0, Number.NaN, null, {}]) {
      expect(pluginPullIntervalMs({ pullIntervalSeconds: junk })).toBe(PLUGIN_PULL_INTERVAL_MS);
    }
  });

  it("states the give-up window in minutes from the plan itself", () => {
    expect(waitMinutesLabel(15 * 60_000)).toContain("۱۵");
    expect(waitMinutesLabel(45 * 60_000)).toContain("۴۵");
  });
});
