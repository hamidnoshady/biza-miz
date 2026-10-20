/** Web Push is not a general-purpose webhook. Only provider-owned hosts may be
 * contacted. Resolve once, validate every address, then pin the TLS connection
 * to that answer (preserving hostname/SNI/certificate verification). No redirects. */
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { isPrivateAddress } from "./ssrf";

export function pushEndpoint(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      raw.length > 4096
    )
      return null;
    const host = url.hostname;
    const allowed =
      host === "fcm.googleapis.com" ||
      host === "web.push.apple.com" ||
      /^[a-z0-9-]+\.push\.services\.mozilla\.com$/.test(host);
    return allowed && url.pathname !== "/" ? url : null;
  } catch {
    return null;
  }
}

export async function postWebPush(
  raw: string,
  headers: Record<string, string>,
  body: Buffer,
): Promise<number> {
  const url = pushEndpoint(raw);
  if (!url) throw new Error("notification_endpoint_rejected");
  const addresses = await lookup(url.hostname, { all: true });
  if (
    !addresses.length ||
    addresses.some(
      ({ address }) =>
        isPrivateAddress(address) ||
        (isIP(address) === 6 &&
          (!/^[23][0-9a-f]{3}:/i.test(address) ||
            /^2002:|^2001:(?:0{1,4}:|db8:)/i.test(address))) ||
        /^(?:192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(address),
    )
  ) {
    throw new Error("notification_endpoint_rejected");
  }
  const pinned = addresses[0];
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "POST",
        headers,
        agent: false,
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, [pinned]);
          else callback(null, pinned.address, pinned.family);
        },
      },
      (res) => {
        res.resume();
        // https.request never follows redirects. A 3xx is a terminal rejection.
        resolve(res.statusCode ?? 500);
      },
    );
    req.setTimeout(10_000, () => req.destroy(new Error("notification_push_timeout")));
    req.on("error", reject);
    req.end(body);
  });
}
