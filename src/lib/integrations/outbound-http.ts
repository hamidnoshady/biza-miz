/** Server-only credentialed HTTP policy for tenant-configured Woo/CMS endpoints.
 * Validate at setup AND at use: old rows are not trusted. DNS is checked in
 * the socket's lookup callback (not a preflight lookup followed by fetch), so
 * rebinding cannot swap an approved public address for a private destination.
 */
import { lookup } from "node:dns";
import { isIP } from "node:net";
import { Agent } from "undici";
import ipaddr from "ipaddr.js";

export function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

function trustedDevelopmentHost(host: string): boolean {
  return process.env.NODE_ENV === "development" &&
    (process.env.CONNECTION_HTTP_DEV_HOSTS ?? "").split(",").map((h) => h.trim()).includes(host);
}

export function connectionUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error("invalid_connection_url"); }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const dev = trustedDevelopmentHost(host);
  if ((url.protocol !== "https:" && !(dev && url.protocol === "http:")) ||
      url.username || url.password || url.hash || url.search ||
      (!dev && (host === "localhost" || /\.(localhost|local|internal)$/.test(host) ||
        host.endsWith(".") || (isIP(host) && !isPublicAddress(host))))) {
    throw new Error("unsafe_connection_url");
  }
  return url;
}

/** Reject the entire DNS answer set if any address is non-public. */
export function validateConnectionAddresses(host: string, addresses: readonly { address: string; family: number }[]): void {
  if (!addresses.length || (!trustedDevelopmentHost(host) && addresses.some((a) => !isPublicAddress(a.address)))) {
    throw new Error("unsafe_connection_destination");
  }
}

const dispatcher = new Agent({
  connect: {
    timeout: 10_000,
    lookup(host, options, callback) {
      lookup(host, { all: true }, (error, addresses) => {
        if (error) return callback(error, [], 0);
        try { validateConnectionAddresses(host, addresses); }
        catch { return callback(new Error("unsafe_connection_destination"), [], 0); }
        const selected = options.family ? addresses.filter((a) => a.family === options.family) : addresses;
        if (!selected.length) return callback(new Error("connection_dns_failed"), [], 0);
        if (options.all) callback(null, selected);
        else callback(null, selected[0].address, selected[0].family);
      });
    },
  },
});

/** No redirects, no cross-origin credential forwarding, finite whole-body
 * deadline. Callers must consume the body with this same signal in force. */
export async function connectionFetch(input: string, init: RequestInit = {}): Promise<Response> {
  // Endpoints carry query filters; validate the destination separately.
  const url = new URL(input);
  const destination = new URL(url);
  destination.search = "";
  connectionUrl(destination.toString());
  const deadline = AbortSignal.timeout(15_000);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  try {
    const response = await fetch(url, { ...init, signal, redirect: "error", dispatcher } as RequestInit);
    return response;
  } catch {
    // Neither a URL nor provider response (possibly containing credentials)
    // belongs in a tenant-visible network error or diagnostic audit payload.
    throw new Error("connection_request_failed");
  }
}
