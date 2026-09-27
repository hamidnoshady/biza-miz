import { describe, expect, it } from "vitest";

import {
  CMS_FINDING_LABELS,
  cmsConfigSetClause,
  cmsConfigUpdateAssignments,
  cmsFleetFindings,
  cmsKeyHint,
  isSyncKind,
  maskCmsControlConfig,
  mirrorIsDue,
  mirrorIsStale,
  normalizeCmsControlUrl,
  normalizeCmsPlatformKey,
  parseCmsConfigPatch,
  SYNC_KIND_LABELS,
  SYNC_KINDS,
  type CmsControlConfig,
  type MirroredCmsSite,
  type ValidatedCmsPatch,
} from "./platform-control";

const config = (over: Partial<CmsControlConfig> = {}): CmsControlConfig => ({
  allowInsecure: false,
  baseUrl: "https://cms.eshobe.com",
  eventsCursor: null,
  eventsShipped: 0,
  storeOrderIngestCursor: null,
  label: "",
  lastEventsAt: null,
  lastEventsError: null,
  lastMirrorAt: null,
  lastMirrorError: null,
  logShippingEnabled: false,
  mirrorEnabled: false,
  mirrorIntervalMinutes: 30,
  updatedAt: null,
  verifiedAt: null,
  verifyError: null,
  ...over,
});

const site = (over: Partial<MirroredCmsSite> = {}): MirroredCmsSite => ({
  aliases: [],
  availableLocales: ["fa"],
  businessId: "biz-1",
  currency: "IRT",
  defaultLocale: "fa",
  domain: "acme.ir",
  domainVerified: true,
  gateways: [],
  id: "site-1",
  mirroredAt: new Date().toISOString(),
  name: "آکمه",
  status: "active",
  totals: {},
  type: "business",
  updatedAt: null,
  ...over,
});

describe("normalizeCmsControlUrl", () => {
  it("keeps a clean https origin and strips the trailing slash", () => {
    expect(normalizeCmsControlUrl("https://cms.eshobe.com/")).toEqual({
      ok: true,
      secure: true,
      url: "https://cms.eshobe.com",
    });
    expect(normalizeCmsControlUrl("https://example.ir/cms/")).toMatchObject({
      url: "https://example.ir/cms",
    });
  });

  it("refuses plain http unless the operator allowed it", () => {
    // A CMS on the same private network is a legitimate http target; one reached
    // over the public internet without TLS is a mistake, and only the operator
    // can say which this is.
    expect(normalizeCmsControlUrl("http://web:3000")).toMatchObject({
      error: "https_required",
      ok: false,
    });
    expect(normalizeCmsControlUrl("http://web:3000", { allowInsecure: true })).toMatchObject({
      ok: true,
      secure: false,
      url: "http://web:3000",
    });
  });

  it("refuses a credential, a query, a fragment and a non-http scheme", () => {
    // A "CMS address" carrying a password is a paste of the wrong field.
    expect(normalizeCmsControlUrl("https://user:pw@cms.eshobe.com")).toMatchObject({
      error: "credentials_in_url",
    });
    expect(normalizeCmsControlUrl("https://cms.eshobe.com?key=abc")).toMatchObject({
      error: "invalid_url",
    });
    expect(normalizeCmsControlUrl("https://cms.eshobe.com#x")).toMatchObject({ error: "invalid_url" });
    expect(normalizeCmsControlUrl("file:///etc/passwd")).toMatchObject({ error: "invalid_url" });
    expect(normalizeCmsControlUrl("not a url")).toMatchObject({ error: "invalid_url" });
    expect(normalizeCmsControlUrl(`https://cms.eshobe.com/${"x".repeat(600)}`)).toMatchObject({
      error: "too_long",
    });
  });
});

describe("the platform credential", () => {
  it("accepts the CMS's key shape and rejects junk", () => {
    expect(normalizeCmsPlatformKey("  eshobe_live_abcdef0123456789  ")).toEqual({
      key: "eshobe_live_abcdef0123456789",
      ok: true,
    });
    expect(normalizeCmsPlatformKey("short")).toMatchObject({ ok: false });
    expect(normalizeCmsPlatformKey("has spaces in it right here")).toMatchObject({ ok: false });
    expect(normalizeCmsPlatformKey(undefined)).toMatchObject({ ok: false });
  });

  it("hints at the key without ever being usable as one", () => {
    expect(cmsKeyHint("eshobe_live_abcdef0123456789")).toBe("…6789");
    expect(cmsKeyHint("abc")).toBe("");
  });

  it("never returns the key itself in the masked view", () => {
    const masked = maskCmsControlConfig(config(), { apiKeyHint: "…6789", hasApiKey: true });
    expect(masked.configured).toBe(true);
    expect(masked.usable).toBe(true);
    expect(JSON.stringify(masked)).not.toContain("eshobe_live");
    // An address with no key is not usable, and neither is a key with no address.
    expect(maskCmsControlConfig(config(), { apiKeyHint: "", hasApiKey: false }).usable).toBe(false);
    expect(
      maskCmsControlConfig(config({ baseUrl: "" }), { apiKeyHint: "…1", hasApiKey: true }).usable,
    ).toBe(false);
  });
});

