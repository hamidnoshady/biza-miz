/**
 * The page's native-runtime state (issue #884), as a small external store.
 *
 * The React provider reads this store with `useSyncExternalStore`, so the store
 * has no React dependency and the tests can drive it with plain objects. Only
 * `portTransport` touches a real MessagePort.
 *
 * Flow inside a TWA: the app posts one message with a port to this page, the
 * handshake accepts it only from this origin, the client sends `app.info`, and
 * the snapshot moves to `connected`. A page that is not in a TWA never leaves
 * `idle`, and no native call is made.
 */
import {
  createNativeBridgeClient,
  type BridgeTransport,
  type NativeBridgeClient,
} from "./bridge";
import { type NativeAppInfo, type NativeEnvironment } from "./bridge-contract";
import { acceptNativeChannel, type IncomingChannelMessage } from "./handshake";
import {
  detectNativeRuntime,
  NATIVE_STORAGE_KEY,
  type NativeRuntimeKind,
} from "./native-environment";
import { NO_BROWSER_FEATURES, type BrowserFeatures } from "./capability";

export type NativeConnection = "idle" | "awaiting-channel" | "connected";

export interface NativeRuntimeSnapshot {
  kind: NativeRuntimeKind;
  connection: NativeConnection;
  androidPackage: string | null;
  environment: NativeEnvironment | null;
  app: NativeAppInfo | null;
}

export const INITIAL_NATIVE_SNAPSHOT: NativeRuntimeSnapshot = Object.freeze({
  kind: "web",
  connection: "idle",
  androidPackage: null,
  environment: null,
  app: null,
});

export interface NativeRuntimeHost {
  pageOrigin: string;
  referrer: string;
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  listenForChannelMessages(listener: (message: IncomingChannelMessage<MessagePort>) => void): () => void;
}

export interface NativeRuntimeStore {
  getSnapshot(): NativeRuntimeSnapshot;
  subscribe(listener: () => void): () => void;
  /** Starts detection and the handshake listener. Returns a function that tears both down. */
  attach(host: NativeRuntimeHost): () => void;
}

/** Adapts a real MessagePort to the bridge's transport. The app expects JSON strings, so every envelope is encoded here. */
export function portTransport(port: MessagePort): BridgeTransport {
  return {
    send(envelope) {
      port.postMessage(JSON.stringify(envelope));
    },
    onMessage(handler) {
      port.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        try {
          handler(JSON.parse(event.data));
        } catch {
          // A frame that is not JSON is not part of the protocol. Drop it.
        }
      });
      port.start();
    },
    close() {
      port.close();
    },
  };
}

function readRemembered(storage: NativeRuntimeHost["storage"]): string | null {
  try {
    return storage?.getItem(NATIVE_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function rememberPackage(storage: NativeRuntimeHost["storage"], androidPackage: string): void {
  try {
    storage?.setItem(NATIVE_STORAGE_KEY, androidPackage);
  } catch {
    // Storage can be blocked. Detection then relies on the live referrer alone.
  }
}

export function createNativeRuntimeStore(): NativeRuntimeStore {
  let snapshot: NativeRuntimeSnapshot = INITIAL_NATIVE_SNAPSHOT;
  const subscribers = new Set<() => void>();
  let client: NativeBridgeClient | null = null;

  function update(patch: Partial<NativeRuntimeSnapshot>) {
    snapshot = { ...snapshot, ...patch };
    for (const subscriber of [...subscribers]) subscriber();
  }

  function closeClient() {
    client?.close();
    client = null;
  }

  function adopt(port: MessagePort, ready: NativeAppInfo | null) {
    closeClient();
    const next = createNativeBridgeClient({
      transport: portTransport(port),
      peerBridgeVersion: () => snapshot.app?.bridgeVersion ?? null,
    });
    client = next;
    next.onEvent("bridge.ready", (info) => {
      if (client === next) update({ connection: "connected", app: info });
    });
    if (ready) {
      update({ connection: "connected", app: ready });
      return;
    }
    next.request("app.info").then(
      (info) => {
        if (client === next) update({ connection: "connected", app: info });
      },
      () => {
        // Stay on awaiting-channel. A fresh handshake from the app can still connect.
        if (client === next) update({ connection: "awaiting-channel", app: null });
      },
    );
  }

  return {
    getSnapshot: () => snapshot,

    subscribe(listener) {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },

    attach(host) {
      const detection = detectNativeRuntime({
        referrer: host.referrer,
        remembered: readRemembered(host.storage),
      });
      if (detection.fromReferrer && detection.androidPackage) {
        rememberPackage(host.storage, detection.androidPackage);
      }
      update({
        kind: detection.kind,
        androidPackage: detection.androidPackage,
        environment: detection.environment,
        connection: detection.kind === "android-twa" ? "awaiting-channel" : "idle",
        app: null,
      });

      // The listener always runs. The handshake is the real trust gate (same origin
      // plus a port), so a page that was not detected as a TWA still connects if the
      // app sends a valid channel, for example after a referrer-less reload.
      const stopListening = host.listenForChannelMessages((message) => {
        const accepted = acceptNativeChannel(message, host.pageOrigin);
        if (accepted) adopt(accepted.port, accepted.ready);
      });

      return () => {
        stopListening();
        closeClient();
        snapshot = INITIAL_NATIVE_SNAPSHOT;
        for (const subscriber of [...subscribers]) subscriber();
      };
    },
  };
}

/** Feature detection that never throws. It is called once per page load, from the client only. */
export function detectBrowserFeatures(scope: typeof globalThis = globalThis): BrowserFeatures {
  const nav = scope.navigator as Navigator | undefined;
  try {
    return Object.freeze({
      barcodeDetector: "BarcodeDetector" in scope,
      webAuthn: typeof (scope as { PublicKeyCredential?: unknown }).PublicKeyCredential === "function",
      pushManager: "PushManager" in scope,
      webShare: typeof nav?.share === "function",
    });
  } catch {
    return NO_BROWSER_FEATURES;
  }
}
