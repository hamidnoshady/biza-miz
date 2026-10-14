# Accounting terminology — standard vocabulary

Reference glossary for Persian accounting terms used across this codebase's ledger/reports/
jewelry/inventory-costing/setup-wizard UI. Established as the Wave 3 baseline of #160
(`docs/phases/Phase-22-Accounting-Standards-Compliance-Gap-Analysis.md`, §3/§9). Per the
epic's §9 requirement, **run the checklist at the bottom of this file before opening any
future wave's PR that touches accounting-adjacent UI copy.**

## Reference table

| Concept | Standard term | Notes |
|---|---|---|
| Account hierarchy — group | گروه | Wave 2, `chart-of-accounts-section.tsx` only |
| Account hierarchy — general ledger account | حساب کل (کل) | Wave 2 |
| Account hierarchy — subsidiary ledger account | حساب معین (معین) | Wave 2. Don't introduce a "دفتر معین" *page* — that's Wave 5 scope, not a labeling fix |
| Account hierarchy — detail ledger account | حساب تفصیلی (تفصیلی) | Wave 2 |
| Debit / debit-natured | بدهکار | |
| Credit / credit-natured | بستانکار | Never "کم شدن"/"اضافه شدن" for a debit/credit column |
| Contra account | حساب کاهنده | Suffix form: «(کاهنده)» next to the account name |
| Accounting voucher / journal entry | سند حسابداری, یا کوتاه: سند | Not «رسید» or «فاکتور» unless it genuinely is a receipt/invoice (e.g. a goods-receipt note, a supplier bill) |
| Recording a manual entry (the action) | ثبت سند (دستی) | Not «ایجاد سند» — pick one verb and keep it |
| Approving a draft entry (the action) | تأیید | Not «تصویب» — the codebase has standardized on تأیید (see `PERMISSIONS.ledgerApprove` → «تأیید سند») |
| General journal (chronological) | دفتر روزنامه | `entries-section.tsx` |
| General ledger book (per-account) | دفتر کل | Not yet a dedicated page — Wave 5 scope (§7.3) |
| Trial balance | تراز آزمایشی | |
| Balance sheet | ترازنامه | |
| Profit & loss / income statement | صورت سود و زیان | |
| Cash flow statement | صورت گردش وجوه نقد (short form: «گردش وجوه نقد») | Verified consistent across `reports.ts`, `ledger-report-view.tsx`, `api/reports/export/route.ts` — keep using this exact phrase, don't introduce «صورت جریان نقدی» or similar alternates |
| Accounts receivable | حساب‌های دریافتنی | |
| Accounts payable | حساب‌های پرداختنی | |
| Retained earnings | سود (زیان) انباشته | |
| Owners' equity (account type) | حقوق صاحبان سرمایه | Wave 3 fix: `accounts-settings.tsx` said «حقوق مالکانه» and `setup/accounts/page.tsx` said «سرمایه» — both now match `chart-of-accounts-section.tsx`/`trial-balance-section.tsx` |
| Balance (of an account) | مانده | |
| Turnover / movement (an account's activity in a period) | گردش | No dedicated «گردش حساب» statement page yet — Wave 5 scope |
| Opening / closing | افتتاحیه / اختتامیه | |
| System / non-deletable account | سیستمی (badge) | `chart-of-accounts-section.tsx` only, Wave 2 |
| Vague status label | Avoid bare «وضعیت» where the referent isn't obvious from context | Use «وضعیت سند», «وضعیت تطبیق», etc. A table column literally titled by its row entity (e.g. a «دوره» table's «وضعیت» column) is fine as-is |

## Checklist — run before every wave's PR (#160 §9)

1. Grep the diff's Persian string literals for: رسید, فاکتور, تایید/تصویب, ثبت سند vs ایجاد
   سند, معین/تفصیلی, دفتر کل/دفتر معین, جریان/گردش وجوه نقد, وضعیت (bare).
2. For every new or changed label naming an account type, a statement, or an action on a
   سند, check it against the table above instead of inventing new wording.
3. If the same concept is labeled in more than one file, grep for the concept across the
   whole `src/app/(app)/accounting`, `src/app/(app)/reports`, `src/app/setup/{accounts,tax}`,
   and `src/app/(app)/settings/accounts-settings.tsx` and confirm every occurrence agrees.
   (The chart of accounts has exactly one editor — `/accounting/chart-of-accounts`
   (`chart-of-accounts-section.tsx`, plus its statement and history panels). The
   platform settings tab is a shortcut to it since issue #824; do not add a second
   place that spells these labels out.)
4. Don't touch `src/lib/coa-template.ts` account names/codes for a terminology fix — renaming
   ledger account data is a migration concern, tracked separately from UI-copy wording.
5. If you introduce a genuinely new concept with no entry above, add it to this table in the
   same PR so the next wave doesn't have to re-derive it.
