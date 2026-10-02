"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Building2Icon, CalculatorIcon, ContactRoundIcon, FolderKanbanIcon, MegaphoneIcon, ExternalLinkIcon, Globe2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api, ErrorBox, InfoBox, PlatformPageSkeleton } from "../../ui";

const DESTINATIONS = [
  { key: "workspace", href: "/platform/company/workspace", label: "فضای کاری من", icon: FolderKanbanIcon },
  { key: "accounting", href: "/platform/company/accounting", label: "حسابداری", icon: CalculatorIcon },
  { key: "crm", href: "/platform/company/crm", label: "ارتباط با مشتری", icon: ContactRoundIcon },
  { key: "growth", href: "/platform/company/growth", label: "رشد و بازاریابی", icon: MegaphoneIcon },
  { key: "websites", href: "/platform/company/websites", label: "مدیریت وب‌سایت", icon: Globe2Icon },
] as const;

type DestinationKey = (typeof DESTINATIONS)[number]["key"];
type Status = { error?: string; company: null | { business_id: string; name: string; subdomain: string; access_preset: string | null; is_active: boolean | null } };
type Member = { platformAdminId: string; fullName: string; email: string; preset: string | null; active: boolean; revision: number };
const PRESET_LABELS: Record<string, string> = {
  company_owner: "مالک شرکت", finance: "مالی", sales_success: "فروش و موفقیت مشتری",
  marketing: "بازاریابی", website_editor: "ویرایشگر وب‌سایت", project_manager: "مدیر پروژه",
};

