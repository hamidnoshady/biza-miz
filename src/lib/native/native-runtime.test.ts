import { describe, expect, it, vi } from "vitest";
import { NATIVE_STORAGE_KEY } from "./native-environment";
import {
  createNativeRuntimeStore,
  detectBrowserFeatures,
  INITIAL_NATIVE_SNAPSHOT,
  portTransport,
  type NativeRuntimeHost,
} from "./native-runtime";
import type { IncomingChannelMessage } from "./handshake";

const PAGE = "https://app.example.test";
const TWA_REFERRER = "android-app://com.bizamiz.app.staging";
const APP_INFO = {
  appVersionName: "1.0.0",
  appVersionCode: 3,
  environment: "staging",
  bridgeVersion: 1,
  capabilities: ["notifications"],
};

interface FakePort {
  posted: string[];
  started: boolean;
  closed: boolean;
  emit(data: unknown): void;
  asPort(): MessagePort;
}

function fakePort(): FakePort {
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const state = { posted: [] as string[], started: false, closed: false };
  const port = {
    get posted() {
      return state.posted;
    },
    get started() {
      return state.started;
    },
    get closed() {
      return state.closed;
    },
    emit(data: unknown) {
      for (const listener of listeners) listener({ data });
    },
    asPort() {
      return {
        postMessage(message: string) {
          state.posted.push(message);
        },
        addEventListener(_type: string, listener: (event: { data: unknown }) => void) {
          listeners.push(listener);
        },
        start() {
          state.started = true;
        },
        close() {
          state.closed = true;
        },
      } as unknown as MessagePort;
    },
  };
  return port;
}

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    data,
  };
}

function fakeHost(overrides: Partial<NativeRuntimeHost> & { referrer?: string } = {}) {
  let listener: ((message: IncomingChannelMessage<MessagePort>) => void) | null = null;
  const stopListening = vi.fn();
  const host: NativeRuntimeHost = {
    pageOrigin: PAGE,
    referrer: "",
    storage: fakeStorage(),
    listenForChannelMessages(next) {
      listener = next;
      return stopListening;
    },
    ...overrides,
  };
  return {
    host,
    stopListening,
    emit(message: { origin?: string; data: unknown; ports: unknown[] }) {
      listener?.({ origin: PAGE, ...message } as IncomingChannelMessage<MessagePort>);
    },
  };
}

function readyFrame(payload: unknown = APP_INFO) {
  return JSON.stringify({ v: 1, kind: "event", name: "bridge.ready", payload });
}

