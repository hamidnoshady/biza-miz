/**
 * The page-side bridge client (issue #884).
 *
 * It sends allowlisted requests, matches each response to its request by id,
 * gives up after a timeout, and reports `channel_closed` for anything still
 * pending when the channel goes away. The transport is injected, so the client
 * has no dependency on the DOM and the tests can drive it with a fake channel.
 */
import {
  NATIVE_COMMANDS,
  NATIVE_COMMAND_MIN_BRIDGE,
  buildRequestEnvelope,
  parseCommandResult,
  parseEventPayload,
  parseNativeEnvelope,
  type NativeCommand,
  type NativeCommandResults,
  type NativeErrorCode,
  type NativeEventName,
  type NativeEventPayloads,
} from "./bridge-contract";

export const DEFAULT_REQUEST_TIMEOUT_MS = 8000;

export class NativeBridgeError extends Error {
  readonly code: NativeErrorCode;

  constructor(code: NativeErrorCode, message?: string) {
    super(message ?? code);
    this.name = "NativeBridgeError";
    this.code = code;
  }
}

/**
 * The byte pipe under the client. `send` takes an envelope object and encodes it
 * itself; `onMessage` receives decoded values. The MessagePort adapter lives in
 * `native-runtime.ts`.
 */
export interface BridgeTransport {
  send(envelope: unknown): void;
  onMessage(handler: (value: unknown) => void): void;
  close(): void;
}

export interface NativeBridgeClientOptions {
  transport: BridgeTransport;
  /** The connected app's bridge version, or null before it is known. Commands it cannot run are refused. */
  peerBridgeVersion?: () => number | null;
  timeoutMs?: number;
  createId?: () => string;
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface NativeBridgeClient {
  request<C extends NativeCommand>(command: C, payload?: Record<string, unknown>): Promise<NativeCommandResults[C]>;
  onEvent<E extends NativeEventName>(name: E, handler: (payload: NativeEventPayloads[E]) => void): () => void;
  close(): void;
  readonly closed: boolean;
}

interface PendingRequest {
  command: NativeCommand;
  resolve: (value: unknown) => void;
  reject: (error: NativeBridgeError) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 128 random bits as 32 hex characters. `crypto.randomUUID` is avoided on purpose: it exists only in
 * secure contexts, and a page served over plain http would throw on its first request.
 */
export function createRequestId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createNativeBridgeClient(options: NativeBridgeClientOptions): NativeBridgeClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const createId = options.createId ?? createRequestId;
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  const { transport } = options;

  const pending = new Map<string, PendingRequest>();
  const listeners = new Map<NativeEventName, Set<(payload: unknown) => void>>();
  let closed = false;

  transport.onMessage((value) => {
    if (closed) return;
    const envelope = parseNativeEnvelope(value);
    if (!envelope) return;

    if (envelope.kind === "response") {
      const entry = pending.get(envelope.id);
      if (!entry) return;
      pending.delete(envelope.id);
      clearTimer(entry.timer);
      if (!envelope.ok) {
        entry.reject(new NativeBridgeError(envelope.error?.code ?? "native_failure", envelope.error?.message));
        return;
      }
      const result = parseCommandResult(entry.command, envelope.result);
      if (result === null) {
        entry.reject(new NativeBridgeError("invalid_payload", "The app sent a result this page does not understand."));
        return;
      }
      entry.resolve(result);
      return;
    }

    if (envelope.kind === "event") {
      const handlers = listeners.get(envelope.name);
      if (!handlers || handlers.size === 0) return;
      const payload = parseEventPayload(envelope.name, envelope.payload);
      if (payload === null) return;
      for (const handler of [...handlers]) handler(payload);
    }
    // Requests from the app are outside the contract. The page never serves commands.
  });

  return {
    get closed() {
      return closed;
    },

    request<C extends NativeCommand>(command: C, payload: Record<string, unknown> = {}) {
      if (closed) return Promise.reject(new NativeBridgeError("channel_closed"));
      if (!(NATIVE_COMMANDS as readonly string[]).includes(command)) {
        return Promise.reject(new NativeBridgeError("unknown_command"));
      }
      const peerVersion = options.peerBridgeVersion?.() ?? null;
      if (peerVersion !== null && peerVersion < NATIVE_COMMAND_MIN_BRIDGE[command]) {
        return Promise.reject(new NativeBridgeError("bridge_version_too_old"));
      }
      const id = createId();
      return new Promise<NativeCommandResults[C]>((resolve, reject) => {
        const timer = setTimer(() => {
          if (pending.delete(id)) reject(new NativeBridgeError("timeout"));
        }, timeoutMs);
        pending.set(id, {
          command,
          resolve: resolve as (value: unknown) => void,
          reject,
          timer,
        });
        try {
          transport.send(buildRequestEnvelope(id, command, payload));
        } catch {
          pending.delete(id);
          clearTimer(timer);
          reject(new NativeBridgeError("channel_closed"));
        }
      });
    },

    onEvent<E extends NativeEventName>(name: E, handler: (payload: NativeEventPayloads[E]) => void) {
      let handlers = listeners.get(name);
      if (!handlers) {
        handlers = new Set();
        listeners.set(name, handlers);
      }
      const wrapped = handler as (payload: unknown) => void;
      handlers.add(wrapped);
      return () => {
        listeners.get(name)?.delete(wrapped);
      };
    },

    close() {
      if (closed) return;
      closed = true;
      for (const entry of pending.values()) {
        clearTimer(entry.timer);
        entry.reject(new NativeBridgeError("channel_closed"));
      }
      pending.clear();
      listeners.clear();
      transport.close();
    },
  };
}
