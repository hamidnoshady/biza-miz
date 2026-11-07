# Marketing targets and assignments (issue #900)

This increment adds Growth-owned prospect **sites** and operational assignments.
A site has a branch responsible for it, a label, city and neighborhood, and an
optional reference to an existing canonical party. The site is not a tenant
branch, a new customer, a CRM lead or a consent record. Parties are found via
the existing directory API; no party data is written by Growth. The target list
projects only whether a party is linked, not the party's private profile.

A manager can assign an active marketer and target in the same authorized branch,
set a date (displayed in Jalali) and move work from planned to in progress,
completed or canceled. Completion is only a task state, **not** evidence of a
visit, qualification, a conversion, or an accounting event. Only one open task
per marketer/target is allowed at a time; after completion/cancellation another
may be created. The status update locks the row, compares the expected prior
state and audits the change in the same transaction. Reassignment can be done by
canceling and creating a new task; the old record remains for history.

Targets use `marketing_targets.view/manage`; tasks use
`marketing_assignments.view/manage`. Creating targets also requires
`parties.view` (even for an unlinked site), because that flow can link the shared
directory. Management pickers reveal only the branch-scoped operational labels
and marketer names necessary to assign work. Owner/admin and manager receive
these keys; other roles do not by default. Custom roles need the corresponding
view and management keys for the pages. Directory access does not grant CRM
write, consent, Accounting or compensation permissions. Writes and lists use the
current membership's authorized active branches; composite foreign keys enforce
tenant and branch affinity even on direct writes. Both tables have forced tenant
RLS. Migration 0285 follows 0284; no data is backfilled.

Current boundaries: there is no duplicate-site review, team
hierarchy, precise address/coordinates, route planning, lead creation, consent,
verified attribution or evidence. Links to a party follow the surviving canonical
party on a CRM merge; archived party links still require review. Assignment pickers search active targets and marketers in the selected authorized
branch with independently paginated 20-item result sets. Changes in the underlying
records may shift offset-based pages; the server revalidates all selections on
submission. The assignment is made to the
canonical branch-authorized active staff membership (or an external roster
record), but does not grant an external contributor a login or a task queue. Site-specific hybrid contributor restrictions and offline synchronization
are not implemented. No personal GPS or continuous tracking is collected.

An initial, separate operator-reported lead touchpoint flow is described in
[marketing-touchpoints.md](marketing-touchpoints.md). It does not turn an
assignment into verified visit, conversion, sale or compensation evidence.

## Staff self-service (incremental)

The separate `marketing_assignments.self` capability opens «ماموریت‌های من».
It is not granted to floor roles by default; an owner may explicitly delegate it.
A current, active employee marketer sees only their own assignments in their
currently actionable active branches, even if they know another assignment ID.
Starting or completing own work uses a locked, expected-state transition and a
same-transaction audit record. Cancellation, assignment and reassignment remain
manager-owned; the capability does not imply team-wide assignments, the party
directory, CRM, compensation or financial access. An inactive marketer or member
and a branch revoked since assignment cannot access the task through this queue.
External roster records have no login and are not covered by this flow.

Completion is an employee's task-status report, not proof of a visit, location,
contact, conversion, consent or compensation. This does not provide check-in,
GPS, visit forms, offline synchronization, team hierarchy or self-service lead
creation. Hybrid site-specific restrictions beyond the existing actionable branch
scope still require implementation before using this as a site-scoped boundary.

### مدیریت چرخهٔ مقصد

کاربر دارای `marketing_targets.manage` می‌تواند عنوان، شهر و محلهٔ مقصد فعال را ویرایش کند یا مقصد را بایگانی و بازگردانی کند؛ شعبه و شخص CRM متصل از این مسیر تغییر نمی‌کنند. فهرست به‌صورت پیش‌فرض مقصدهای فعال را نشان می‌دهد و فیلتر بایگانی دارد. برای جلوگیری از ویرایش هم‌زمانِ قدیمی، هر تغییر نسخهٔ مشاهده‌شده را بررسی می‌کند. بایگانی با ماموریت برنامه‌ریزی‌شده یا در حال انجام مجاز نیست و با ساخت ماموریت هم‌زمان قفل‌گذاری می‌شود. تاریخچه حذف نمی‌شود، اما عنوان و مشخصات مقصد در نمایش‌های مرتبط اطلاعات جاری هستند نه تصویر ثابت تاریخی. تغییر و ثبت ممیزی در یک تراکنش انجام می‌شوند. این قابلیت بازدید یا شواهد مکانی تأییدشده ایجاد نمی‌کند.
