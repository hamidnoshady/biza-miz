import { describe, expect, it } from "vitest";
import {
  assessCronProbe,
  cronProbeOffered,
  CRON_PROBE_EXPIRY_SECONDS,
  CRON_PROBE_ID_PATTERN,
  readCronProbeReport,
} from "./plugin-cron-probe";

const NOW = new Date("2026-11-02T12:00:00Z");
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000).toISOString();
const ID = "0123456789abcdef0123456789abcdef";

describe("probe ids (issue #1206 P0)", () => {
  it("is 32 lowercase hex, the one shape both sides accept", () => {
    expect(CRON_PROBE_ID_PATTERN.test(ID)).toBe(true);
    expect(CRON_PROBE_ID_PATTERN.test(ID.toUpperCase())).toBe(false);
    expect(CRON_PROBE_ID_PATTERN.test(ID.slice(0, 31))).toBe(false);
    expect(CRON_PROBE_ID_PATTERN.test(`${ID}\n`)).toBe(false);
    // Mirrors POS_Connector_Health::probe_id_is_valid() on the plugin side.
    expect(CRON_PROBE_EXPIRY_SECONDS).toBe(600);
  });
});

describe("readCronProbeReport", () => {
  it("accepts the plugin's snake_case fields too, and empty stages as absent", () => {
    expect(
      readCronProbeReport({
        id: ID,
        origin: "app",
        queued_at: "2026-11-02T11:59:00Z",
        executed_at: "2026-11-02T11:59:05Z",
        reported_at: "",
        error: "",
      }),
    ).toEqual({
      id: ID,
      origin: "app",
      queuedAt: "2026-11-02T11:59:00Z",
      executedAt: "2026-11-02T11:59:05Z",
      reportedAt: null,
      error: null,
    });
  });

  it("is null when there is no id — never a probe with an empty name", () => {
    expect(readCronProbeReport(null)).toBeNull();
    expect(readCronProbeReport({})).toBeNull();
    expect(readCronProbeReport({ id: "  " })).toBeNull();
  });
});

describe("assessCronProbe (issue #1206 P0)", () => {
  const assess = (input: Parameters<typeof assessCronProbe>[0]) => assessCronProbe(input, NOW);

  it("separates «never tested» from «tested and queued»", () => {
    expect(assess({ supported: true }).stage).toBe("never");
    expect(assess({ supported: true, report: { id: ID, queuedAt: ago(5) } }).stage).toBe("queued");
  });

  it("asks for nothing from a plugin that cannot run a probe", () => {
    const result = assess({ supported: false, report: null });
    expect(result.stage).toBe("unsupported");
    expect(result.reason).toBe("plugin_cannot_run_probe");
  });

  it("never calls a queued probe a success — a scheduled event is not an executed one", () => {
    const result = assess({ supported: true, report: { id: ID, origin: "admin", queuedAt: ago(10) } });
    expect(result.stage).toBe("queued");
    expect(result.reason).toBe("awaiting_scheduler");
    expect(result.expiresInSeconds).toBe(590);
  });

  it("calls the separate invocation running it the evidence", () => {
    const result = assess({
      supported: true,
      report: { id: ID, origin: "admin", queuedAt: ago(10), executedAt: ago(5) },
    });
    expect(result.stage).toBe("executed");
    expect(result.reason).toBe("scheduler_ran_it");
  });

  it("calls signed telemetry the end of the line", () => {
    const result = assess({
      supported: true,
      report: { id: ID, origin: "app", queuedAt: ago(20), executedAt: ago(15), reportedAt: ago(14) },
    });
    expect(result.stage).toBe("reported");
    expect(result.reason).toBe("telemetry_received");
  });

  it("names the finding: queued and never executed inside the grace window", () => {
    const result = assess({ supported: true, report: { id: ID, queuedAt: ago(601) } });
    expect(result.stage).toBe("expired");
    expect(result.reason).toBe("queued_but_never_executed");
    expect(result.expiresInSeconds).toBe(0);
  });

  it("does not confuse «ran but could not report» with «never ran»", () => {
    const result = assess({
      supported: true,
      report: { id: ID, queuedAt: ago(30), executedAt: ago(25), error: "report_failed:http_500" },
    });
    expect(result.stage).toBe("failed");
    expect(result.reason).toBe("report_failed:http_500");
  });

  it("shows the app's own request while the plugin has reported nothing", () => {
    const result = assess({
      supported: true,
      report: null,
      request: { probeId: ID, requestedAt: ago(30) },
    });
    expect(result.stage).toBe("requested");
    expect(result.reason).toBe("requested_by_app");
    expect(result.probeId).toBe(ID);
    expect(result.origin).toBe("app");
  });

  it("keeps the plugin's report even when the app asked for a different probe", () => {
    // The plugin's own button probe is real evidence too; it is simply not
    // evidence about *this* request, which is why both ids travel.
    const result = assess({
      supported: true,
      report: { id: "f".repeat(32), origin: "admin", queuedAt: ago(10), executedAt: ago(5) },
      request: { probeId: ID, requestedAt: ago(60) },
    });
    expect(result.stage).toBe("executed");
    expect(result.probeId).toBe("f".repeat(32));
    expect(result.origin).toBe("admin");
  });
});

describe("cronProbeOffered (issue #1206 P0)", () => {
  it("is offered only when the plugin advertised the job type", () => {
    expect(cronProbeOffered({ link_mode: "plugin", capabilities: { jobTypes: ["stock", "cron_probe"] } })).toBe(true);
  });

  it("is not offered to an older plugin, whose legacy list has no probe", () => {
    expect(cronProbeOffered({ link_mode: "plugin", capabilities: { jobTypes: ["stock", "price"] } })).toBe(false);
    expect(cronProbeOffered({ link_mode: "plugin", capabilities: null })).toBe(false);
  });

  it("is not offered in REST mode, where there is no scheduler of the store's to test", () => {
    expect(cronProbeOffered({ link_mode: "rest", capabilities: { jobTypes: ["cron_probe"] } })).toBe(false);
  });
});
