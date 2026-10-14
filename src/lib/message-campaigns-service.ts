/**
 * Phase 37 Wave 2 — templates and campaigns, and the send-time audience
 * snapshot that turns a dynamic segment into a frozen recipient list.
 *
 * The audience comes from ONLY the Phase 36d bridge
 * (`audienceForSegment` → `resolveSegment` with the channel's consent purpose),
 * which is what excludes an unconsented member even when they are in the
 * segment. This module never builds a member list another way, and the
 * `message_recipients` snapshot means a segment that changes after the send
 * never rewrites who was told.
 *
 * Sending itself is *not* done here: launching a campaign writes the recipients
 * and queues an outbox row per recipient; only the outbox tick drains them.
 */
import { getPool, query } from "./db";
import { audienceForSegment, type CampaignAudience } from "./campaign-audience";
import type { CampaignChannel, AudienceMember } from "./campaign-channels";
import { contactFor } from "./campaign-channels";
import {
  renderMessageTemplate,
  templateVariableTokens,
  unknownTemplateVariables,
  type MessageTemplateValues,
} from "./message-template";
import { formatTomanText } from "./money";
import { toPersianDigits } from "./digits";
import { getPublicMessageConfig } from "./messaging-billing";
import { messageCostRial } from "./messaging-billing-pure";
import { storeCreditBalance } from "./loyalty-service";
import { getGrowthSettings } from "./growth-settings-service";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export interface MessageVariablesSource {
  name: string;
  shopName: string;
  /** Integer loyalty points, when known. */
  points?: number | null;
  /** Rial amount, when known (formatted with formatTomanText → Persian toman). */
  creditRial?: number | null;
  discountCode?: string | null;
}

/** Assemble the closed variable map from a member and its data source. */
export function buildMessageVariables(source: MessageVariablesSource): MessageTemplateValues {
  const values: MessageTemplateValues = { نام: source.name, نام_فروشگاه: source.shopName };
  if (typeof source.points === "number") values["امتیاز"] = toPersianDigits(source.points);
  if (typeof source.creditRial === "number") values["اعتبار"] = formatTomanText(String(source.creditRial));
  if (typeof source.discountCode === "string" && source.discountCode.length > 0) {
    values["کد_تخفیف"] = source.discountCode;
  }
  return values;
}

/**
 * Variables the body uses but the data source could not supply. A known-but-
 * unresolved variable is a *send-blocking* error (not a silent empty string) —
 * the closed set plus "every used variable has data" is what keeps a recipient
 * from getting "سلام ، ..." with a hole where their name should be.
 */
export function unresolvedTemplateVariables(
  body: string,
  values: MessageTemplateValues,
): string[] {
  return templateVariableTokens(body).filter((v) => values[v as keyof MessageTemplateValues] === undefined);
}

/** Render one recipient line; throws listing unresolved used variables. */
export function renderRecipientBody(body: string, values: MessageTemplateValues): string {
  const missing = unresolvedTemplateVariables(body, values);
  if (missing.length > 0) {
    throw new Error(`message_variable_missing:${missing.join(",")}`);
  }
  return renderMessageTemplate(body, values);
}

/** One sendable recipient: the frozen address plus the rendered text. */
export interface MessageRecipientInput {
  customerId: string;
  address: string;
  subject: string;
  body: string;
}

/**
 * The address a member is reachable on for a channel. Consent has already been
 * applied by the audience resolver; this only picks the channel's address
 * column and rejects a member who somehow slipped through with none.
 */
