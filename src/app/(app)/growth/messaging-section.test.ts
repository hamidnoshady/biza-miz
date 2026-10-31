import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

/**
 * Comments and module specifiers are not copy.
 *
 * The specifier half is load-bearing since #902 §5f: this screen imports the
 * library view from `@/lib/kavenegar/…`, an internal address nobody reads, and
 * the supplier-name assertions below are about what a tenant can see.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/\bfrom\s+"[^"]*"/g, " ");
}

const SECTION_SOURCE = code(read("./messaging-section.tsx"));
const SERVICE_SOURCE = code(read("../../../lib/message-campaigns-service.ts"));
const ROUTE_SOURCE = code(read("../../api/messaging/route.ts"));

describe("the Growth messaging workbench", () => {
  it("uses the audience contract correctly and excludes consented people without contact from the send estimate", () => {
    // The server returns `excludedByConsent`, not `excluded`; reading the old
    // name displayed «undefined نفر» and charged for people no provider could reach.
    expect(SECTION_SOURCE).toMatch(/excludedByConsent/);
    expect(SECTION_SOURCE).toMatch(/audience\.reachable - audience\.missingContact/);
    expect(SECTION_SOURCE).not.toMatch(/audience\.excluded(?!ByConsent)/);
  });

  it("does not leave an unavailable initial read behind a permanent skeleton", () => {
    expect(SECTION_SOURCE).toMatch(/const \[loading, setLoading\]/);
    expect(SECTION_SOURCE).toMatch(/SecondaryButton/);
    expect(SECTION_SOURCE).toMatch(/تلاش دوباره/);
    expect(SECTION_SOURCE).toMatch(/SectionCardSkeleton/);
  });

  it("clears stale samples and serializes competing audience/preview responses", () => {
    expect(SECTION_SOURCE).toMatch(/audienceRequest/);
    expect(SECTION_SOURCE).toMatch(/messagePreviewRequest/);
    expect(SECTION_SOURCE).toMatch(/setMessagePreview\(null\)/);
    expect(SECTION_SOURCE).toMatch(/audienceLoading/);
  });

  it("uses the business display unit for message-credit amounts", () => {
    expect(SECTION_SOURCE).toMatch(/useMoney/);
    expect(SECTION_SOURCE).toMatch(/money\.format/);
    expect(SECTION_SOURCE).not.toMatch(/const rial/);
  });

  it("collects the manual value required by a discount-code placeholder", () => {
    expect(SECTION_SOURCE).toMatch(/usesVariable\(template, "کد_تخفیف"\)/);
    expect(SECTION_SOURCE).toMatch(/discountCode/);
    expect(SECTION_SOURCE).toMatch(/کد تخفیف در پیام/);
  });
});

describe("a campaign's delivery is explained, not just counted (issue #902 §9 item 2)", () => {
  it("shows the two waits apart, because only one of them is the carrier's", () => {
    // A queue wait and a carrier wait have opposite fixes; one averaged
    // "latency" number would hide which is happening.
    expect(SECTION_SOURCE).toMatch(/delivery\.queueLatency/);
    expect(SECTION_SOURCE).toMatch(/delivery\.sendLatency/);
    expect(SECTION_SOURCE).toMatch(/تأخیر صف/);
  });

  it("never renders an unmeasured latency as zero", () => {
    // `null` is "nothing was measured"; printing ۰.۰ would tell a business its
    // messages are instant when nobody ever measured them.
    expect(SECTION_SOURCE).toMatch(/if \(!stats\) return "—"/);
    expect(SECTION_SOURCE).not.toMatch(/stats\?\.p50 \?\? 0/);
  });

  it("reads its own delivery from the scoped server field, not from the campaign counts", () => {
    expect(ROUTE_SOURCE).toMatch(/tenantCampaignDelivery\(session\.businessId/);
    expect(SECTION_SOURCE).toMatch(/data\.campaignDelivery/);
    // Provider vocabulary, error strings and prices stay server-side.
    expect(SECTION_SOURCE).not.toMatch(/kavenegar/i);
  });
});

describe("message campaign launch safety", () => {
  it("refuses a capped or empty audience instead of silently sending a partial or permanently-sending campaign", () => {
    expect(SERVICE_SOURCE).toMatch(/campaign_audience_limit_exceeded/);
    expect(SERVICE_SOURCE).toMatch(/campaign_has_no_recipients/);
    expect(ROUTE_SOURCE).toMatch(/campaign_audience_limit_exceeded/);
    expect(ROUTE_SOURCE).toMatch(/campaign_has_no_recipients/);
  });

  it("validates placeholders in an email subject as well as its body", () => {
    expect(SERVICE_SOURCE).toMatch(/validateTemplateBody\(`\$\{body\}\\n\$\{subject\}`\)/);
  });
});

describe("Growth does not run a second billing centre (issue #764)", () => {
  it("shows the central wallet's balance and links to it, with no package purchase or credit ledger", () => {
    expect(SECTION_SOURCE).toMatch(/CENTRAL_BILLING_HREF = "\/settings\/billing"/);
    expect(SECTION_SOURCE).toMatch(/insufficientCredit/);
    expect(SECTION_SOURCE).not.toMatch(/top_up|requestTopUp|خرید اعتبار|data\.packages|data\.ledger/);
    expect(ROUTE_SOURCE).not.toMatch(/top_up|listMessageCreditPackages|listRecentMessageLedger|createMessageTopUpRequest/);
  });

  it("draws the composer and send controls only for campaigns.manage", () => {
    expect(SECTION_SOURCE).toMatch(/\{canManage \? \(/);
    expect(SECTION_SOURCE).toMatch(/!canManage \? null : campaign\.status === "draft"/);
  });
});

describe("a discount campaign's targeting is real", () => {
  const CAMPAIGNS_SOURCE = code(read("./campaigns-section.tsx"));

  it("sends the chosen product scope instead of hard-coded empty arrays", () => {
    expect(CAMPAIGNS_SOURCE).not.toMatch(/itemIds: \[\],\s*brandIds: \[\],\s*categoryIds: \[\]/);
    expect(CAMPAIGNS_SOURCE).toMatch(/JSON\.stringify\(\{ \.\.\.draft, \.\.\.scope \}\)/);
    expect(CAMPAIGNS_SOURCE).toMatch(/\/api\/promotions\/targets/);
  });

  it("no longer implies a segment-targeted discount the engine does not enforce", () => {
    expect(CAMPAIGNS_SOURCE).not.toMatch(/CampaignAudiencePanel|campaign-audience/);
    expect(CAMPAIGNS_SOURCE).toMatch(/growthSectionHref\("messaging"\)\}\?promotion=/);
  });
});

describe("an automation shows its text and its record, not just a switch (issue #902 §9 item 0)", () => {
  it("renders the server's exact preview instead of an example sentence", () => {
    // The preview must come from the server (the dispatcher's own renderer over
    // fake facts). A hand-written sample on this screen can disagree with the
    // message the customer receives, and the tenant would hear it from them.
    expect(SECTION_SOURCE).toMatch(/setting\.preview \? \(/);
    expect(SECTION_SOURCE).toMatch(/پیش‌نمایش با دادهٔ نمونه/);
    // No literal sample text is hard-coded in the screen.
    expect(SECTION_SOURCE).not.toMatch(/سارا محمدی|فروشگاه نمونه|1042/);
  });

  it("says what the automation did, including the zeros", () => {
    expect(SECTION_SOURCE).toMatch(/function deliveryLine\(delivery: TriggerDelivery\)/);
    expect(SECTION_SOURCE).toMatch(/در ۷ روز اخیر رویدادی برای این اطلاع‌رسانی ثبت نشده است/);
    expect(SECTION_SOURCE).toMatch(/deliveryLine\(setting\.delivery\)/);
  });

  it("translates a stored code with the shared map, never by echoing it", () => {
    // Specifiers are stripped from `code()`, so this one reads the raw file.
    expect(read("./messaging-section.tsx")).toMatch(
      /import \{ triggerCodeLabel \} from "@\/lib\/kavenegar\/lookup-trigger-facts"/,
    );
    expect(SECTION_SOURCE).toMatch(/triggerCodeLabel\(delivery\.lastCode\)/);
    // One map, not two: the screen must not keep its own copy of the vocabulary.
    expect(SECTION_SOURCE).not.toMatch(/no_consent: "مشتری/);
  });
});
