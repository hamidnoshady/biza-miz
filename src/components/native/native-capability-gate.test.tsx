// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NO_BROWSER_FEATURES, type BrowserFeatures } from "@/lib/native/capability";
import { INITIAL_NATIVE_SNAPSHOT, type NativeRuntimeSnapshot } from "@/lib/native/native-runtime";
import { NativeCapabilityGate } from "./native-capability-gate";
import { NativeProvider, NativeValueProvider, buildNativeContextValue, useNative } from "./native-provider";

afterEach(() => {
  cleanup();
});

const TWA_SNAPSHOT: NativeRuntimeSnapshot = {
  ...INITIAL_NATIVE_SNAPSHOT,
  kind: "android-twa",
  connection: "connected",
  androidPackage: "com.bizamiz.app",
  environment: "production",
};

function withState(snapshot: NativeRuntimeSnapshot, browser: BrowserFeatures = NO_BROWSER_FEATURES) {
  return buildNativeContextValue(snapshot, browser);
}

describe("NativeCapabilityGate", () => {
  it("shows the fallback, not the feature, in a plain browser", () => {
    render(
      <NativeCapabilityGate capability="barcode.scan" fallback={<p>fallback-text</p>}>
        <p>scanner-text</p>
      </NativeCapabilityGate>,
    );
    expect(screen.getByText("fallback-text")).toBeTruthy();
    expect(screen.queryByText("scanner-text")).toBeNull();
  });

  it("shows the feature when the browser provides it", () => {
    const value = withState(INITIAL_NATIVE_SNAPSHOT, { ...NO_BROWSER_FEATURES, barcodeDetector: true });
    render(
      <NativeValueProvider value={value}>
        <NativeCapabilityGate capability="barcode.scan" fallback={<p>fallback-text</p>}>
          <p>scanner-text</p>
        </NativeCapabilityGate>
      </NativeValueProvider>,
    );
    expect(screen.getByText("scanner-text")).toBeTruthy();
    expect(screen.queryByText("fallback-text")).toBeNull();
  });

  it("shows the feature when an up-to-date app provides it natively", () => {
    const value = withState({
      ...TWA_SNAPSHOT,
      app: {
        appVersionName: "1.0.0",
        appVersionCode: 5,
        environment: "production",
        bridgeVersion: 2,
        capabilities: ["printer"],
      },
    });
    render(
      <NativeValueProvider value={value}>
        <NativeCapabilityGate capability="printer" fallback={<p>fallback-text</p>}>
          <p>printer-text</p>
        </NativeCapabilityGate>
      </NativeValueProvider>,
    );
    expect(screen.getByText("printer-text")).toBeTruthy();
  });

  it("asks the user to update the app when the installed app is too old for the capability", () => {
    const value = withState({
      ...TWA_SNAPSHOT,
      app: {
        appVersionName: "0.9.0",
        appVersionCode: 4,
        environment: "production",
        bridgeVersion: 1,
        capabilities: ["notifications"],
      },
    });
    render(
      <NativeValueProvider value={value}>
        <NativeCapabilityGate capability="printer" fallback={<p>fallback-text</p>} updateRequired={<p>update-text</p>}>
          <p>printer-text</p>
        </NativeCapabilityGate>
      </NativeValueProvider>,
    );
    expect(screen.getByText("update-text")).toBeTruthy();
    expect(screen.queryByText("fallback-text")).toBeNull();
  });
});

describe("NativeProvider", () => {
  function Probe() {
    const native = useNative();
    return <p>{`probe:${native.kind}:${native.connection}`}</p>;
  }

  it("reports the plain web state on first render and after mounting in a non-TWA browser", () => {
    render(
      <NativeProvider>
        <Probe />
      </NativeProvider>,
    );
    expect(screen.getByText("probe:web:idle")).toBeTruthy();
  });
});
