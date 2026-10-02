import { CompanyWorkspace } from "../_components/company-workspace";
import { BillingReconciliation } from "./reconciliation";
import { Button } from "@/components/ui/button";
import { ExternalLinkIcon } from "lucide-react";
export default function Page(){return <CompanyWorkspace active="accounting"><div className="space-y-4"><section className="rounded-2xl border border-border bg-card p-5"><h2 className="text-lg font-bold">حسابداری شرکت پلتفرم</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">دفتر خدمات و SaaS برای درآمد اشتراک و مصرف، خدمات اجرا و وب‌سایت، دریافتنی و پرداختنی، هزینهٔ تأمین‌کنندگان، بانک، بازپرداخت و تخصیص پروژه. صورت‌حساب تجاری در Billing مرجع می‌ماند.</p><Button asChild className="mt-4"><a href="/api/platform/company/open?app=accounting">ورود به حسابداری <ExternalLinkIcon/></a></Button></section><BillingReconciliation/></div></CompanyWorkspace>}
