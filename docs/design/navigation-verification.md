# Navigation verification — ESH-205 / #1541

**Parent:** ESH-108 / #1081 · **Source audit:** [`route-audit.md`](route-audit.md) §3, findings N1–N4
**Measured:** `main` at `49b0acf16`, 2026-11-24.
**Scope:** keyboard interaction and browser history across the four application
shells; the shell map itself is documented in
[`docs/design-system.md`](../design-system.md) § "Navigation architecture — the
shell map".

This record is evidence, not a new UI contract. It changes no route, permission,
sidebar layout or shell. Two defects were found and filed as follow-ups; neither
is fixed here.

## Environment and method

- A production build of this tree, served locally on `http://localhost:3005`.
- PostgreSQL 16.14 seeded with `npm run db:seed`; signed in as the seeded
  `owner` (`owner@example.com`). A verification-only tenant with
  `deployment.profile = cloud` and `DEPLOYMENT_ROLE=central`, because the
  seeded local profile deliberately gates Growth & Marketing and Website
  Management behind a cloud connection. Nothing was verified against
  production.
- Chromium (Playwright) scripted checks; desktop viewport 1440×900 and phone
  viewport 390×844 with touch and `isMobile`. Light theme.
- Each check records the route, the keyboard action, expected behaviour, actual
  behaviour and outcome. The full observed values are quoted below.

**Legend:** PASS = expected and actual agree; FAIL = a real difference, filed as a
follow-up (never fixed inside this documentation task).

## Summary

Every check below has an explicit expected/actual pair. Two defects were found —
both filed as follow-ups, neither fixed here.

