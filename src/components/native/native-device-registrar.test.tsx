// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NO_BROWSER_FEATURES } from "@/lib/native/capability";
import { INITIAL_NATIVE_SNAPSHOT, type NativeRuntimeSnapshot } from "@/lib/native/native-runtime";
import { NativeDeviceRegistrar } from "./native-device-registrar";
import { NativeValueProvider, buildNativeContextValue, type NativeRequest } from "./native-provider";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CONNECTED_SNAPSHOT: NativeRuntimeSnapshot = {
  kind: "android-twa",
  connection: "connected",
  androidPackage: "com.bizamiz.app",
  environment: "production",
  app: {
    appVersionName: "0.1.0",
    appVersionCode: 4,
    environment: "production",
    bridgeVersion: 2,
    capabilities: ["notifications"],
  },
};

describe("NativeDeviceRegistrar", () => {
  it("never calls the bridge or the network outside a connected channel", () => {
    const request = vi.fn() as unknown as NativeRequest;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <NativeValueProvider value={buildNativeContextValue(INITIAL_NATIVE_SNAPSHOT, NO_BROWSER_FEATURES, request)}>
        <NativeDeviceRegistrar />
      </NativeValueProvider>,
    );
    expect(request).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks for the installation identity and registers it once the channel connects", async () => {
    const request = vi.fn(async (command: string) => {
      expect(command).toBe("device.identity");
      return { installationId: "a1b2c3d4e5f6" };
    }) as unknown as NativeRequest;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ device: {} }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <NativeValueProvider value={buildNativeContextValue(CONNECTED_SNAPSHOT, NO_BROWSER_FEATURES, request)}>
        <NativeDeviceRegistrar />
      </NativeValueProvider>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(request).toHaveBeenCalledWith("device.identity");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/native-devices");
    expect(JSON.parse(init!.body as string)).toEqual({
      installationId: "a1b2c3d4e5f6",
      environment: "production",
      appVersionName: "0.1.0",
      appVersionCode: 4,
      bridgeVersion: 2,
    });
  });

  it("never throws when the app is too old for device.identity", async () => {
    const request = vi.fn(async () => {
      throw new Error("bridge_version_too_old");
    }) as unknown as NativeRequest;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <NativeValueProvider value={buildNativeContextValue(CONNECTED_SNAPSHOT, NO_BROWSER_FEATURES, request)}>
        <NativeDeviceRegistrar />
      </NativeValueProvider>,
    );

    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws when registration itself fails (offline, 409 device_revoked, ...)", async () => {
    const request = vi.fn(async () => ({ installationId: "a1b2c3d4e5f6" })) as unknown as NativeRequest;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <NativeValueProvider value={buildNativeContextValue(CONNECTED_SNAPSHOT, NO_BROWSER_FEATURES, request)}>
        <NativeDeviceRegistrar />
      </NativeValueProvider>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});
