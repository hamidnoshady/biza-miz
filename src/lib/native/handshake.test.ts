import { describe, expect, it } from "vitest";
import { acceptNativeChannel } from "./handshake";

const PAGE = "https://app.example.test";
const APP_INFO = {
  appVersionName: "1.0.0",
  appVersionCode: 1,
  environment: "production",
  bridgeVersion: 1,
  capabilities: [],
};
const READY = JSON.stringify({ v: 1, kind: "event", name: "bridge.ready", payload: APP_INFO });
const PORT = { name: "port-a" };

describe("acceptNativeChannel", () => {
  it("accepts the first port from a message posted by this page's own origin", () => {
    const accepted = acceptNativeChannel({ origin: PAGE, data: READY, ports: [PORT] }, PAGE);
    expect(accepted).toEqual({ port: PORT, ready: APP_INFO });
  });

  it("refuses a port from any other origin, even one that looks similar", () => {
    for (const origin of ["https://evil.example", "https://app.example.test.evil.example", "http://app.example.test"]) {
      expect(acceptNativeChannel({ origin, data: READY, ports: [PORT] }, PAGE)).toBeNull();
    }
  });

  it("ignores a message that carries no port", () => {
    expect(acceptNativeChannel({ origin: PAGE, data: READY, ports: [] }, PAGE)).toBeNull();
  });

  it("ignores a message whose port slot is empty", () => {
    expect(acceptNativeChannel({ origin: PAGE, data: READY, ports: [null as never] }, PAGE)).toBeNull();
  });

  it("accepts the channel with no bridge.ready when the first frame is something else", () => {
    const accepted = acceptNativeChannel({ origin: PAGE, data: "not json", ports: [PORT] }, PAGE);
    expect(accepted).toEqual({ port: PORT, ready: null });
  });

  it("does not treat a malformed bridge.ready as a valid announcement", () => {
    const bad = JSON.stringify({ v: 1, kind: "event", name: "bridge.ready", payload: { appVersionName: "" } });
    expect(acceptNativeChannel({ origin: PAGE, data: bad, ports: [PORT] }, PAGE)?.ready).toBeNull();
  });

  it("reads an announcement that arrives as an object rather than a string", () => {
    const data = { v: 1, kind: "event", name: "bridge.ready", payload: APP_INFO };
    expect(acceptNativeChannel({ origin: PAGE, data, ports: [PORT] }, PAGE)?.ready).toEqual(APP_INFO);
  });
});
