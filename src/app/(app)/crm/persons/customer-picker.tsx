"use client";

/**
 * Search-and-open for the customer file (Phase 36).
 *
 * Deliberately thin: the debounced `/api/parties` search lives in the shared
 * `useCustomerSearch` hook (the same one the activity, ticket and deal dialogs
 * pick with), so there is one definition of "find a customer by what someone
 * typed" — this screen only adds its own presentation: results as links that
 * open the 360° file, with each person's phone beside their name.
 */

import { useState } from "react";
import Link from "next/link";
import { toPersianDigits } from "@/lib/digits";
import { formatPhoneDisplay } from "@/lib/phone";
import { EmptyState, LoadingSkeleton } from "@/app/dashboard/page-chrome";
import { inputClass } from "@/app/dashboard/ui";
import { crmCustomerHref } from "../crm-routes";
import { useCustomerSearch } from "../customer-search";

export function CustomerPicker({ directoryHref }: { directoryHref: string }) {
  const [query, setQuery] = useState("");
  // `searched` is what separates «type at least two characters» from «searched
  // and found nobody» — the question a person looking at an empty list is
  // actually asking.
  const { matches, searching, searched } = useCustomerSearch(query);

  return (
    <div className="space-y-3">
      <input
        className={inputClass}
        placeholder="جستجو با نام یا تلفن…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />

      {searching ? (
        <LoadingSkeleton rows={3} compact label="در حال جست‌وجوی مشتری" />
      ) : !searched ? (
        <p className="text-xs text-muted-foreground">
          حداقل دو نویسه بنویسید. برای مدیریت فهرست کامل،{" "}
          <Link href={directoryHref} className="underline">
            فهرست مشتریان
          </Link>{" "}
          را باز کنید.
        </p>
      ) : matches.length === 0 ? (
        <EmptyState>مشتری‌ای با این مشخصات پیدا نشد.</EmptyState>
      ) : (
        <ul className="divide-y divide-border/80 text-sm">
          {matches.map((match) => (
            <li key={match.id} className="py-2.5">
              <Link href={crmCustomerHref(match.id)} className="hover:underline">
                <span className="font-medium text-foreground">{match.name}</span>
                {match.phone ? (
                  <span className="ms-2 text-xs text-muted-foreground">
                    {toPersianDigits(formatPhoneDisplay(match.phone))}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
