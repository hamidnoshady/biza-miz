"use client";

/**
 * The «ساختار سازمانی» card on a customer file — issue #1128 §A.
 *
 * An agency rarely sells to one legal person: it sells to «گروه صنعتی مهر», talks
 * to the brand manager at «مهر فود», and prices a campaign for «مهر کیمیا». The
 * relationship ring beside this card shows those three as spokes of one flat
 * picture, where a brand and a contact are the same kind of thing. This card is
 * the hierarchy the ring deliberately does not draw: who the group is, which
 * parties are its brands, and what each brand is carrying.
 *
 * ## Why the counts are the card
 *
 * A tree of names is a filing cabinet. What makes the structure worth a card is
 * the work hanging off each brand, because that is the question the shape exists
 * to answer: «مهر فود» has two open opportunities and one sent proposal, «مهر کیمیا»
 * has a signed contract — so the member pricing a new offer knows which brand's
 * relationship they are inside, and 0274's and 0276's triggers (which refuse to
 * price one client's brief for another) have a visible counterpart rather than
 * arriving as a refusal nobody expected.
 *
 * Campaigns *are* counted now, and the history of that word is the interesting
 * part. This card shipped in wave 8 refusing to render a campaign count at all,
 * because the only table it could have counted — `growth_campaigns` — has no client
 * column and, reading #901's builder, could not be given one honestly: it is a
 * retail cashback automation whose party is the shopper earning money back.
 * Rendering «۰ کمپین» on every row would have stated that no brand has campaigns,
 * which absent data does not say. Migration 0278 added the register that *can*
 * answer, and §A's "concurrent campaigns" is now here — with the in-flight subset
 * broken out, because "two of this brand's campaigns are live now" and "this brand
 * has had two campaigns" are different answers to the same question.
 *
 * ## Conflicts are shown, never resolved
 *
 * Two members recording the same hierarchy from their own ends produce a cycle,
 * and a re-parenting recorded by adding an edge rather than removing the old one
 * produces a brand with two claimed groups. The resolver picks the newest claim
 * so the picture is drawable at all, and says it did: a card that quietly chose a
 * winner would be the reason nobody ever fixed the record.
 *
 * ## Read-only, and invisible when there is nothing to say
 *
 * Edges are created and removed through the «ارتباط‌ها» card, which already gates
 * writes and audits them; a second write path here would be a second place to get
 * both wrong. And a party that is not part of a group — the common case — renders
 * no card at all rather than one saying «بدون برند», because an empty card on
 * every file teaches people to skip this one.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Building2Icon } from "lucide-react";
import { toPersianDigits } from "@/lib/digits";
// The pure half is safe to import from a client component — no `db`, no `next/*` —
// so the depth limit the resolver enforces is the same one this card reports, and
// neither can drift.
import { ORG_DEPTH_LIMIT } from "@/lib/crm-org-structure";
import { LoadingSkeleton, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, InfoBox } from "@/app/dashboard/ui";
import { crmCustomerHref } from "./crm-routes";
import { CrmCardHeading } from "./crm-card-heading";

/* ------------------------------------------------------------------------- */
/* Wire shape                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Declared here rather than imported: the service module imports `db`, and a
 * client component that reached through it would drag `pg` into the browser
 * bundle. The pure half of this — `crm-org-structure.ts` — is importable, but its
 * vocabulary is not what crosses the wire, so there is nothing to share.
 */
interface OrgMemberWire {
  partyId: string;
  name: string;
  depth: number;
  parentId: string | null;
  isFocus: boolean;
  childIds: string[];
  contestedParent: boolean;
  work: {
    deals: number;
    briefs: number;
    proposals: number;
    acceptedProposals: number;
    contracts: number;
    campaigns: number;
    campaignsInFlight: number;
  };
}

interface OrgConflictWire {
  kind: "two_parents" | "cycle";
  partyId: string;
  involvedPartyIds: string[];
}

interface OrganizationWire {
  focusId: string;
  focusName: string;
  groupId: string;
  groupName: string;
  isBrand: boolean;
  members: OrgMemberWire[];
  ancestorIds: string[];
  descendantIds: string[];
  conflicts: OrgConflictWire[];
  depthLimited: boolean;
  isEmpty: boolean;
}

/* ------------------------------------------------------------------------- */
/* Copy                                                                       */
/* ------------------------------------------------------------------------- */

/**
 * The work one brand is carrying, as a sentence rather than a grid of zeros.
 *
 * Only the registers that have something in them are named: a row reading
 * «۰ فرصت · ۰ بریف · ۰ پیشنهاد · ۰ قرارداد» says nothing four times and pushes
 * the one figure that matters off the screen.
 */
