import { createHash } from "node:crypto";

/**
 * An opaque key that scopes one member's offline progress queue.
 *
 * A one-way hash of (business, member) and the server secret. The client uses
 * it only to tell "these queued events are mine" from "these belong to the
 * previous person on this device"; it is not an authorization credential, and
 * every API call still authorizes from the session cookie.
 */
export function tourSessionKey(businessId: string, userId: string): string {
  return createHash("sha256")
    .update(`${businessId}:${userId}:${process.env.JWT_SECRET ?? ""}`)
    .digest("hex")
    .slice(0, 24);
}
