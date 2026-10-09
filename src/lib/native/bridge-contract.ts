/**
 * The Web ↔ Android bridge contract (issue #884) — the framework-free half.
 *
 * The numbers and the allowlists live in `config/native-bridge-contract.json`,
 * the one file the Android build reads too. This module imports them and gives
 * the web side compile-time names for them; `native-config.test.ts` fails if the
 * two ever disagree, so neither side can drift silently.
 *
 * There is deliberately no generic executor. Every command is a named entry
 * here with a payload check and a result check, and anything else is refused
 * with `unknown_command` before it can reach a device. A page can never ask the
 * app to run an arbitrary command.
 *
 * Transport: the app and the page talk over a MessagePort that Chrome hands out
 * inside a Trusted Web Activity (see `handshake.ts`). Every frame is a JSON
 * string holding one of the three envelopes below. Only this module decides what
 * a frame means, so a malformed or unknown frame is dropped here, in one place.
 */
import contract from "../../../config/native-bridge-contract.json";

export const NATIVE_BRIDGE_PROTOCOL: string = contract.protocol;

/** The protocol version both sides speak. A frame carrying any other `v` is ignored. */
export const NATIVE_BRIDGE_VERSION: number = contract.bridgeVersion;

export const NATIVE_COMMANDS = ["app.info", "notifications.status"] as const;
export type NativeCommand = (typeof NATIVE_COMMANDS)[number];

/**
 * The bridge version at which the app first understands each command. The client refuses a
 * command that the connected app is too old for, rather than sending it.
 */
export const NATIVE_COMMAND_MIN_BRIDGE: Readonly<Record<NativeCommand, number>> = Object.freeze(
  Object.fromEntries(
    Object.entries(contract.commands).map(([key, spec]) => [key, spec.minBridgeVersion]),
  ) as Record<NativeCommand, number>,
);

export const NATIVE_EVENTS = ["bridge.ready"] as const;
export type NativeEventName = (typeof NATIVE_EVENTS)[number];

export const NATIVE_ERROR_CODES = [
  "unknown_command",
  "unsupported",
  "invalid_payload",
  "permission_denied",
  "native_failure",
  "timeout",
  "channel_closed",
  "bridge_unavailable",
  "bridge_version_too_old",
] as const;
export type NativeErrorCode = (typeof NATIVE_ERROR_CODES)[number];

export const NATIVE_PERMISSION_STATES = ["granted", "denied", "not_determined"] as const;
export type NativePermissionState = (typeof NATIVE_PERMISSION_STATES)[number];

export const NATIVE_ENVIRONMENTS = ["development", "staging", "production"] as const;
export type NativeEnvironment = (typeof NATIVE_ENVIRONMENTS)[number];

export const NATIVE_CAPABILITIES = [
  "barcode.scan",
  "printer",
  "crm.caller-id",
  "biometric",
  "notifications",
  "share",
] as const;
export type NativeCapability = (typeof NATIVE_CAPABILITIES)[number];

/**
 * The bridge version at which the Android app first provides each capability
 * natively. An app below that version cannot provide it, so the page shows an
 * «update the app» state instead of treating the feature as missing.
 */
export const NATIVE_CAPABILITY_MIN_BRIDGE: Readonly<Record<NativeCapability, number>> = Object.freeze(
  Object.fromEntries(
    Object.entries(contract.capabilities).map(([key, spec]) => [key, spec.nativeMinBridgeVersion]),
  ) as Record<NativeCapability, number>,
);

/** What `app.info` reports, and what the app announces with `bridge.ready`. */
export interface NativeAppInfo {
  appVersionName: string;
  appVersionCode: number;
  environment: NativeEnvironment;
  bridgeVersion: number;
  /** Only allowlisted capability keys survive parsing; unknown keys from a newer app are ignored. */
  capabilities: NativeCapability[];
}

export interface NativeNotificationStatus {
  permission: NativePermissionState;
}

/** Result type per command. Adding a command means adding it to every map below. */
export interface NativeCommandResults {
  "app.info": NativeAppInfo;
  "notifications.status": NativeNotificationStatus;
}

export interface NativeEventPayloads {
  "bridge.ready": NativeAppInfo;
}

export interface NativeRequestEnvelope {
  v: number;
  kind: "request";
  id: string;
  command: NativeCommand;
  payload: Record<string, unknown>;
}

export interface NativeResponseEnvelope {
  v: number;
  kind: "response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: NativeErrorCode; message?: string };
}

export interface NativeEventEnvelope {
  v: number;
  kind: "event";
  name: NativeEventName;
  payload: unknown;
}

export type NativeEnvelope = NativeRequestEnvelope | NativeResponseEnvelope | NativeEventEnvelope;

const MAX_ID_LENGTH = 64;
const MAX_MESSAGE_LENGTH = 200;
const MAX_VERSION_NAME_LENGTH = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNativeCommand(value: unknown): value is NativeCommand {
  return typeof value === "string" && (NATIVE_COMMANDS as readonly string[]).includes(value);
}

