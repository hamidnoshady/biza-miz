import { requirePlatformCapability } from "@/lib/platform-auth";
import { ErrorBox } from "@/app/dashboard/ui";
import { ReportingWorkspace } from "./workspace";
export default async function BusinessReportsPage() {
  const { error } = await requirePlatformCapability("business.reports.read");
  if (error) return <ErrorBox>دسترسی به گزارش‌های این کسب‌وکار مجاز نیست.</ErrorBox>;
  return <ReportingWorkspace />;
}