describe("parseCmsConfigPatch", () => {
  it("treats an empty api key as unchanged, never as a delete", () => {
    // The form renders the key masked, so every save posts it empty. Treating that
    // as deletion would wipe the platform's root credential for its own website
    // platform the moment somebody fixed a typo in the label.
    const result = parseCmsConfigPatch({ apiKey: "", label: "سکوی اصلی" }, { allowInsecure: false });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.changes.apiKey).toBeUndefined();
      expect(result.changes.clearApiKey).toBeUndefined();
      expect(result.changes.label).toBe("سکوی اصلی");
    }
  });

  it("clears the key only through the explicit door", () => {
    const result = parseCmsConfigPatch({ clearApiKey: true }, { allowInsecure: false });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.changes.clearApiKey).toBe(true);
  });

  it("reads allowInsecure from the same submission as the url it validates", () => {
    // Otherwise switching to an internal http address and ticking the box in one
    // save would be refused, and an operator would have to save twice with no
    // explanation of why.
    const together = parseCmsConfigPatch(
      { allowInsecure: true, baseUrl: "http://web:3000" },
      { allowInsecure: false },
    );
    expect(together.ok).toBe(true);
    const alone = parseCmsConfigPatch({ baseUrl: "http://web:3000" }, { allowInsecure: false });
    expect(alone).toMatchObject({ errors: ["https_required"], ok: false });
  });

  it("rejects an out-of-range interval and an empty patch", () => {
    expect(parseCmsConfigPatch({ mirrorIntervalMinutes: 1 }, { allowInsecure: false })).toMatchObject({
      errors: ["invalid_interval"],
      ok: false,
    });
    expect(
      parseCmsConfigPatch({ mirrorIntervalMinutes: 9000 }, { allowInsecure: false }),
    ).toMatchObject({ ok: false });
    expect(parseCmsConfigPatch({}, { allowInsecure: false })).toMatchObject({
      errors: ["nothing_to_change"],
      ok: false,
    });
    expect(parseCmsConfigPatch({ apiKey: "nope" }, { allowInsecure: false })).toMatchObject({
      errors: ["invalid_api_key"],
      ok: false,
    });
  });

  it("carries the switches through as booleans", () => {
    const result = parseCmsConfigPatch(
      { logShippingEnabled: true, mirrorEnabled: true, mirrorIntervalMinutes: 15 },
      { allowInsecure: false },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.changes).toMatchObject({
        logShippingEnabled: true,
        mirrorEnabled: true,
        mirrorIntervalMinutes: 15,
      });
    }
  });
});

describe("the console save's UPDATE", () => {
  const write = (changes: ValidatedCmsPatch) =>
    cmsConfigSetClause(
      cmsConfigUpdateAssignments(changes, { adminId: "padmin-1", encryptApiKey: (k) => `enc(${k})` }),
    );
  const targetOf = (assignment: string) => assignment.trim().split(/ =/)[0];

  it("names each column once when an address change and a new key arrive together", () => {
    // The regression this pins: both rules clear the last verification, and
    // Postgres refuses a column twice in one UPDATE
    // (`42601 multiple assignments to same column "verified_at"`) rather than
    // merging them — which made every save from «اتصال» that touched the
    // credential a 500, because the form always posts the address with it.
    const { sets } = write({ apiKey: "eshobe_live_0123456789abcd", baseUrl: "https://cms.eshobe.com" });
    const targets = sets.map(targetOf);
    expect(new Set(targets).size).toBe(targets.length);
    expect(targets.filter((column) => column === "verified_at")).toHaveLength(1);
    expect(sets).toContain("verified_at = NULL");
    expect(sets).toContain("verify_error = NULL");
    expect(sets).toContain("base_url = $1");
    expect(sets).toContain("api_key_ciphertext = $2");
    expect(sets).toContain("api_key_hint = $3");
  });

  it("collapses a cleared key onto the same verification reset", () => {
    // The «پاک کردن کلید» button posts the address too, and this is the second
    // pair of rules that used to collide.
    const { sets, values } = write({ baseUrl: "https://cms.eshobe.com", clearApiKey: true });
    expect(sets).toContain("api_key_ciphertext = NULL");
    expect(sets).toContain("api_key_hint = ''");
    expect(new Set(sets.map(targetOf)).size).toBe(sets.length);
    // Nothing bound for a column a later rule replaced with a literal.
    expect(values).toEqual(["https://cms.eshobe.com", "padmin-1"]);
  });

  it("leaves the verification alone when the edit cannot invalidate it", () => {
    // Fixing a typo in the label must not throw away a proof that still stands,
    // and must not silently keep one that no longer does: the derived columns
    // appear exactly when the address or the credential moved.
    const labelOnly = write({ label: "CMS اصلی" });
    expect(labelOnly.sets).not.toContain("verified_at = NULL");
    expect(labelOnly.sets).not.toContain("verify_error = NULL");
    expect(labelOnly.sets).toContain("label = $1");

    const addressOnly = write({ baseUrl: "https://cms2.eshobe.com" });
    expect(addressOnly.sets).toContain("verified_at = NULL");
  });

  it("numbers the placeholders from the folded list, so values cannot shift", () => {
    // The invariant the fold exists to protect: every `$n` in the SET list has a
    // value at that position, and every value is used. A duplicate dropped from
    // the list but left in the parameters would write one column's value into
    // another — silently, with a 200 and a saved form.
    const { sets, values } = write({
      allowInsecure: true,
      apiKey: "eshobe_live_0123456789abcd",
      baseUrl: "https://cms.eshobe.com",
      label: "CMS",
      logShippingEnabled: true,
      mirrorEnabled: true,
      mirrorIntervalMinutes: 15,
    });
    const placeholders = sets
      .map((assignment) => /^\w+ = \$(\d+)$/.exec(assignment)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number);
    // Contiguous from $1 in the order the columns appear, which is the only
    // numbering that cannot misalign the two lists.
    expect(placeholders).toEqual(placeholders.map((_, index) => index + 1));
    expect(values).toHaveLength(placeholders.length);
    expect(values[0]).toBe("https://cms.eshobe.com");
    expect(values[values.length - 1]).toBe("padmin-1");
    expect(sets[sets.length - 1]).toBe("updated_at = now()");
  });
});