export function isNativeEventName(value: unknown): value is NativeEventName {
  return typeof value === "string" && (NATIVE_EVENTS as readonly string[]).includes(value);
}

export function isNativeErrorCode(value: unknown): value is NativeErrorCode {
  return typeof value === "string" && (NATIVE_ERROR_CODES as readonly string[]).includes(value);
}

export function isNativeCapability(value: unknown): value is NativeCapability {
  return typeof value === "string" && (NATIVE_CAPABILITIES as readonly string[]).includes(value);
}

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= MAX_ID_LENGTH && /^[A-Za-z0-9-]+$/.test(value);
}

/** Parses the `app.info` shape. Returns `null` for anything malformed rather than guessing. */
export function parseAppInfo(value: unknown): NativeAppInfo | null {
  if (!isRecord(value)) return null;
  const { appVersionName, appVersionCode, environment, bridgeVersion, capabilities } = value;
  if (typeof appVersionName !== "string" || appVersionName.length === 0 || appVersionName.length > MAX_VERSION_NAME_LENGTH) {
    return null;
  }
  if (typeof appVersionCode !== "number" || !Number.isSafeInteger(appVersionCode) || appVersionCode < 1) return null;
  if (!(NATIVE_ENVIRONMENTS as readonly unknown[]).includes(environment)) return null;
  if (typeof bridgeVersion !== "number" || !Number.isSafeInteger(bridgeVersion) || bridgeVersion < 1) return null;
  if (!Array.isArray(capabilities)) return null;
  return {
    appVersionName,
    appVersionCode,
    environment: environment as NativeEnvironment,
    bridgeVersion,
    capabilities: capabilities.filter(isNativeCapability).filter((c, i, all) => all.indexOf(c) === i),
  };
}

export function parseNotificationStatus(value: unknown): NativeNotificationStatus | null {
  if (!isRecord(value)) return null;
  if (!(NATIVE_PERMISSION_STATES as readonly unknown[]).includes(value.permission)) return null;
  return { permission: value.permission as NativePermissionState };
}

/** Checks a command's `result` against its declared shape. `null` means the app sent a bad result. */
export function parseCommandResult<C extends NativeCommand>(command: C, value: unknown): NativeCommandResults[C] | null {
  switch (command) {
    case "app.info":
      return parseAppInfo(value) as NativeCommandResults[C] | null;
    case "notifications.status":
      return parseNotificationStatus(value) as NativeCommandResults[C] | null;
    default:
      return null;
  }
}

export function parseEventPayload<E extends NativeEventName>(name: E, value: unknown): NativeEventPayloads[E] | null {
  switch (name) {
    case "bridge.ready":
      return parseAppInfo(value) as NativeEventPayloads[E] | null;
    default:
      return null;
  }
}

/**
 * Parses one frame coming from the app. Returns `null` for anything that is not
 * a complete envelope of the version this page speaks. A frame from a newer
 * protocol version is dropped, so the caller's request times out and says so,
 * rather than being half-understood.
 */
export function parseNativeEnvelope(value: unknown): NativeEnvelope | null {
  if (!isRecord(value)) return null;
  if (value.v !== NATIVE_BRIDGE_VERSION) return null;
  if (value.kind === "response") {
    if (!isRequestId(value.id) || typeof value.ok !== "boolean") return null;
    if (value.ok) {
      if (!("result" in value)) return null;
      return { v: NATIVE_BRIDGE_VERSION, kind: "response", id: value.id, ok: true, result: value.result };
    }
    if (!isRecord(value.error)) return null;
    const code = isNativeErrorCode(value.error.code) ? value.error.code : "native_failure";
    const message =
      typeof value.error.message === "string" ? value.error.message.slice(0, MAX_MESSAGE_LENGTH) : undefined;
    return { v: NATIVE_BRIDGE_VERSION, kind: "response", id: value.id, ok: false, error: { code, message } };
  }
  if (value.kind === "event") {
    if (!isNativeEventName(value.name)) return null;
    return { v: NATIVE_BRIDGE_VERSION, kind: "event", name: value.name, payload: value.payload };
  }
  if (value.kind === "request") {
    if (!isRequestId(value.id) || !isNativeCommand(value.command)) return null;
    if (value.payload !== undefined && !isRecord(value.payload)) return null;
    return {
      v: NATIVE_BRIDGE_VERSION,
      kind: "request",
      id: value.id,
      command: value.command,
      payload: (value.payload as Record<string, unknown> | undefined) ?? {},
    };
  }
  return null;
}

export function buildRequestEnvelope(
  id: string,
  command: NativeCommand,
  payload: Record<string, unknown> = {},
): NativeRequestEnvelope {
  return { v: NATIVE_BRIDGE_VERSION, kind: "request", id, command, payload };
}
