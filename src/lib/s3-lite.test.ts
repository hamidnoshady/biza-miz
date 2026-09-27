import { describe, expect, it } from "vitest";
import { parseListObjectsXml, presignS3Get, sha256Hex, signS3Request, type S3Config } from "./s3-lite";

// The pinned signatures below were cross-checked against botocore's
// S3SigV4Auth (the reference implementation) with the same fixed clock,
// credentials, and requests — byte-for-byte identical Authorization headers.
const config: S3Config = {
  endpoint: "https://s3.example.com",
  region: "us-east-1",
  bucket: "cafe-backups",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};
const now = new Date("2026-07-21T03:30:05Z");

describe("signS3Request", () => {
  it("signs a PUT exactly like the AWS reference implementation", () => {
    const signed = signS3Request(config, {
      method: "PUT",
      key: "pos-backups/pos-backup-20260721-033005.dump.enc",
      payloadHash: sha256Hex(Buffer.from("hello")),
      now,
    });
    expect(signed.url).toBe(
      "https://s3.example.com/cafe-backups/pos-backups/pos-backup-20260721-033005.dump.enc",
    );
    expect(signed.headers["x-amz-date"]).toBe("20260721T033005Z");
    expect(signed.headers["x-amz-content-sha256"]).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(signed.headers.Authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260721/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;x-amz-content-sha256;x-amz-date, " +
        "Signature=7b8174c2ad3e9b95e2eb7413993a38dff167826baed42aabf88cfe196bdfe81e",
    );
  });

  it("signs a bucket-level list with sorted, encoded query params", () => {
    const signed = signS3Request(config, {
      method: "GET",
      key: "",
      query: { prefix: "pos-backups/", "list-type": "2" },
      payloadHash: sha256Hex(""),
      now,
    });
    expect(signed.url).toBe("https://s3.example.com/cafe-backups?list-type=2&prefix=pos-backups%2F");
    expect(signed.headers.Authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260721/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;x-amz-content-sha256;x-amz-date, " +
        "Signature=d27fe8eee2e058d484e8529e818421cfb10a08d384ff7a8d20c27303bd866e20",
    );
  });

  it("percent-encodes key segments but keeps slashes", () => {
    const signed = signS3Request(config, {
      method: "GET",
      key: "a b/c(d)'e*.dump",
      payloadHash: sha256Hex(""),
      now,
    });
    expect(signed.url).toBe("https://s3.example.com/cafe-backups/a%20b/c%28d%29%27e%2A.dump");
  });

  it("changes the signature when the secret changes", () => {
    const a = signS3Request(config, { method: "GET", key: "x", payloadHash: sha256Hex(""), now });
    const b = signS3Request(
      { ...config, secretAccessKey: "other-secret" },
      { method: "GET", key: "x", payloadHash: sha256Hex(""), now },
    );
    expect(a.headers.Authorization).not.toBe(b.headers.Authorization);
  });
});

describe("presignS3Get", () => {
  // Cross-checked against boto3's `generate_presigned_url("get_object", ...)`
  // with the same fixed clock, credentials and key — same query params in
  // the same order, byte-for-byte identical X-Amz-Signature.
  it("matches boto3's presigned GET URL exactly", () => {
    const url = presignS3Get(config, "media/business-1/photo.png", 600, now);
    expect(url).toBe(
      "https://s3.example.com/cafe-backups/media/business-1/photo.png?" +
        "X-Amz-Algorithm=AWS4-HMAC-SHA256&" +
        "X-Amz-Credential=AKIDEXAMPLE%2F20260721%2Fus-east-1%2Fs3%2Faws4_request&" +
        "X-Amz-Date=20260721T033005Z&" +
        "X-Amz-Expires=600&" +
        "X-Amz-SignedHeaders=host&" +
        "X-Amz-Signature=606c421ddbca37ebfd4a86e1b12922b2d4e462e28241f906e00f8940e7fe0ca1",
    );
  });

  it("clamps a non-positive expiry to 1 second rather than signing a negative one", () => {
    const url = presignS3Get(config, "k.png", 0, now);
    expect(url).toContain("X-Amz-Expires=1");
  });

  it("floors a fractional expiry", () => {
    const url = presignS3Get(config, "k.png", 599.9, now);
    expect(url).toContain("X-Amz-Expires=599");
  });

  it("percent-encodes the key but keeps its slash", () => {
    const url = presignS3Get(config, "a b/c(d)'e*.png", 60, now);
    expect(url).toContain("/cafe-backups/a%20b/c%28d%29%27e%2A.png?");
  });

  it("changes the signature when the clock moves", () => {
    const later = new Date(now.getTime() + 1000);
    const url = presignS3Get(config, "media/business-1/photo.png", 600, later);
    expect(url).not.toContain("X-Amz-Signature=606c421ddbca37ebfd4a86e1b12922b2d4e462e28241f906e00f8940e7fe0ca1");
  });
});

describe("parseListObjectsXml", () => {
  it("extracts keys, sizes, and continuation tokens", () => {
    const xml = `<?xml version="1.0"?>
      <ListBucketResult>
        <IsTruncated>true</IsTruncated>
        <NextContinuationToken>token&amp;1</NextContinuationToken>
        <Contents>
          <Key>pos-backups/pos-backup-20260720-033001.dump.enc</Key>
          <LastModified>2026-07-20T03:30:10.000Z</LastModified>
          <Size>12345</Size>
        </Contents>
        <Contents>
          <Key>pos-backups/pos-backup-20260721-033001.dump.enc</Key>
          <LastModified>2026-07-21T03:30:11.000Z</LastModified>
          <Size>23456</Size>
        </Contents>
      </ListBucketResult>`;
    expect(parseListObjectsXml(xml)).toEqual({
      objects: [
        {
          key: "pos-backups/pos-backup-20260720-033001.dump.enc",
          size: 12345,
          lastModified: "2026-07-20T03:30:10.000Z",
        },
        {
          key: "pos-backups/pos-backup-20260721-033001.dump.enc",
          size: 23456,
          lastModified: "2026-07-21T03:30:11.000Z",
        },
      ],
      continuationToken: "token&1",
    });
  });

  it("returns no token when the listing is complete", () => {
    expect(parseListObjectsXml("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>")).toEqual({
      objects: [],
      continuationToken: null,
    });
  });
});
