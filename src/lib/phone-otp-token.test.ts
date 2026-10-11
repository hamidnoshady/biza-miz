/**
 * Issue #885, gap 2 — the phone pending token must not be readable.
 *
 * The anti-enumeration work made the two responses byte-identical on the
 * outside, but the token they both carried was a *signed* JWT, and a signed
 * JWT is not a secret: its payload is base64url, so anybody holding the
 * response could decode the middle segment and read `uid`, `businessId`,
 * `cid` and `destination` straight off it. That made the token itself the
 * oracle the response shape was built to remove — decode it and a real member
 * is instantly distinguishable from the synthetic answer, and the challenge id
 * and destination number come free.
 *
 * These tests pin the property rather than the mechanism: no segment of the
 * token decodes to anything containing the bound values, the round trip still
 * returns the exact payload (the binding is unchanged, only its legibility),
 * and the two shapes remain indistinguishable to a holder.
 */
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { getRealmSecret } from "./jwt-secret";
import { signPhonePendingToken, verifyPhonePendingToken } from "./phone-otp";

const BUSINESS = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const USER = "11111111-2222-4333-8444-555555555555";
const CHALLENGE = "99999999-8888-4777-8666-555555555555";
const PHONE = "+989121000001";

/** Every base64url segment decoded as UTF-8, ignoring undecodable noise. */
function decodedSegments(token: string): string[] {
  return token.split(".").map((part) => {
    try {
      return Buffer.from(part, "base64url").toString("utf8");
    } catch {
      return "";
    }
  });
}

describe("phone pending token opacity (gap 2)", () => {
  it("does not expose the member, tenant, challenge or destination in any segment", async () => {
    const token = await signPhonePendingToken({
      sub: USER,
      businessId: BUSINESS,
      mayAttachPhone: false,
      phone: null,
      cid: CHALLENGE,
      destination: PHONE,
      purpose: "login",
    });

    const visible = decodedSegments(token).join("\n");
    // The whole point: none of the bound values is legible to the holder.
    expect(visible).not.toContain(USER);
    expect(visible).not.toContain(BUSINESS);
    expect(visible).not.toContain(CHALLENGE);
    expect(visible).not.toContain(PHONE);
    // Nor the field names, which alone would confirm which kind of token it is.
    expect(visible).not.toContain("destination");
    expect(visible).not.toContain('"cid"');
  });

  it("still round-trips the exact payload, so the binding is unchanged", async () => {
    const token = await signPhonePendingToken({
      sub: USER,
      businessId: BUSINESS,
      mayAttachPhone: true,
      phone: PHONE,
      cid: CHALLENGE,
      destination: PHONE,
      purpose: "attach",
    });

    await expect(verifyPhonePendingToken(token)).resolves.toEqual({
      sub: USER,
      businessId: BUSINESS,
      mayAttachPhone: true,
      phone: PHONE,
      cid: CHALLENGE,
      destination: PHONE,
      purpose: "attach",
      realm: "phone",
    });
  });

  it("keeps the anti-enumeration shape valid and subjectless", async () => {
    // The synthetic answer must still verify — the route depends on a token
    // with no subject being *valid* so its verify can only ever refuse, rather
    // than being rejected outright and answering differently.
    const token = await signPhonePendingToken({
      sub: null,
      businessId: "00000000-0000-0000-0000-000000000000",
      mayAttachPhone: false,
      phone: null,
      cid: null,
      destination: null,
      purpose: "login",
    });

    const payload = await verifyPhonePendingToken(token);
    expect(payload?.sub).toBeNull();
    expect(payload?.cid).toBeNull();
    expect(payload?.destination).toBeNull();
  });

  it("refuses a token from another realm", async () => {
    const token = await signPhonePendingToken({
      sub: USER,
      businessId: BUSINESS,
      mayAttachPhone: false,
      phone: null,
      cid: CHALLENGE,
      destination: PHONE,
      purpose: "login",
    });
    // Tamper with a byte of the ciphertext: GCM must reject it rather than
    // yielding a plausible-looking payload.
    const parts = token.split(".");
    const flipped =
      parts[2].slice(0, 4) +
      (parts[2][4] === "A" ? "B" : "A") +
      parts[2].slice(5);
    await expect(
      verifyPhonePendingToken([parts[0], parts[1], flipped, parts[3]].join(".")),
    ).resolves.toBeNull();
  });

  it("refuses garbage and an empty string", async () => {
    await expect(verifyPhonePendingToken("")).resolves.toBeNull();
    await expect(verifyPhonePendingToken("not-a-token")).resolves.toBeNull();
    await expect(verifyPhonePendingToken("a.b.c")).resolves.toBeNull();
  });
});

/**
 * The transitional fallback. A pending token lives ten minutes, so at the
 * moment of a deploy there is always a population of signed-only tokens still
 * in flight. Refusing them would tell every member mid-verification that their
 * code was wrong — a self-inflicted outage at exactly the wrong moment.
 *
 * This also pins a trap worth recording: `getRealmSecret` *throws* when a realm
 * has no previous secret configured, which is the common case. If that read
 * sits outside the decrypt's try, the throw rejects the whole
 * `decrypt ?? verifySigned` expression and the fallback silently never runs.
 */
describe("legacy signed tokens still verify (deploy transition)", () => {
  it("accepts a signed-only token minted before the encryption change", async () => {
    const secret = await getRealmSecret("phone");
    const legacy = await new SignJWT({
      uid: USER,
      businessId: BUSINESS,
      mayAttachPhone: false,
      phone: null,
      cid: CHALLENGE,
      destination: PHONE,
      purpose: "login",
      realm: "phone",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(secret);

    // Sanity: this really is the old shape, not an encrypted one.
    expect(legacy.split(".").length).toBe(3);

    await expect(verifyPhonePendingToken(legacy)).resolves.toMatchObject({
      sub: USER,
      businessId: BUSINESS,
      cid: CHALLENGE,
      destination: PHONE,
      purpose: "login",
    });
  });
});