export function recipientAddressFor(member: AudienceMember, channel: CampaignChannel): string | null {
  const address = contactFor(member, channel);
  return address && address.trim().length > 0 ? address.trim() : null;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export interface MessageTemplateRecord {
  id: string;
  businessId: string;
  channel: CampaignChannel;
  name: string;
  subject: string;
  body: string;
  createdAt: string;
}

export interface SaveTemplateInput {
  channel: CampaignChannel;
  name: string;
  subject?: string;
  body: string;
}

export function validateTemplateBody(body: string): string[] {
  return unknownTemplateVariables(body);
}

export async function listMessageTemplates(
  businessId: string,
  channel?: CampaignChannel,
): Promise<MessageTemplateRecord[]> {
  const { rows } = await query<{
    id: string;
    business_id: string;
    channel: string;
    name: string;
    subject: string;
    body: string;
    created_at: string;
  }>(
    `SELECT id, business_id, channel, name, subject, body, created_at
       FROM message_templates
      WHERE business_id = $1 AND ($2::text IS NULL OR channel = $2)
      ORDER BY created_at DESC`,
    [businessId, channel ?? null],
  );
  return rows.map((r) => ({
    id: r.id,
    businessId: r.business_id,
    channel: r.channel as CampaignChannel,
    name: r.name,
    subject: r.subject,
    body: r.body,
    createdAt: r.created_at,
  }));
}

export async function getMessageTemplate(businessId: string, id: string): Promise<MessageTemplateRecord | null> {
  const { rows } = await query<{
    id: string;
    business_id: string;
    channel: string;
    name: string;
    subject: string;
    body: string;
    created_at: string;
  }>(
    `SELECT id, business_id, channel, name, subject, body, created_at
       FROM message_templates WHERE business_id = $1 AND id = $2`,
    [businessId, id],
  );
  const r = rows[0];
  return r
    ? { id: r.id, businessId: r.business_id, channel: r.channel as CampaignChannel, name: r.name, subject: r.subject, body: r.body, createdAt: r.created_at }
    : null;
}

export async function saveMessageTemplate(
  businessId: string,
  input: SaveTemplateInput,
): Promise<MessageTemplateRecord> {
  const body = input.body.trim();
  if (!body) throw new Error("invalid_template_body");
  const subject = input.channel === "email" ? (input.subject ?? "").trim() : "";
  // Email subjects are delivered text too. Validating only the body let an
  // unknown placeholder survive in a subject and reach customers literally.
  const unknown = validateTemplateBody(`${body}\n${subject}`);
  if (unknown.length > 0) throw new Error(`unknown_template_variable:${unknown.join(",")}`);
  const name = input.name.trim();
  if (!name) throw new Error("invalid_template_name");

  const { rows } = await query<{
    id: string;
    business_id: string;
    channel: string;
    name: string;
    subject: string;
    body: string;
    created_at: string;
  }>(
    `INSERT INTO message_templates (business_id, channel, name, subject, body)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, business_id, channel, name, subject, body, created_at`,
    [businessId, input.channel, name, subject, body],
  );
  const r = rows[0];
  return { id: r.id, businessId: r.business_id, channel: r.channel as CampaignChannel, name: r.name, subject: r.subject, body: r.body, createdAt: r.created_at };
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export interface CampaignSummary {
  id: string;
  businessId: string;
  channel: CampaignChannel;
  name: string;
  templateId: string | null;
  segmentId: string | null;
  projectId: string | null;
  promotionId: string | null;
  status: string;
  triggeredBy: string;
  totalRecipients: number;
  sentCount: number;
  deliveredCount: number;
  failedCount: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

const CAMPAIGN_COLUMNS = `id, business_id AS "businessId", channel, name,
  template_id AS "templateId", segment_id AS "segmentId", project_id AS "projectId",
  promotion_id AS "promotionId", status, triggered_by AS "triggeredBy", total_recipients AS "totalRecipients",
  sent_count AS "sentCount", delivered_count AS "deliveredCount",
  failed_count AS "failedCount", created_at AS "createdAt",
  started_at AS "startedAt", completed_at AS "completedAt"`;

function toCampaign(r: {
  id: string;
  businessId: string;
  channel: string;
  name: string;
  templateId: string | null;
  segmentId: string | null;
  projectId: string | null;
  promotionId: string | null;
  status: string;
  triggeredBy: string;
  totalRecipients: number;
  sentCount: number;
  deliveredCount: number;
  failedCount: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}): CampaignSummary {
  return {
    id: r.id,
    businessId: r.businessId,
    channel: r.channel as CampaignChannel,
    name: r.name,
    templateId: r.templateId,
    segmentId: r.segmentId,
    projectId: r.projectId,
    promotionId: r.promotionId,
    status: r.status,
    triggeredBy: r.triggeredBy,
    totalRecipients: r.totalRecipients,
    sentCount: r.sentCount,
    deliveredCount: r.deliveredCount,
    failedCount: r.failedCount,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
  };
}

export async function listMessageCampaigns(businessId: string): Promise<CampaignSummary[]> {
  const { rows } = await query<Parameters<typeof toCampaign>[0]>(
    `SELECT ${CAMPAIGN_COLUMNS} FROM message_campaigns
      WHERE business_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [businessId],
  );
  return rows.map(toCampaign);
}

export async function getMessageCampaign(businessId: string, id: string): Promise<CampaignSummary | null> {
  const { rows } = await query<Parameters<typeof toCampaign>[0]>(
    `SELECT ${CAMPAIGN_COLUMNS} FROM message_campaigns WHERE business_id = $1 AND id = $2`,
    [businessId, id],
  );
  return rows[0] ? toCampaign(rows[0]) : null;
}

export interface CreateCampaignInput {
  channel: CampaignChannel;
  name: string;
  templateId: string;
  segmentId: string | null;
  projectId?: string | null;
  promotionId?: string | null;
  scheduledAt?: string | null;
  triggeredBy?: string;
}

export async function createMessageCampaign(
  businessId: string,
  input: CreateCampaignInput,
): Promise<CampaignSummary> {
  const name = input.name.trim();
  if (!name) throw new Error("invalid_campaign_name");
  const { rows } = await query<Parameters<typeof toCampaign>[0]>(
    `INSERT INTO message_campaigns
       (business_id, channel, name, template_id, segment_id, project_id, promotion_id, scheduled_at, triggered_by, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft')
     RETURNING ${CAMPAIGN_COLUMNS}`,
    [
      businessId,
      input.channel,
      name,
      input.templateId,
      input.segmentId,
      input.projectId ?? null,
      input.promotionId ?? null,
      input.scheduledAt ?? null,
      input.triggeredBy ?? "",
    ],
  );
  return toCampaign(rows[0]);
}

export interface LaunchResult {
  campaignId: string;
  total: number;
  excluded: number;
  audience: CampaignAudience | null;
}

/**
 * Resolve the segment's reachable audience, render each member's frozen line
 * and queue it. This is the moment "send" means something, and the snapshot is
 * taken here — not in the tick, which only drains what is already queued.
 */
export async function launchMessageCampaign(
  businessId: string,
  campaignId: string,
  options: { creditRial?: number; discountCode?: string } = {},
): Promise<LaunchResult> {
  const campaign = await getMessageCampaign(businessId, campaignId);
  if (!campaign) throw new Error("not_found");
  if (!campaign.segmentId) throw new Error("campaign_needs_segment");
  if (campaign.status === "sending" || campaign.status === "completed") {
    throw new Error("campaign_already_launched");
  }

  const template = await getMessageTemplate(businessId, campaign.templateId ?? "");
  if (!template) throw new Error("template_not_found");
  const messageConfig = await getPublicMessageConfig();
  if (!messageConfig.enabled || !messageConfig.configured) throw new Error("messaging_not_configured");

  const audience = await audienceForSegment(businessId, campaign.segmentId, campaign.channel);
  // `members` is intentionally capped so an accidental broad segment cannot
  // pull an entire customer base into one request. A campaign must never turn
  // that safety cap into a silent partial send: ask the operator to narrow the
  // segment instead of snapshotting only the first `AUDIENCE_LIMIT` people.
  if (audience.truncated) throw new Error("campaign_audience_limit_exceeded");

  const businessRow = await query<{ name: string }>(
    "SELECT name FROM businesses WHERE id = $1",
    [businessId],
  );
  const shopName = businessRow.rows[0]?.name ?? "";

  // Every used variable must have a data path before we write a single row: a
  // template that names a variable no one can resolve is a blocked launch, not
  // a body with holes. Store credit is a real per-customer balance, so it is
  // loaded below; a discount code has no customer-level source and must be
  // supplied explicitly by the person launching this campaign.
  const templateText = `${template.subject}\n${template.body}`;
  const unknown = validateTemplateBody(templateText);
  if (unknown.length > 0) throw new Error(`unknown_template_variable:${unknown.join(",")}`);
  const used = templateVariableTokens(templateText);
  if (used.includes("کد_تخفیف") && !options.discountCode) {
    throw new Error("message_variable_missing:کد_تخفیف");
  }

  const customerIds = audience.members.map((member) => member.id);
  // Values that differ by recipient are read once per audience, rather than
  // doing an N+1 query while the launch transaction is being assembled.
  const needsPoints = used.includes("امتیاز");
  const needsCredit = used.includes("اعتبار");
  const [pointsByCustomer, creditByCustomer] = await Promise.all([
    needsPoints ? loadPointsMap(businessId, customerIds) : Promise.resolve(new Map<string, number>()),
    needsCredit ? loadStoreCreditMap(businessId, customerIds) : Promise.resolve(new Map<string, number>()),
  ]);

  const recipients: MessageRecipientInput[] = [];
  let skippedForAddress = 0;
  for (const member of audience.members) {
    const address = recipientAddressFor(member, campaign.channel);
    if (!address) {
      skippedForAddress += 1;
      continue;
    }
    const values = buildMessageVariables({
      name: member.name,
      shopName,
      points: pointsByCustomer.get(member.id) ?? 0,
      creditRial: needsCredit ? creditByCustomer.get(member.id) ?? 0 : options.creditRial,
      discountCode: options.discountCode,
    });
    recipients.push({
      customerId: member.id,
      address,
      subject:
        template.channel === "email"
          ? renderMessageTemplate(template.subject, values)
          : "",
      body: renderRecipientBody(template.body, values),
    });
  }

  // A consented segment can still have no usable addresses. Do not change the
  // campaign to «در حال ارسال» with an empty outbox: the drain has no row to
  // reconcile, so that state would be permanent and misleading.
  if (recipients.length === 0) throw new Error("campaign_has_no_recipients");

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE message_campaigns
          SET status = 'sending', started_at = now(), total_recipients = $3, updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [businessId, campaignId, recipients.length],
    );
    for (const r of recipients) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO message_recipients (business_id, campaign_id, customer_id, channel, address, subject, body)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [businessId, campaignId, r.customerId, campaign.channel, r.address, r.subject, r.body],
      );
      await client.query(
        `INSERT INTO message_outbox (business_id, recipient_id, campaign_id, status, next_attempt_at)
         VALUES ($1, $2, $3, 'queued', now())`,
        [businessId, rows[0].id, campaignId],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  return {
    campaignId,
    total: recipients.length,
    excluded: audience.matched - audience.reachable + skippedForAddress,
    audience,
  };
}

interface TriggeredMessageInput {
  businessId: string;
  customerId: string;
  templateId: string;
  channel: CampaignChannel;
  projectId?: string;
  triggerLabel: string;
}

interface PreparedTriggeredMessage {
  subject: string;
  recipient: MessageRecipientInput;
  template: MessageTemplateRecord;
}

/** Re-read the target's consent/contact and the template at firing time. */
async function prepareTriggeredMessage(input: TriggeredMessageInput): Promise<PreparedTriggeredMessage> {
  const template = await getMessageTemplate(input.businessId, input.templateId);
  if (!template || template.channel !== input.channel) throw new Error("template_not_found");
  const { rows: customers } = await query<{
    id: string; name: string; phone: string | null; phone_e164: string | null; email: string | null;
    sms_consent: boolean; marketing_consent: boolean;
  }>(
    `SELECT id, name, phone, phone_e164, email, sms_consent, marketing_consent
       FROM parties
      WHERE business_id = $1 AND id = $2 AND role = 'customer' AND is_active AND merged_into_id IS NULL`,
    [input.businessId, input.customerId],
  );
  const customer = customers[0];
  if (!customer) throw new Error("customer_not_found");
  // This is the triggered counterpart of audienceForSegment's SQL predicate:
  // no stored job can bypass a customer's current consent by carrying an old address.
  if ((input.channel === "sms" && !customer.sms_consent) || (input.channel === "email" && !customer.marketing_consent)) {
    throw new Error("customer_consent_missing");
  }
  const member: AudienceMember = {
    id: customer.id, name: customer.name, phone: customer.phone, phoneE164: customer.phone_e164,
    email: customer.email, smsConsent: customer.sms_consent, marketingConsent: customer.marketing_consent,
  };
  const address = recipientAddressFor(member, input.channel);
  if (!address) throw new Error("customer_contact_missing");
  const business = await query<{ name: string }>("SELECT name FROM businesses WHERE id = $1", [input.businessId]);
  const templateText = `${template.subject}\n${template.body}`;
  const unknown = validateTemplateBody(templateText);
  if (unknown.length > 0) throw new Error(`unknown_template_variable:${unknown.join(",")}`);
  const used = templateVariableTokens(templateText);
  const points = used.includes("امتیاز")
    ? (await loadPointsMap(input.businessId, [customer.id])).get(customer.id) ?? 0
    : 0;
  const creditRial = used.includes("اعتبار")
    ? await storeCreditBalance(input.businessId, customer.id)
    : undefined;
  const values = buildMessageVariables({
    name: customer.name,
    shopName: business.rows[0]?.name ?? "",
    points,
    creditRial,
  });
  return {
    template,
    subject: template.channel === "email" ? renderRecipientBody(template.subject, values) : "",
    recipient: { customerId: customer.id, address, subject: template.channel === "email" ? renderRecipientBody(template.subject, values) : "", body: renderRecipientBody(template.body, values) },
  };
}

/** Read the current rate plus the fully rendered one-recipient body for the cap gate. */
export async function estimateTriggeredMessageCost(input: TriggeredMessageInput): Promise<number> {
  const prepared = await prepareTriggeredMessage(input);
  const config = await getPublicMessageConfig();
  if (!config.enabled || !config.configured) throw new Error("messaging_not_configured");
  return messageCostRial(input.channel, prepared.recipient.body, config.rate);
}

/**
 * Queue one event message. This is intentionally the furthest this executor
 * goes: it writes campaign/recipient/outbox rows and lets runMessagingTick
 * own credit reservation, provider I/O, retry and accounting.
 */
export async function queueTriggeredMessageCampaign(input: TriggeredMessageInput): Promise<{ campaignId: string; costRial: number }> {
  const prepared = await prepareTriggeredMessage(input);
  const config = await getPublicMessageConfig();
  if (!config.enabled || !config.configured) throw new Error("messaging_not_configured");
  let projectId: string | null = null;
  if (input.projectId) {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM ai_projects WHERE business_id = $1 AND id = $2 AND archived_at IS NULL`, [input.businessId, input.projectId],
    );
    if (!rows[0]) throw new Error("project_not_found");
    projectId = rows[0].id;
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: campaigns } = await client.query<{ id: string }>(
      `INSERT INTO message_campaigns
         (business_id, channel, name, template_id, segment_id, project_id, triggered_by, status, total_recipients, started_at)
       VALUES ($1, $2, $3, $4, NULL, $5, $6, 'sending', 1, now()) RETURNING id`,
      [input.businessId, input.channel, input.triggerLabel.slice(0, 200), prepared.template.id, projectId, "همکار هوشمند"],
    );
    const campaignId = campaigns[0].id;
    const { rows: recipients } = await client.query<{ id: string }>(
      `INSERT INTO message_recipients (business_id, campaign_id, customer_id, channel, address, subject, body)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [input.businessId, campaignId, prepared.recipient.customerId, input.channel, prepared.recipient.address, prepared.recipient.subject, prepared.recipient.body],
    );
    await client.query(
      `INSERT INTO message_outbox (business_id, recipient_id, campaign_id, status, next_attempt_at)
       VALUES ($1, $2, $3, 'queued', now())`, [input.businessId, recipients[0].id, campaignId],
    );
    await client.query("COMMIT");
    return { campaignId, costRial: messageCostRial(input.channel, prepared.recipient.body, config.rate) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function loadPointsMap(businessId: string, customerIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (customerIds.length === 0) return map;
  const { rows } = await query<{ customer_id: string; points: string | number }>(
    `SELECT customer_id, coalesce(sum(points), 0) AS points
       FROM customer_points
      WHERE business_id = $1 AND customer_id = ANY($2::uuid[])
        AND (expires_at IS NULL OR expires_at >= current_date)
      GROUP BY customer_id`,
    [businessId, customerIds],
  );
  for (const r of rows) map.set(r.customer_id, Math.max(0, Number(r.points)));
  return map;
}

/** The store-credit equivalent of `loadPointsMap`, reconstructed from its event ledger in one query. */
async function loadStoreCreditMap(businessId: string, customerIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (customerIds.length === 0) return map;
  const { rows } = await query<{ customer_id: string; balance: string | number }>(
    `SELECT payload->>'customerId' AS customer_id,
            coalesce(sum(CASE WHEN event_type = 'loyalty.store_credit_issued'
                              THEN (payload->>'amount')::bigint
                              WHEN event_type = 'loyalty.store_credit_used'
                              THEN -(payload->>'amount')::bigint
                              ELSE 0 END), 0)::text AS balance
       FROM domain_events
      WHERE business_id = $1
        AND payload->>'customerId' = ANY($2::text[])
        AND event_type IN ('loyalty.store_credit_issued', 'loyalty.store_credit_used')
      GROUP BY payload->>'customerId'`,
    [businessId, customerIds],
  );
  for (const row of rows) map.set(row.customer_id, Math.max(0, Number(row.balance)));
  return map;
}

/** Pause a campaign mid-flight: nothing else is sent; queued rows stay queued. */
export async function pauseMessageCampaign(businessId: string, campaignId: string): Promise<void> {
  await query(
    `UPDATE message_campaigns SET status = 'paused', updated_at = now()
      WHERE business_id = $1 AND id = $2 AND status = 'sending'`,
    [businessId, campaignId],
  );
}

/** Continue only the untouched queue rows of a paused campaign; recipients are never rebuilt. */
export async function resumeMessageCampaign(businessId: string, campaignId: string): Promise<void> {
  await query(
    `UPDATE message_campaigns SET status = 'sending', updated_at = now()
      WHERE business_id = $1 AND id = $2 AND status = 'paused'
        AND EXISTS (SELECT 1 FROM message_outbox o
                     WHERE o.business_id = message_campaigns.business_id
                       AND o.campaign_id = message_campaigns.id
                       AND o.status = 'queued')`,
    [businessId, campaignId],
  );
}

/**
 * The attributable commercial result of message campaigns. A row appears only
 * when the campaign owns a dedicated promotion: this is the anti-guessing
 * boundary for ROI. A recipient, segment match, coupon-looking body, or later
 * purchase is never evidence that a campaign caused that purchase.
 *
 * Spend is read from the posted accounting document rather than recalculated
 * from today's provider rate. Revenue is the net total of completed sales that
 * actually applied the campaign's dedicated promotion after the campaign was
 * started; a sale is counted once even where the promotion touched many lines.
 */
export interface MessageCampaignRoiRow {
  campaignId: string;
  campaignName: string;
  promotionId: string;
  promotionName: string;
  sentCount: number;
  spentRial: number;
  attributableSales: number;
  attributableRevenueRial: number;
  discountRial: number;
  roiPercent: number | null;
}

/**
 * `attributionWindowDays` (Growth settings, issue #764) bounds how long after a
 * campaign starts a sale using its promotion still counts for it; `null` keeps
 * the old, unbounded reading. Defaults to the business's saved setting.
 */
export async function listMessageCampaignRoiReport(
  businessId: string,
  options: { attributionWindowDays?: number | null } = {},
): Promise<MessageCampaignRoiRow[]> {
  const attributionWindowDays =
    options.attributionWindowDays !== undefined
      ? options.attributionWindowDays
      : (await getGrowthSettings(businessId)).attributionWindowDays;
  const { rows } = await query<{
    campaignId: string;
    campaignName: string;
    promotionId: string;
    promotionName: string;
    sentCount: number;
    spentRial: string;
    attributableSales: string;
    attributableRevenueRial: string;
    discountRial: string;
  }>(
    `SELECT c.id AS "campaignId", c.name AS "campaignName",
            p.id AS "promotionId", p.name AS "promotionName", c.sent_count AS "sentCount",
            COALESCE(cost.spent_rial, 0)::text AS "spentRial",
            COALESCE(attribution.sales, 0)::text AS "attributableSales",
            COALESCE(attribution.revenue_rial, 0)::text AS "attributableRevenueRial",
            COALESCE(attribution.discount_rial, 0)::text AS "discountRial"
       FROM message_campaigns c
       JOIN promotions p ON p.id = c.promotion_id AND p.business_id = c.business_id
       LEFT JOIN LATERAL (
         SELECT SUM(jl.debit - jl.credit) AS spent_rial
           FROM journal_entries je
           JOIN journal_lines jl ON jl.entry_id = je.id
           JOIN accounts a ON a.id = jl.account_id
          WHERE je.business_id = c.business_id
            AND je.source_type = 'message_campaign' AND je.source_id = c.id
            AND a.code = '5600'
       ) cost ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS sales, COALESCE(SUM(o.total), 0) AS revenue_rial,
                COALESCE(SUM(applied.discount_rial), 0) AS discount_rial
           FROM (
             SELECT pa.source_id, SUM(pa.discount_rial) AS discount_rial
               FROM promotion_applications pa
              WHERE pa.business_id = c.business_id AND pa.promotion_id = c.promotion_id
                AND pa.created_at >= COALESCE(c.started_at, c.created_at)
                AND ($2::int IS NULL
                     OR pa.created_at < COALESCE(c.started_at, c.created_at) + make_interval(days => $2::int))
              GROUP BY pa.source_id
           ) applied
           JOIN orders o ON o.id = applied.source_id AND o.status = 'completed'
                         AND o.closed_at IS NOT NULL
       ) attribution ON true
      WHERE c.business_id = $1 AND c.promotion_id IS NOT NULL
      ORDER BY c.created_at DESC
      LIMIT 200`,
    [businessId, attributionWindowDays],
  );
  return rows.map((row) => {
    const spentRial = Number(row.spentRial);
    const attributableRevenueRial = Number(row.attributableRevenueRial);
    return {
      campaignId: row.campaignId,
      campaignName: row.campaignName,
      promotionId: row.promotionId,
      promotionName: row.promotionName,
      sentCount: Number(row.sentCount),
      spentRial,
      attributableSales: Number(row.attributableSales),
      attributableRevenueRial,
      discountRial: Number(row.discountRial),
      roiPercent: spentRial > 0 ? Math.round(((attributableRevenueRial - spentRial) / spentRial) * 10000) / 100 : null,
    };
  });
}