| Area | Outcome |
| --- | --- |
| App switcher (workspace rail) keyboard | Tab order and Enter pass; focus after launch fails (#1553) |
| Sidebar navigation and focus | Pass |
| Browser Back/Forward | Pass |
| Navigation between app areas | Pass |
| `/accounting/products` + sub-sections | Pass |
| Accounting directory `?view=` | Bare/customers/suppliers pass; `?view=all` fails (#1554) |
| CRM directory `?view=` | Pass (the parameter is not a CRM filter; wording correction) |
| `SectionNav` (rail + strip) | Pass |
| Standalone settings route | Pass |
| Phone drawer, app switcher, `SectionNav` | Pass except focus after Escape (#1553) |
| Logged-in landing | Pass |

**Result:** 22 of the 24 scripted assertions passed; two additional focus
observations (heading-mount timing and drawer Escape) reproduced the same
first defect. Four failed observations, two root causes, two follow-ups.

## A. App switcher — workspace rail (desktop)

**Routes:** `/dashboard` → `/growth/overview` (and each launcher in §D).

| # | Keyboard action | Expected | Actual | Outcome |
| --- | --- | --- | --- | --- |
| A1 | From the page, Tab through the rail | Header controls, then the six rail links in order: دستیار هوشمند → میز کار من → حسابداری → ارتباط با مشتری → رشد و بازاریابی → مدیریت وب‌سایت; every focused link has a visible ring | The six links were reached in that order; every one had the amber 2px focus ring (`box-shadow` = `oklab(0.828 … / 0.45) 0 0 0 2px`). Order: credit, theme, collapse, notifications, then the six rail links, then «ابر» | PASS |
| A2 | Enter on «رشد و بازاریابی» | `/growth/overview`, the growth menu replaces the rail, one `aria-current="page"` row | URL `/growth/overview`; nav `بخش‌های رشد و بازاریابی`; active `/growth/overview` | PASS |
| A3 | Read focus after A2 | `document.activeElement.id === "page-heading"` | `BODY`; the heading exists but mounts after the focus window (~1.5 s after the route commits) | **FAIL — #1553** |
| A4 | Read focus after A2 again, at 0/500/1500/3000 ms | Focus on the destination heading | `BODY` at every sample; `main h1` is present from ~1500 ms for all four apps. The same-app case A6 does focus the heading | **FAIL — #1553** |

The rail is the platform's app switcher: it is drawn on `/dashboard` and the
shared platform surfaces, not inside an app. Switching apps is two hops (back to
«میز کار», then launch) by design.

## B. Sidebar navigation and focus (inside an app)

| # | Keyboard action | Expected | Actual | Outcome |
| --- | --- | --- | --- | --- |
| B1 | Focus «بازگشت به میز کار», then Tab | Next section link receives focus, ring visible | Focus moved to `/growth/overview` («میز کار رشد»); ring visible | PASS |
| B2 | Enter on «کمپین‌ها» (`/growth/campaigns`) | URL changes, exactly one active row, focus moves to the destination heading | URL `/growth/campaigns`; active `/growth/campaigns`; focus `H1#page-heading` (text «رشد و بازاریابی», the app shell heading) | PASS |

## C. Browser Back/Forward

| # | Action | Expected | Actual | Outcome |
| --- | --- | --- | --- | --- |
| C1 | After B2, browser Back, then Forward | Back `/growth/overview` with its row active; Forward `/growth/campaigns` with its row active; no double-active | Back: `/growth/overview`, active `/growth/overview`, focus `H1#page-heading`. Forward: `/growth/campaigns`, active `/growth/campaigns`, focus `H1#page-heading` | PASS |
| C2 | Products hub → prices, then Back | Prices active on the child; hub active after Back | `toPrices`: `/accounting/products/prices`, active `/accounting/products/prices`, focus heading «بروزرسانی قیمت‌ها». Back: `/accounting/products`, active `/accounting/products`, focus heading «محصولات» | PASS |

There is no double-active row in any state exercised. The query string survives
Back/Forward.

## D. Navigation between application areas

| Launcher | Resulting route | Sidebar label | Active row | Outcome |
| --- | --- | --- | --- | --- |
| حسابداری | `/accounting/overview` | `منوی حسابداری` | `/accounting/overview` | PASS |
| ارتباط با مشتری | `/crm/overview` | `بخش‌های ارتباط با مشتری` | `/crm/overview` | PASS |
| رشد و بازاریابی | `/growth/overview` | `بخش‌های رشد و بازاریابی` | `/growth/overview` | PASS |
| مدیریت وب‌سایت | `/websites/overview` | `بخش‌های مدیریت وب‌سایت` | `/websites/overview` | PASS |

Each app replaced the workspace rail with its own menu; at most one row was
active. Website Management stayed inside `/websites` with its CMS and WordPress
groups in one shell.

## E. `/accounting/products` and its sub-sections

All six routes are reachable and each lights **only its own** row; the hub is
exact, so it is not also active on a child.

| Route | `h1` | Active sidebar row | Outcome |
| --- | --- | --- | --- |
| `/accounting/products` | محصولات | `/accounting/products` | PASS |
| `/accounting/products/new` | افزودن محصول | `/accounting/products/new` | PASS |
| `/accounting/products/prices` | بروزرسانی قیمت‌ها | `/accounting/products/prices` | PASS |
| `/accounting/products/attributes` | ویژگی محصول | `/accounting/products/attributes` | PASS |
| `/accounting/products/barcode-templates` | بارکد و برچسب محصولات | `/accounting/products/barcode-templates` | PASS |
| `/accounting/products/reports` | گزارش‌های کالا | `/accounting/products/reports` | PASS |

`new` is the create action, not a section; the four section children are
`prices`, `attributes`, `barcode-templates`, `reports`. The route-file count (six
files) is therefore not the menu count (six rows including the hub); this is the
N1 lesson — count nav entries, not `page.tsx` files.

## F. Directory `?view=` filtering and active state

### Accounting — the directory that owns `?view=`

| URL | Active row | Outcome |
| --- | --- | --- |
| `/accounting/directory` | `/accounting/directory` («اشخاص») | PASS |
| `/accounting/directory?view=customers` | `/accounting/directory?view=customers` («مشتریان») | PASS |
| `/accounting/directory?view=suppliers` | `/accounting/directory?view=suppliers` («تأمین‌کنندگان») | PASS |
| `/accounting/directory?view=all` | none | **FAIL — #1554** |

The first three confirm the single-directory rule: one screen, one list, the
view is a filter, and the sidebar row follows it. `?view=all` is the same default
list as the bare address (the canonical link builder omits the parameter), but
`workspaceEntryIsActive` treats any present `view` as a named view and leaves no
row lit. Filed as #1554; not fixed here.

### CRM — no `?view=` filter

| URL | Active row | Screen | Outcome |
| --- | --- | --- | --- |
| `/crm/directory?view=customers` | `/crm/directory` («مشتریان») | CRM directory (`h1` «ارتباط با مشتری») | PASS (parameter ignored) |
| `/crm/directory?view=suppliers` | `/crm/directory` | CRM directory | PASS (parameter ignored) |

The audit and the child-1 wording describe `/crm/directory?view=` as a filter;
it is not. The one people directory with `?view=` is Accounting's
(`/accounting/directory`). CRM's directory deep link is `?customer=<id>` (and
`/crm/persons/<id>`); the rail row stays active on both because
`isCrmSectionPathname` owns the pathname, not a view parameter. This is a wording
correction, not a product defect; §3.4 of the audit now records it.

## G. `SectionNav` — strip, rail, phone drill-down

`SectionNav` is not a disclosure and not a router. On a desktop it is a pill
strip (`md`+) or a sticky rail (`lg`+); below its breakpoint it drills down one
level at a time. Where a screen wires a section to a route (settings), the URL
changes; where it keeps the section in state (the industry managers/reports), it
does not.

| # | Route / viewport | Action | Expected | Actual | Outcome |
| --- | --- | --- | --- | --- | --- |
| G1 | `/settings/business`, 1440 | Read the rail | A rail menu with one `aria-current="page"` row | Nav present, 20 buttons, active «کسب‌وکار و شعبه» | PASS |
| G2 | `/settings/business`, 1440 | Click «امنیت» | Route to `/settings/security-center`; Back returns to `/settings/business` | Security URL `/settings/security-center`; Back `/settings/business`; both focused the `تنظیمات` heading | PASS |
| G3 | `/accounting/reports`, 1440 | Read the strip | A real tablist: one `aria-selected="true"`, one `tabindex="0"` | 7 tabs, one selected, one tab stop | PASS |
| G4 | `/accounting/reports`, 1440 | ArrowLeft on the selected tab | Selection and focus move together; still one tab stop | Selected index 1, focused index 1, one tab stop | PASS |
| G5 | `/settings/business`, 390 | Deep-link into a section | Drilled-down panel with a visible «بازگشت»; list hidden | Back control «کسب‌وکار و شعبه بازگشت» visible; list hidden | PASS |
| G6 | `/settings`, 390 | Click back, then choose «امنیت» | Back goes to the settings list (`/settings`); choosing security opens `/settings/security-center` | `/settings` with 20 visible buttons; security opened `/settings/security-center` with its back bar | PASS |
| G7 | `/settings/security-center`, 390 | Phone Back | Returns to `/settings` (where the drill-down list lives) | `/settings` | PASS |

G6 is the controlled `open` contract: a deep-linked section starts drilled in;
closing it goes to the settings home, whose list is the menu. The URL is the
state, so Back is predictable.

## H. Standalone settings and phone shell

| # | Route / action | Expected | Actual | Outcome |
| --- | --- | --- | --- | --- |
| H1 | `/settings/profile` | A standalone page outside the settings tab body, with the workspace rail | URL `/settings/profile`, `h1` «حساب کاربری», rail `میز کار`, no app shell | PASS |
| H2 | `/dashboard`, 390 | Bottom bar hidden; menu button present | Bottom bar 0, «باز کردن منو» present | PASS |
| H3 | Open the phone drawer | Dialog with the rail: assistant, workspace, four apps | Dialog open; links include `/dashboard`, `/workspace`, the four app homes | PASS |
| H4 | Choose «ارتباط با مشتری» in the drawer | Drawer closes, lands on `/crm/overview`, CRM shell, bottom bar returns | URL `/crm/overview`, dialog gone, header «ارتباط با مشتری», bottom bar present | PASS |
| H5 | Close the drawer with Escape | Drawer closes; focus returns to the menu button | Dialog gone; focus `BODY` | **FAIL — #1553** |

The phone bottom bar is hidden on `/dashboard` and `/workspace` and returns
inside an app; it carries pinned business pages, not app sections. The drawer —
not the bottom bar — is the complete section list on a phone.

## Findings and follow-ups

| Finding | Severity | Reproduction | Issue |
| --- | --- | --- | --- |
| Focus stays on `BODY` after launching an app from the workspace rail (and after Escape closes the phone drawer) | P3 (a11y) | §A3/A4, §H5 | [#1553](https://github.com/hamidnoshady/biza-miz/issues/1553) |
| `/accounting/directory?view=all` leaves no directory row active | P3 | §F | [#1554](https://github.com/hamidnoshady/biza-miz/issues/1554) |

Both are reported with reproduction steps and remain open. No permission, route,
layout or shell was changed by this verification.

## Quality gates

Run on this tree after the documentation and audit-note changes:

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | **Passed** with `NODE_OPTIONS=--max-old-space-size=8192`. The default 4 GB heap OOMs on this 33 GB Windows machine; the type check itself reports no errors. |
| `npm test` | **Not green on this Windows host for environment reasons.** 1,619 test files / 19,851 tests passed, 23 failed in 10 files, 1 worker error. The failures are Windows-environment failures, not assertions about this change: `ci/required-gate` and `desktop-installer-staging` need a working `bash`/WSL (this host's `bash.exe` is WSL without `/bin/bash`), and the desktop staging/update tests hit `EPERM` on `%TEMP%` copies (antivirus/OneDrive). Six files that failed on suite-load timeouts (`industry-coverage`, `desktop-runtime-posture`, `checkout-idempotency`, `brand-coverage`, `ledger-source-labels`, `cheques-section`) pass when rerun; `client-bundle-boundary` passes with `--testTimeout=120000` (it scans the whole tree and needs ~40 s on this host, against a 15 s default). No navigation or documentation test failed. CI's Linux run is the authoritative `npm test`. |
| `npm run test:design` | **Passed** — 5 files / 47 tests (design lint, primitive lint, loading coverage, reference screenshots). |
| `npm run build` | **Passed** — `✓ Compiled successfully in 4.1min`, 921 static pages generated, standalone output written. |
| `npm run test:visual` | Not run: documentation-only change, no pixel change. A visual diff would mean the UI changed and must be reverted, not re-baselined. |

The verification server used a production build of the same tree. The build
gate was re-run after the documentation changes and passed. `npm run test:db`
was not run (it is not one of this issue's gates, and the verification database
is a throwaway seeded tenant).

## Not covered

- Screen-reader announcements beyond the accessible names and `aria-current` /
  `aria-selected` states read from the DOM.
- 200% zoom and keyboard-only operation with a screen reader.
- The Superadmin console (`src/app/platform/**`); it has its own identity and is
  a separate documented pass (N2).
- The Android TWA native shell, offline mode, and cross-device sync.
- The in-flight #909 navigation/loading work's own acceptance criteria; this
  record only checks the shell behaviour it touched (destination-heading focus).