export function CompanyWorkspace({ active, children }: { active?: DestinationKey; children?: React.ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const load = async () => {
    const result = await api<Status>("/api/platform/company/status");
    if (!result.ok) setError(result.data.error ?? "خواندن وضعیت فضای شرکت ناموفق بود.");
    else setStatus(result.data);
  };
  useEffect(() => { void load(); }, []);

  async function setup() {
    setCreating(true); setError("");
    const result = await api<{ company?: Status["company"]; error?: string }>("/api/platform/company/setup", { method: "POST" });
    setCreating(false);
    if (!result.ok) setError(result.data.error ?? "راه‌اندازی انجام نشد.");
    else await load();
  }

  if (!status && !error) return <PlatformPageSkeleton />;
  const company = status?.company;
  return (
    <div className="mx-auto w-full max-w-6xl space-y-5" dir="rtl">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-teal-500/15 text-teal-700 dark:text-teal-300"><Building2Icon className="size-5" /></span>
          <div>
            <h1 className="text-xl font-bold">کسب‌وکار پلتفرم</h1>
            <p className="mt-1 text-sm text-muted-foreground">فضای عملیاتی داخلی شرکت؛ جدا از مدیریت زیرساخت و مشتریان پلتفرم</p>
          </div>
        </div>
        <Link className="text-sm text-primary hover:underline" href="/platform">بازگشت به مدیریت پلتفرم</Link>
      </header>

      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {!company ? (
        <section className="rounded-2xl border border-border bg-card p-5">
          <h2 className="font-bold">فضای داخلی هنوز راه‌اندازی نشده است</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">این عملیات یک کسب‌وکار محافظت‌شده با پروفایل خدمات و SaaS، حساب‌های اولیه، چهار برنامه و میز کار ایجاد می‌کند. اجرای دوباره امن است و داده یا مانده افتتاحیه را بازنویسی نمی‌کند.</p>
          <Button className="mt-4" onClick={setup} disabled={creating}>{creating ? "در حال راه‌اندازی…" : "راه‌اندازی کسب‌وکار پلتفرم"}</Button>
        </section>
      ) : !company.is_active || !company.access_preset ? (
        <ErrorBox>عضویت شما در فضای شرکت فعال نیست. تغییر نقش و لغو دسترسی بلافاصله اعمال می‌شود؛ با مالک شرکت تماس بگیرید.</ErrorBox>
      ) : (
        <>
          <InfoBox>{company.name} · نقش دسترسی: {company.access_preset}</InfoBox>
          <nav aria-label="بخش‌های کسب‌وکار پلتفرم" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {DESTINATIONS.map((item) => {
              const Icon = item.icon;
              return <Link key={item.key} href={item.href} aria-current={active === item.key ? "page" : undefined} className={cn("flex min-h-12 items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-colors", active === item.key ? "border-primary bg-primary/10 text-primary" : "border-border bg-card hover:bg-muted")}><Icon className="size-4" />{item.label}</Link>;
            })}
          </nav>
          {children ?? <CompanyHome />}
        </>
      )}
    </div>
  );
}

function CompanyHome() {
  return <><section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{DESTINATIONS.map((item) => { const Icon=item.icon; return <article key={item.key} className="rounded-2xl border border-border bg-card p-4"><Icon className="size-5 text-primary"/><h2 className="mt-3 font-bold">{item.label}</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">ورود به موتور مشترک و داده‌های ایزولهٔ شرکت پلتفرم.</p><Link href={item.href} className="mt-3 inline-flex items-center gap-1 text-sm text-primary hover:underline">باز کردن <ExternalLinkIcon className="size-3.5"/></Link></article>; })}</section><CompanyMembers /></>;
}

function CompanyMembers() {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState("");
  const load = async () => {
    const result = await api<{ members?: Member[]; error?: string }>("/api/platform/company/members");
    if (result.ok) setMembers(result.data.members ?? []);
    else if (result.data.error !== "company_permission_denied") setError(result.data.error ?? "خواندن اعضا ناموفق بود.");
  };
  useEffect(() => { void load(); }, []);
  async function update(member: Member, preset: string, active: boolean) {
    setError("");
    const result = await api<{ error?: string }>("/api/platform/company/members", {
      method: "PATCH", body: JSON.stringify({ platformAdminId: member.platformAdminId, preset, active }),
    });
    if (!result.ok) setError(result.data.error ?? "ذخیرهٔ دسترسی ناموفق بود.");
    else await load();
  }
  if (members === null && !error) return null;
  return <section className="rounded-2xl border border-border bg-card p-5">
    <h2 className="font-bold">کارکنان کسب‌وکار پلتفرم</h2>
    <p className="mt-1 text-sm text-muted-foreground">نقش‌های این بخش مستقل از نقش زیرساختی مدیر پلتفرم‌اند؛ لغو دسترسی بلافاصله اعمال می‌شود.</p>
    {error ? <div className="mt-3"><ErrorBox>{error}</ErrorBox></div> : null}
    <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[42rem] text-sm"><thead><tr className="border-b text-right text-muted-foreground"><th className="p-2">عضو</th><th className="p-2">نقش شرکت</th><th className="p-2">وضعیت</th></tr></thead><tbody>
      {members?.map((member) => <tr key={member.platformAdminId} className="border-b last:border-0"><td className="p-2"><strong>{member.fullName}</strong><div dir="ltr" className="text-xs text-muted-foreground">{member.email}</div></td><td className="p-2"><select aria-label={`نقش ${member.fullName}`} className="h-10 rounded-md border bg-background px-2" value={member.preset ?? "sales_success"} onChange={(event) => void update(member, event.target.value, true)}>{Object.entries(PRESET_LABELS).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></td><td className="p-2"><Button variant={member.active ? "destructive" : "outline"} size="sm" onClick={() => void update(member, member.preset ?? "sales_success", !member.active)}>{member.active ? "لغو دسترسی" : "فعال‌سازی"}</Button></td></tr>)}
    </tbody></table></div>
  </section>;
}

export function CompanyEnginePage({ active, title, description, notes }: { active: DestinationKey; title: string; description: string; notes: string[] }) {
  return <CompanyWorkspace active={active}><section className="rounded-2xl border border-border bg-card p-5"><h2 className="text-lg font-bold">{title}</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p><ul className="mt-4 grid gap-2 text-sm sm:grid-cols-2">{notes.map((note)=><li key={note} className="rounded-xl bg-muted/60 px-3 py-2">{note}</li>)}</ul><Button asChild className="mt-5"><a href={`/api/platform/company/open?app=${active}`}>ورود به فضای عملیاتی <ExternalLinkIcon /></a></Button></section></CompanyWorkspace>;
}