function workSummary(member: OrgMemberWire): string | null {
  const parts: string[] = [];
  const { deals, briefs, proposals, acceptedProposals, contracts, campaigns, campaignsInFlight } =
    member.work;
  if (deals > 0) parts.push(`${toPersianDigits(deals)} فرصت`);
  if (briefs > 0) parts.push(`${toPersianDigits(briefs)} بریف`);
  if (proposals > 0) {
    parts.push(
      acceptedProposals > 0
        ? `${toPersianDigits(proposals)} پیشنهاد (${toPersianDigits(acceptedProposals)} پذیرفته‌شده)`
        : `${toPersianDigits(proposals)} پیشنهاد`,
    );
  }
  if (contracts > 0) parts.push(`${toPersianDigits(contracts)} قرارداد`);
  if (campaigns > 0) {
    // The in-flight figure first, because it is the one a member acts on: a brand
    // with two campaigns live right now is a brand somebody is servicing this week.
    parts.push(
      campaignsInFlight > 0
        ? `${toPersianDigits(campaignsInFlight)} کمپین در جریان (از ${toPersianDigits(campaigns)})`
        : `${toPersianDigits(campaigns)} کمپین`,
    );
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * A contradiction in the recorded structure, in words a member can act on.
 *
 * Named parties rather than a code, because the fix is to open one of those files
 * and delete an edge — and «two_parents» on its own does not tell anybody which.
 */
function conflictText(
  conflict: OrgConflictWire,
  nameOf: (partyId: string) => string,
): string {
  const names = conflict.involvedPartyIds.map(nameOf).join(" و ");
  if (conflict.kind === "two_parents") {
    return `«${nameOf(conflict.partyId)}» زیرمجموعهٔ چند سازمان مادر ثبت شده است (${names}). تازه‌ترین ارتباط ملاک این نمایش است؛ ارتباط کهنه را از کارت «ارتباط‌ها» حذف کنید.`;
  }
  return `میان ${names} حلقه ثبت شده است: هر کدام سازمان مادر دیگری است، پس بالاترین سطح را نمی‌توان تشخیص داد. یکی از این دو ارتباط را حذف کنید.`;
}

/* ------------------------------------------------------------------------- */
/* The card                                                                   */
/* ------------------------------------------------------------------------- */

export function CustomerOrganizationCard({ customerId }: { customerId: string }) {
  const [organization, setOrganization] = useState<OrganizationWire | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    const { ok, data, aborted } = await api<{
      organization?: OrganizationWire;
      error?: string;
    }>(`/api/crm/customers/${customerId}/organization`);
    if (aborted) return;
    setLoading(false);
    if (!ok || !data.organization) {
      // A 404 here means "this party is not yours", which is not this card's
      // story to tell: the file around it has already answered that.
      setFailed(true);
      setOrganization(null);
      return;
    }
    setOrganization(data.organization);
  }, [customerId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <SectionCard title={<CrmCardHeading kicker="گروه و برندها" title="ساختار سازمانی" />}>
        <LoadingSkeleton rows={2} label="در حال بارگذاری ساختار سازمانی" />
      </SectionCard>
    );
  }

  // Not part of a group: no card at all, rather than one saying «بدون برند».
  if (failed || !organization || organization.isEmpty) return null;

  const nameOf = (partyId: string): string =>
    organization.members.find((member) => member.partyId === partyId)?.name ?? "";

  return (
    <SectionCard
      title={<CrmCardHeading kicker="گروه و برندها" title="ساختار سازمانی" />}
      description={
        organization.isBrand
          ? `این پرونده یکی از برندهای «${organization.groupName}» است. کار هر برند جدا شمرده می‌شود.`
          : "برندهای این گروه و کاری که هرکدام در جریان دارد."
      }
      actions={
        organization.isBrand && organization.groupId !== organization.focusId ? (
          <Link
            href={crmCustomerHref(organization.groupId)}
            className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
          >
            <Building2Icon className="size-4" aria-hidden="true" />
            پروندهٔ «{organization.groupName}»
          </Link>
        ) : null
      }
    >
      <ul className="space-y-1.5">
        {organization.members.map((member) => {
          const work = workSummary(member);
          return (
            <li
              key={member.partyId}
              // Inline-start, not left: the file is RTL and a hard-coded side
              // would indent the tree the wrong way round.
              style={{ paddingInlineStart: member.depth * 20 }}
              className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/60 py-1.5 last:border-0"
            >
              {member.depth > 0 ? (
                <span aria-hidden="true" className="text-muted-foreground">
                  └
                </span>
              ) : null}
              <Link
                href={crmCustomerHref(member.partyId)}
                className="font-medium hover:underline"
              >
                {member.name || "—"}
              </Link>
              {member.isFocus ? (
                <StatusBadge tone="active">پروندهٔ جاری</StatusBadge>
              ) : null}
              {member.childIds.length > 0 && !member.isFocus ? (
                <span className="text-xs text-muted-foreground">
                  {toPersianDigits(member.childIds.length)} زیرمجموعه
                </span>
              ) : null}
              {member.contestedParent ? (
                <StatusBadge tone="danger">مادرِ مورد مناقشه</StatusBadge>
              ) : null}
              {work ? (
                <span className="text-xs text-muted-foreground">{work}</span>
              ) : (
                <span className="text-xs text-muted-foreground">کاری ثبت نشده</span>
              )}
            </li>
          );
        })}
      </ul>

      {organization.conflicts.length > 0 ? (
        <div className="mt-3 space-y-1.5">
          {organization.conflicts.map((conflict, index) => (
            <ErrorBox key={`${conflict.kind}-${index}`}>
              {conflictText(conflict, nameOf)}
            </ErrorBox>
          ))}
        </div>
      ) : null}

      {organization.depthLimited ? (
        // Reported rather than silently truncated: a tree that stops without
        // saying so is a different tree from the one on record, and a member
        // counting brands from it would be short.
        <div className="mt-3">
          <InfoBox>
            این ساختار از {toPersianDigits(ORG_DEPTH_LIMIT)} سطح عمیق‌تر است و
            ادامهٔ آن نمایش داده نمی‌شود. چنین عمقی معمولاً یعنی یک ارتباط
            اشتباه ثبت شده است.
          </InfoBox>
        </div>
      ) : null}
    </SectionCard>
  );
}