describe("createNativeRuntimeStore", () => {
  it("starts in the plain web state", () => {
    expect(createNativeRuntimeStore().getSnapshot()).toEqual(INITIAL_NATIVE_SNAPSHOT);
  });

  it("moves a TWA page to awaiting-channel and remembers its package", () => {
    const store = createNativeRuntimeStore();
    const { host } = fakeHost({ referrer: TWA_REFERRER });
    const storage = fakeStorage();
    store.attach({ ...host, storage });

    expect(store.getSnapshot()).toMatchObject({
      kind: "android-twa",
      connection: "awaiting-channel",
      androidPackage: "com.bizamiz.app.staging",
      environment: "staging",
      app: null,
    });
    expect(storage.data.get(NATIVE_STORAGE_KEY)).toBe("com.bizamiz.app.staging");
  });

  it("leaves a plain browser page idle", () => {
    const store = createNativeRuntimeStore();
    store.attach(fakeHost().host);
    expect(store.getSnapshot()).toMatchObject({ kind: "web", connection: "idle", app: null });
  });

  it("connects straight away when the app announces itself with bridge.ready", () => {
    const store = createNativeRuntimeStore();
    const { host, emit } = fakeHost({ referrer: TWA_REFERRER });
    store.attach(host);
    const port = fakePort();

    emit({ data: readyFrame(), ports: [port.asPort()] });

    expect(store.getSnapshot()).toMatchObject({ connection: "connected", app: APP_INFO });
    expect(port.started).toBe(true);
  });

  it("asks the app for app.info when the handshake carries no announcement, and connects on the answer", async () => {
    const store = createNativeRuntimeStore();
    const { host, emit } = fakeHost({ referrer: TWA_REFERRER });
    store.attach(host);
    const port = fakePort();

    emit({ data: "", ports: [port.asPort()] });
    expect(port.posted).toHaveLength(1);
    const request = JSON.parse(port.posted[0]);
    expect(request).toMatchObject({ v: 1, kind: "request", command: "app.info" });

    port.emit(JSON.stringify({ v: 1, kind: "response", id: request.id, ok: true, result: APP_INFO }));
    await vi.waitFor(() => expect(store.getSnapshot().connection).toBe("connected"));
    expect(store.getSnapshot().app).toEqual(APP_INFO);
  });

  it("ignores a channel that comes from another origin", () => {
    const store = createNativeRuntimeStore();
    const { host, emit } = fakeHost({ referrer: TWA_REFERRER });
    store.attach(host);
    const port = fakePort();

    emit({ origin: "https://evil.example", data: readyFrame(), ports: [port.asPort()] });

    expect(store.getSnapshot().connection).toBe("awaiting-channel");
    expect(port.started).toBe(false);
  });

  it("drops the old channel when a fresh handshake arrives, so only one channel is live", () => {
    const store = createNativeRuntimeStore();
    const { host, emit } = fakeHost({ referrer: TWA_REFERRER });
    store.attach(host);
    const first = fakePort();
    const second = fakePort();

    emit({ data: readyFrame(), ports: [first.asPort()] });
    emit({ data: readyFrame(), ports: [second.asPort()] });

    expect(first.closed).toBe(true);
    expect(store.getSnapshot().connection).toBe("connected");
  });

  it("uses a remembered package to keep detecting the TWA after a referrer-less reload", () => {
    const store = createNativeRuntimeStore();
    store.attach(fakeHost({ storage: fakeStorage({ [NATIVE_STORAGE_KEY]: "com.bizamiz.app" }) }).host);
    expect(store.getSnapshot()).toMatchObject({ kind: "android-twa", androidPackage: "com.bizamiz.app" });
  });

  it("does not crash when storage is blocked", () => {
    const store = createNativeRuntimeStore();
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => store.attach(fakeHost({ referrer: TWA_REFERRER, storage: blocked }).host)).not.toThrow();
    expect(store.getSnapshot().kind).toBe("android-twa");
  });

  it("notifies subscribers on change and stops after unsubscribe", () => {
    const store = createNativeRuntimeStore();
    const { host, emit } = fakeHost({ referrer: TWA_REFERRER });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.attach(host);
    expect(listener).toHaveBeenCalled();
    listener.mockClear();

    unsubscribe();
    emit({ data: readyFrame(), ports: [fakePort().asPort()] });
    expect(listener).not.toHaveBeenCalled();
  });

  it("tears everything down on detach: stops listening, closes the channel, and returns to the initial state", () => {
    const store = createNativeRuntimeStore();
    const { host, emit, stopListening } = fakeHost({ referrer: TWA_REFERRER });
    const detach = store.attach(host);
    const port = fakePort();
    emit({ data: readyFrame(), ports: [port.asPort()] });

    detach();

    expect(stopListening).toHaveBeenCalledTimes(1);
    expect(port.closed).toBe(true);
    expect(store.getSnapshot()).toEqual(INITIAL_NATIVE_SNAPSHOT);
  });
});

describe("portTransport", () => {
  it("encodes outgoing envelopes as JSON strings, which is what the app's postMessage expects", () => {
    const port = fakePort();
    const transport = portTransport(port.asPort());
    transport.onMessage(() => {});
    transport.send({ v: 1, kind: "request", id: "req-1", command: "app.info", payload: {} });
    expect(port.posted).toEqual(['{"v":1,"kind":"request","id":"req-1","command":"app.info","payload":{}}']);
  });

  it("decodes incoming JSON strings and drops anything that is not valid JSON", () => {
    const port = fakePort();
    const transport = portTransport(port.asPort());
    const received: unknown[] = [];
    transport.onMessage((value) => received.push(value));

    port.emit('{"v":1,"kind":"event"}');
    port.emit("not json");
    port.emit({ already: "an object" });

    expect(received).toEqual([{ v: 1, kind: "event" }]);
  });

  it("starts the port and closes it", () => {
    const port = fakePort();
    const transport = portTransport(port.asPort());
    transport.onMessage(() => {});
    expect(port.started).toBe(true);
    transport.close();
    expect(port.closed).toBe(true);
  });
});

describe("detectBrowserFeatures", () => {
  it("reports every feature present on the scope", () => {
    const scope = {
      BarcodeDetector: class {},
      PublicKeyCredential: function () {},
      PushManager: class {},
      navigator: { share: () => Promise.resolve() },
    } as unknown as typeof globalThis;
    expect(detectBrowserFeatures(scope)).toEqual({
      barcodeDetector: true,
      webAuthn: true,
      pushManager: true,
      webShare: true,
    });
  });

  it("reports nothing on a bare scope, without throwing", () => {
    expect(detectBrowserFeatures({} as unknown as typeof globalThis)).toEqual({
      barcodeDetector: false,
      webAuthn: false,
      pushManager: false,
      webShare: false,
    });
  });
});
