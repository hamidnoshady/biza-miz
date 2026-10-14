/**
 * Accepting the app's end of the channel (issue #884).
 *
 * Chrome delivers the MessagePort inside the first `message` the app sends to
 * the page. Any frame on the page can post a message with ports, so the origin
 * is the gate: only a message whose origin is this page's own origin may carry
 * the channel. A message from anywhere else never gets a port, and the page
 * ignores it.
 */
import { parseAppInfo, parseNativeEnvelope, type NativeAppInfo } from "./bridge-contract";

export interface IncomingChannelMessage<TPort> {
  origin: string;
  data: unknown;
  ports: readonly TPort[];
}

export interface AcceptedChannel<TPort> {
  port: TPort;
  /** The `bridge.ready` announcement when the first message carried one; otherwise null. */
  ready: NativeAppInfo | null;
}

/**
 * Returns the channel to adopt, or `null` when the message must be ignored.
 * Ignoring is the default: a message is accepted only when all of these hold:
 * the origin matches `pageOrigin`, a port is attached, and any payload is a
 * valid envelope.
 */
export function acceptNativeChannel<TPort>(
  message: IncomingChannelMessage<TPort>,
  pageOrigin: string,
): AcceptedChannel<TPort> | null {
  if (message.origin !== pageOrigin) return null;
  const port = message.ports[0];
  if (port === undefined || port === null) return null;

  let ready: NativeAppInfo | null = null;
  const decoded = decodeData(message.data);
  if (decoded !== undefined) {
    const envelope = parseNativeEnvelope(decoded);
    if (envelope && envelope.kind === "event" && envelope.name === "bridge.ready") {
      ready = parseAppInfo(envelope.payload);
    }
  }
  return { port, ready };
}

function decodeData(data: unknown): unknown {
  if (typeof data !== "string") return data;
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}
