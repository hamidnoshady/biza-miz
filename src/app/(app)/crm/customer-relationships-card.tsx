"use client";

/**
 * The «ارتباط‌ها» card on a customer file.
 *
 * Shows who this person is connected to — the company they are a contact of,
 * the household they share, who referred them — and lets staff add or remove a
 * link.
 *
 * Two things it deliberately does not do:
 *
 * - **It does not offer a merge.** Two records that turn out to be the same
 *   person are a duplicates problem, handled on its own screen behind its own
 *   permission. Putting an irreversible action next to a reversible one
 *   invites the wrong click.
 * - **It does not invent a party.** The picker only links records that already
 *   exist. Creating a customer as a side effect of describing a relationship
 *   is how half-empty records get into the directory.
 *
 * An edge has a direction, and this card is always on one end of it. The
 * `inverse` flag the API returns says which end, so the label reads correctly
 * from whichever file you opened — «مخاطب شرکت الف» on the person, «مخاطب» on
 * the company.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toPersianDigits } from "@/lib/digits";
import { formatPhoneDisplay } from "@/lib/phone";
import {
  RELATIONSHIP_INVERSE_LABELS,
  RELATIONSHIP_KINDS,
  RELATIONSHIP_LABELS,
  type PartyRelationship,
  type RelationshipKind,
  // From crm-shared, not the service: the service imports `db`, and a client
  // component pulling that in drags `pg` into the browser bundle.
} from "@/lib/crm-shared";
import { EmptyState, LoadingSkeleton, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, errorMessage, inputClass } from "@/app/dashboard/ui";
import { crmCustomerHref } from "./crm-routes";
import { useCustomerSearch, type CustomerSearchMatch } from "./customer-search";
import { CrmCardHeading } from "./crm-card-heading";
import { CrmRelationshipRing } from "./crm-relationship-ring";

type Match = CustomerSearchMatch;

const ERROR_TEXT: Record<string, string> = {
  self_link: "نمی‌توان یک شخص را به خودش متصل کرد.",
  already_linked: "این ارتباط از پیش ثبت شده است.",
  not_found: "یکی از دو طرف پیدا نشد.",
  invalid_kind: "نوع ارتباط معتبر نیست.",
};

export function CustomerRelationshipsCard({
  customerId,
  customerName,
  canManage,
}: {
  customerId: string;
  /** The name at the centre of the ring — the file's own name, already loaded. */
  customerName: string;
  canManage: boolean;
}) {
  const [links, setLinks] = useState<PartyRelationship[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [kind, setKind] = useState<RelationshipKind>("contact_of");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Match | null>(null);
  const [saving, setSaving] = useState(false);

  // Debounced, and aborted when superseded — the same hook every CRM picker
  // uses. `excludeId` is this card's «the other end of a link is never this
  // same record» rule: filtering here keeps the "cannot link to self" error
  // off a path the user can see coming.
  const { matches, searched } = useCustomerSearch(query, { excludeId: customerId });

  const load = useCallback(async () => {
    setFailed(false);
    const { ok, data } = await api<{ relationships: PartyRelationship[] }>(
      `/api/crm/customers/${customerId}/relationships`,
    );
    if (!ok) {
      setFailed(true);
      return;
    }
    setLinks(data.relationships ?? []);
  }, [customerId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit() {
    if (!picked || saving) return;
    setSaving(true);
    setError(null);
    const { ok, data } = await api<{ error?: string }>(
      `/api/crm/customers/${customerId}/relationships`,
      {
        method: "POST",
        body: JSON.stringify({ toPartyId: picked.id, kind }),
      },
    );
    setSaving(false);
    if (!ok) {
      setError(ERROR_TEXT[data.error ?? ""] ?? errorMessage(data.error));
      return;
    }
    setAdding(false);
    setPicked(null);
    setQuery("");
    await load();
  }

  async function remove(id: string) {
    const { ok } = await api(
      `/api/crm/customers/${customerId}/relationships?relationshipId=${id}`,
      { method: "DELETE" },
    );
    if (ok) await load();
  }

  return (
    <SectionCard
      title={
        <CrmCardHeading kicker="شبکهٔ ارتباط" title="ارتباط‌ها" />
      }
      description="این شخص با چه کسان دیگری در ارتباط است."
      actions={
        canManage && !adding ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
            افزودن ارتباط
          </Button>
        ) : null
      }
    >
      {adding ? (
        <div className="mb-3 space-y-2 rounded-lg border border-border/80 p-3">
          {error ? <ErrorBox>{error}</ErrorBox> : null}
          <div className="flex flex-wrap gap-2">
            <select
              className={`${inputClass} w-44`}
              value={kind}
              onChange={(e) => setKind(e.target.value as RelationshipKind)}
              aria-label="نوع ارتباط"
            >
              {RELATIONSHIP_KINDS.map((option) => (
                <option key={option} value={option}>
                  {RELATIONSHIP_LABELS[option]}
                </option>
              ))}
            </select>
            <input
              className={`${inputClass} min-w-48 flex-1`}
              placeholder="جست‌وجوی شخص…"
              value={picked ? picked.name : query}
              onChange={(e) => {
                setPicked(null);
                setQuery(e.target.value);
              }}
              aria-label="طرف دیگر ارتباط"
            />
          </div>

          {!picked && matches.length > 0 ? (
            <ul className="max-h-40 divide-y divide-border/80 overflow-y-auto text-sm">
              {matches.map((match) => (
                <li key={match.id}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 py-2 text-start hover:underline"
                    onClick={() => setPicked(match)}
                  >
                    <span className="truncate text-foreground">{match.name}</span>
                    {match.phone ? (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {toPersianDigits(formatPhoneDisplay(match.phone))}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {!picked && searched && matches.length === 0 ? (
            <p className="text-xs text-muted-foreground">شخصی با این نام پیدا نشد.</p>
          ) : null}

          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={!picked || saving} onClick={submit}>
              ثبت ارتباط
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setAdding(false);
                setPicked(null);
                setQuery("");
                setError(null);
              }}
            >
              انصراف
            </Button>
          </div>
        </div>
      ) : null}

      {!links && failed ? (
        <div className="space-y-2">
          <EmptyState>بارگذاری ارتباط‌ها ناموفق بود.</EmptyState>
          <Button type="button" variant="outline" size="sm" onClick={load}>
            تلاش دوباره
          </Button>
        </div>
      ) : !links ? (
        <LoadingSkeleton rows={2} />
      ) : links.length === 0 ? (
        <EmptyState>ارتباطی ثبت نشده است.</EmptyState>
      ) : (
        <>
          <div className="mb-3 border-b border-border/60 pb-3">
            <CrmRelationshipRing centre={{ id: customerId, name: customerName }} links={links} />
          </div>
          <ul className="divide-y divide-border/80 text-sm">
            {links.map((link) => {
              // Read the edge from this file's end: on the far party's file the
              // same row has to say the opposite thing.
              const otherId = link.inverse ? link.fromPartyId : link.toPartyId;
              const otherName = link.inverse ? link.fromName : link.toName;
              const label = link.inverse
                ? RELATIONSHIP_INVERSE_LABELS[link.kind]
                : RELATIONSHIP_LABELS[link.kind];
              return (
                <li key={link.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <Link href={crmCustomerHref(otherId)} className="text-foreground hover:underline">
                      {otherName}
                    </Link>
                    <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <StatusBadge tone="neutral">{label}</StatusBadge>
                      {link.roleTitle ? <span>{link.roleTitle}</span> : null}
                      {link.isPrimary ? <StatusBadge tone="active">اصلی</StatusBadge> : null}
                    </p>
                  </div>
                  {canManage ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`حذف ارتباط با ${otherName}`}
                      onClick={() => remove(link.id)}
                    >
                      <Trash2Icon aria-hidden="true" className="size-4" />
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </SectionCard>
  );
}