describe("the mirror's freshness", () => {
  const now = Date.parse("2026-09-09T12:00:00.000Z");

  it("is due when it has never run, and not before the interval elapses", () => {
    expect(mirrorIsDue(config({ mirrorEnabled: false }), now)).toBe(false);
    expect(mirrorIsDue(config({ mirrorEnabled: true }), now)).toBe(true);
    expect(
      mirrorIsDue(
        config({
          lastMirrorAt: new Date(now - 10 * 60_000).toISOString(),
          mirrorEnabled: true,
          mirrorIntervalMinutes: 30,
        }),
        now,
      ),
    ).toBe(false);
    expect(
      mirrorIsDue(
        config({
          lastMirrorAt: new Date(now - 31 * 60_000).toISOString(),
          mirrorEnabled: true,
          mirrorIntervalMinutes: 30,
        }),
        now,
      ),
    ).toBe(true);
    // A corrupt timestamp must mean "run it", not "never run again".
    expect(mirrorIsDue(config({ lastMirrorAt: "nonsense", mirrorEnabled: true }), now)).toBe(true);
  });

  it("calls a figure stale only after a run has actually been missed", () => {
    // One interval late is a run in progress; two is a run that did not happen,
    // and only the second is worth telling an operator about.
    expect(mirrorIsStale(new Date(now - 40 * 60_000).toISOString(), 30, now)).toBe(false);
    expect(mirrorIsStale(new Date(now - 70 * 60_000).toISOString(), 30, now)).toBe(true);
    expect(mirrorIsStale(null, 30, now)).toBe(true);
  });
});

describe("cmsFleetFindings", () => {
  it("names nothing when the fleet is healthy", () => {
    expect(cmsFleetFindings([site(), site({ domain: "b.ir", id: "site-2" })])).toEqual([]);
  });

  it("separates an unverified domain, a suspended site and a failing gateway", () => {
    const findings = cmsFleetFindings([
      site({ domain: "unverified.ir", domainVerified: false, id: "s1" }),
      site({ domain: "off.ir", id: "s2", status: "suspended" }),
      site({
        domain: "broken.ir",
        gateways: [{ enabled: true, gateway: "zarinpal", selfTest: "failed" }],
        id: "s3",
      }),
    ]);
    const kinds = findings.map((f) => f.kind);
    expect(kinds).toContain("unverified_domain");
    expect(kinds).toContain("suspended");
    expect(kinds).toContain("gateway_failing");
    // A gateway that has never been tested is not a failure — that is an
    // onboarding state, and conflating the two makes the warning meaningless.
    expect(
      cmsFleetFindings([
        site({ gateways: [{ enabled: false, gateway: "digipay", selfTest: null }] }),
      ]),
    ).toEqual([]);
    for (const finding of findings) {
      expect(CMS_FINDING_LABELS[finding.kind]).toBeTruthy();
      expect(finding.count).toBeGreaterThan(0);
    }
  });

  it("flags a site no business here is billed for as information, not a warning", () => {
    const findings = cmsFleetFindings([site({ businessId: null })]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "no_business", severity: "info" });
  });
});

describe("sync kinds", () => {
  it("has a Persian label for every kind, and refuses one it does not know", () => {
    for (const kind of SYNC_KINDS) {
      expect(SYNC_KIND_LABELS[kind], kind).toBeTruthy();
      expect(isSyncKind(kind)).toBe(true);
    }
    expect(isSyncKind("delete-everything")).toBe(false);
    expect(isSyncKind(undefined)).toBe(false);
  });
});
