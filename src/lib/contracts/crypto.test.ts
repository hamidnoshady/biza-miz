/**
 * Issue #908 — the signature's integrity primitives.
 *
 * The two claims this file has to make good on:
 *
 *  - **two equal documents hash equal**, regardless of which code path built
 *    them, because signatures are compared against the stored hash later;
 *  - **the stored token hash cannot be walked back** to a usable token, and a
 *    token of the wrong shape never reaches the database at all.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  contractContentHash,
  digestsMatch,
  looksLikeInvitationToken,
  newInvitationToken,
  sha256Hex,
} from "./crypto";

describe("canonicalJson", () => {
  it("sorts keys recursively so insertion order cannot change a hash", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}',
    );
  });

  it("drops undefined members but keeps null", () => {
    expect(canonicalJson({ a: undefined, b: null, c: 1 })).toBe('{"b":null,"c":1}');
    expect(canonicalJson([undefined, 1])).toBe("[null,1]");
  });

  it("quotes strings and leaves primitives alone", () => {
    expect(canonicalJson("x")).toBe('"x"');
    expect(canonicalJson(0)).toBe("0");
    expect(canonicalJson(false)).toBe("false");
    expect(canonicalJson(undefined)).toBe("null");
  });
});

describe("contractContentHash", () => {
  const document = {
    title: "قرارداد پیمانکاری",
    blocks: [{ id: "b1", type: "paragraph", text: "متن {{party_name}}" }],
    values: { party_name: "شرکت الف" },
    version: 1,
  };

  it("is stable across key order and across property-less copies", () => {
    const reordered = {
      version: 1,
      values: { party_name: "شرکت الف" },
      blocks: [{ text: "متن {{party_name}}", type: "paragraph", id: "b1" }],
      title: "قرارداد پیمانکاری",
    };
    expect(contractContentHash(reordered)).toBe(contractContentHash(document));
    expect(contractContentHash({ ...document, extra: undefined })).toBe(
      contractContentHash(document),
    );
  });

  it("changes when any signed word or resolved value changes", () => {
    const base = contractContentHash(document);
    expect(contractContentHash({ ...document, title: "قرارداد دیگر" })).not.toBe(base);
    expect(
      contractContentHash({ ...document, values: { party_name: "شرکت ب" } }),
    ).not.toBe(base);
    expect(contractContentHash({ ...document, version: 2 })).not.toBe(base);
  });

  it("is a lowercase 64-character SHA-256 digest", () => {
    expect(contractContentHash(document)).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("invitation tokens", () => {
  it("mints 32 random bytes in url-safe base64", () => {
    const token = newInvitationToken();
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(looksLikeInvitationToken(token)).toBe(true);
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 200 }, () => newInvitationToken()));
    expect(seen.size).toBe(200);
  });

  it("rejects anything that is not a 43-character token before it is hashed", () => {
    for (const junk of ["", "short", "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}=`, null, 42]) {
      expect(looksLikeInvitationToken(junk)).toBe(false);
    }
    // Padding and whitespace are the two ways a copied link gets mangled.
    expect(looksLikeInvitationToken(`${"a".repeat(42)} `)).toBe(false);
  });
});

describe("digestsMatch", () => {
  it("compares equal digests and refuses different or truncated ones", () => {
    const hash = sha256Hex("token");
    expect(digestsMatch(hash, hash)).toBe(true);
    expect(digestsMatch(hash, sha256Hex("other"))).toBe(false);
    expect(digestsMatch(hash, hash.slice(0, 32))).toBe(false);
    expect(digestsMatch("", "")).toBe(true);
  });
});
