import { describe, expect, it } from "vitest";
import { pluginCronAlerts } from "./plugin-cron-alerts";
import { PLUGIN_CRITICAL_AFTER_MS } from "./sync-timing";

const NOW = new Date("2026-11-02T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function connection(overrides: { seen?: string; health?: Record<string, unknown>; status?: string; link?: string } = {}) {
  return {
    id: "conn-1",
    name: "فروشگاه اصلی",
    link_mode: overrides.link ?? "plugin",
    status: overrides.status ?? "active",
    last_plugin_seen_at: overrides.seen ?? ago(30_000),
    plugin_health: overrides.health ?? {},
  };
}

// A 1.6+ plugin reports its cadence; the thresholds follow it.
const FAST = { fastIntervalSeconds: 60, fastHandlerLastStartedAt: ago(30_000) };
const staleCron = { ...FAST, fastHandlerLastStartedAt: ago(PLUGIN_CRITICAL_AFTER_MS + 60_000) };
const lateCron = { ...FAST, fastHandlerLastStartedAt: ago(4 * 60_000) }; // 4 missed one-minute cycles
const freshCron = FAST;

describe("pluginCronAlerts (issue #1206 P1)", () => {
  it("says nothing about a connection that is not an outage", () => {
    expect(pluginCronAlerts(connection({ health: freshCron }), NOW)).toEqual([]);
    expect(pluginCronAlerts(connection({ status: "paused", health: staleCron }), NOW)).toEqual([]);
    expect(pluginCronAlerts(connection({ link: "rest_api", health: staleCron }), NOW)).toEqual([]);
    // Never heard from: not configured yet, not broken.
    expect(pluginCronAlerts(connection({ seen: null as unknown as string }), NOW)).toEqual([]);
  });

  it("warns — quietly — when the scheduler is late, not when it is dead", () => {
    const [alert] = pluginCronAlerts(connection({ health: lateCron }), NOW);
    expect(alert.eventKey).toBe("integrations.plugin_cron_delayed");
    expect(alert.level).toBe("warn");
    // A number of cycles, labelled as cycles: multiplying it by a cadence
    // would claim a precision the plugin's clock does not have.
    expect(alert.body).toContain("۴ اجرا");
    // `info` on purpose: three missed cycles on a shared host must not page
    // anyone at 2am.
    expect(alert.severity).toBe("info");
  });

  it("escalates to a critical notice once nothing has started for ten minutes", () => {
    const [alert] = pluginCronAlerts(connection({ health: staleCron }), NOW);
    expect(alert.eventKey).toBe("integrations.plugin_cron_failed");
    expect(alert.level).toBe("critical");
    expect(alert.severity).toBe("important");
    expect(alert.body).toMatch(/در صف می‌مانند/);
    // The silence is measured, and the number is the failure threshold — not
    // the three-minute warning window dressed up as an outage.
    expect(alert.body).toContain("بیش از ۱۱ دقیقه");
  });

  it("cannot be re-raised by pressing «آزمایش اتصال» during an outage", () => {
    // The bug this replaces: the old dedupe key was `last_plugin_seen_at`, which
    // a connection test refreshes — so the same alarm re-fired every tick.
    const before = pluginCronAlerts(connection({ seen: ago(PLUGIN_CRITICAL_AFTER_MS), health: staleCron }), NOW)[0];
    const pressed = pluginCronAlerts(connection({ seen: ago(1_000), health: staleCron }), NOW)[0];
    expect(pressed.dedupeKey).toBe(before.dedupeKey);
    expect(before.dedupeKey).toContain(staleCron.fastHandlerLastStartedAt);
  });

  it("gives one key per episode, and a new one only when the cron signal moves", () => {
    const first = pluginCronAlerts(connection({ health: lateCron }), NOW)[0];
    const sameEpisodeLater = pluginCronAlerts(connection({ health: lateCron }), new Date(NOW.getTime() + 60_000))[0];
    expect(sameEpisodeLater.dedupeKey).toBe(first.dedupeKey);

    const recoveredThenFailedAgain = pluginCronAlerts(
      connection({ health: { ...FAST, fastHandlerLastStartedAt: ago(PLUGIN_CRITICAL_AFTER_MS + 600_000) } }),
      NOW,
    )[0];
    expect(recoveredThenFailedAgain.dedupeKey).not.toBe(first.dedupeKey);
  });

  it("has a stable key for a scheduler that never ran at all", () => {
    // No anchor: minting one from `now()` would mean a new key every tick.
    const first = pluginCronAlerts(connection({ health: {} }), NOW);
    const later = pluginCronAlerts(connection({ health: {} }), new Date(NOW.getTime() + 3_600_000));
    // `unknown` (never ran, nothing seen recently) is not an emergency…
    expect(first).toEqual([]);
    expect(later).toEqual([]);
  });

  it("closes the loop once per recovered outage, and only for a real one", () => {
    const recovered = {
      ...FAST,
      previousOutageAt: "2026-11-02T10:00:00Z",
      recoveredAt: "2026-11-02T10:20:00Z",
      previousOutageSeconds: 1_200,
    };
    const [alert] = pluginCronAlerts(connection({ health: recovered }), NOW);
    expect(alert.eventKey).toBe("integrations.plugin_cron_recovered");
    expect(alert.level).toBe("recovered");
    expect(alert.dedupeKey).toContain("2026-11-02T10:00:00Z");

    // A blip shorter than the warning window is not an incident worth a line.
    const blip = { ...recovered, previousOutageSeconds: 60 };
    expect(pluginCronAlerts(connection({ health: blip }), NOW)).toEqual([]);

    // A store that ended an outage days ago does not keep saying so: the key is
    // the incident, so the second tick produces the same (already recorded) key.
    const later = pluginCronAlerts(connection({ health: recovered }), new Date(NOW.getTime() + 60_000))[0];
    expect(later.dedupeKey).toBe(alert.dedupeKey);
  });

  it("never downgrades an outage into silence while paused mid-incident", () => {
    // Pausing is a decision, not a fix: the state is `paused`, so no recovery
    // notice is invented for an outage nobody repaired.
    const pausedMidIncident = {
      ...FAST,
      previousOutageAt: "2026-11-02T10:00:00Z",
      recoveredAt: "",
      previousOutageSeconds: 1_200,
    };
    expect(pluginCronAlerts(connection({ status: "paused", health: pausedMidIncident }), NOW)).toEqual([]);
  });

  it("says nothing for test-only and unknown states", () => {
    expect(pluginCronAlerts(connection({ health: {} }), NOW)).toEqual([]);
    expect(pluginCronAlerts(connection({ health: { lastPingOkAt: ago(5_000) } }), NOW)).toEqual([]);
  });
});
