"use client";

/**
 * Exposes the native-runtime state to the React tree (issue #884).
 *
 * Mounted once in the root layout. On the server and on the first client render
 * it reports the plain-web state, so hydration always matches. The TWA detection
 * and the handshake run in an effect, after mount.
 *
 * UI code should branch on a capability through `useNative().capabilities` or
 * `<NativeCapabilityGate>`, never on the Android user agent or the referrer.
 */
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { NativeAppInfo, NativeCapability, NativeEnvironment } from "@/lib/native/bridge-contract";
import {
  NO_BROWSER_FEATURES,
  resolveAllCapabilities,
  type BrowserFeatures,
  type CapabilityResolution,
} from "@/lib/native/capability";
import type { NativeRuntimeKind } from "@/lib/native/native-environment";
import {
  createNativeRuntimeStore,
  detectBrowserFeatures,
  INITIAL_NATIVE_SNAPSHOT,
  type NativeConnection,
  type NativeRuntimeSnapshot,
} from "@/lib/native/native-runtime";

export interface NativeContextValue {
  kind: NativeRuntimeKind;
  connection: NativeConnection;
  androidPackage: string | null;
  environment: NativeEnvironment | null;
  app: NativeAppInfo | null;
  capabilities: Readonly<Record<NativeCapability, CapabilityResolution>>;
}

export function buildNativeContextValue(snapshot: NativeRuntimeSnapshot, browser: BrowserFeatures): NativeContextValue {
  return {
    kind: snapshot.kind,
    connection: snapshot.connection,
    androidPackage: snapshot.androidPackage,
    environment: snapshot.environment,
    app: snapshot.app,
    capabilities: resolveAllCapabilities(browser, snapshot.app),
  };
}

const DEFAULT_VALUE = buildNativeContextValue(INITIAL_NATIVE_SNAPSHOT, NO_BROWSER_FEATURES);
const NativeContext = createContext<NativeContextValue>(DEFAULT_VALUE);

/** Supplies a fixed state. Used by tests and previews. The app itself mounts `NativeProvider`. */
export function NativeValueProvider({ value, children }: { value: NativeContextValue; children: ReactNode }) {
  return <NativeContext.Provider value={value}>{children}</NativeContext.Provider>;
}

const runtimeStore = createNativeRuntimeStore();
const noopSubscribe = () => () => {};

let cachedBrowserFeatures: BrowserFeatures | null = null;
function readBrowserFeatures(): BrowserFeatures {
  if (cachedBrowserFeatures === null) cachedBrowserFeatures = detectBrowserFeatures();
  return cachedBrowserFeatures;
}

const serverSnapshot = () => INITIAL_NATIVE_SNAPSHOT;
const serverBrowserFeatures = () => NO_BROWSER_FEATURES;

function safeSessionStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function NativeProvider({ children }: { children: ReactNode }) {
  const snapshot = useSyncExternalStore(runtimeStore.subscribe, runtimeStore.getSnapshot, serverSnapshot);
  const browser = useSyncExternalStore(noopSubscribe, readBrowserFeatures, serverBrowserFeatures);

  useEffect(
    () =>
      runtimeStore.attach({
        pageOrigin: window.location.origin,
        referrer: document.referrer,
        storage: safeSessionStorage(),
        listenForChannelMessages(listener) {
          const handler = (event: MessageEvent) =>
            listener({ origin: event.origin, data: event.data, ports: event.ports });
          window.addEventListener("message", handler);
          return () => window.removeEventListener("message", handler);
        },
      }),
    [],
  );

  const value = useMemo(() => buildNativeContextValue(snapshot, browser), [snapshot, browser]);
  return <NativeContext.Provider value={value}>{children}</NativeContext.Provider>;
}

export function useNative(): NativeContextValue {
  return useContext(NativeContext);
}
