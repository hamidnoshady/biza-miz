import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { AskAssistant } from "@/components/ai/ask-assistant";

/**
 * The frame every page of the Eshobe CMS manager wears.
 *
 * The app's two managers each own their own header rather than sharing one:
 * «سایت‌ساز بیزامیز» and «وردپرس و ووکامرس» are two different systems, and a
 * single header over both would leave a member unsure which site the screen in
 * front of them is about — so the manager's name leads every title here. The
 * sidebar (`../website-app-nav.tsx`) is what the two share.
 */
export function CmsManagerShell({
  title,
  description,
  assistantContext,
  children,
}: {
  title: string;
  description: string;
  assistantContext: string;
  children: React.ReactNode;
}) {
  return (
    <PageShell className="space-y-4 sm:space-y-5">
      <PageHeader
        title={`سایت‌ساز بیزامیز — ${title}`}
        description={description}
        actions={
          <>
            <KnowledgeHelpButton section="website" />
            <AskAssistant app="website" context={assistantContext} />
          </>
        }
      />
      <div className="min-w-0">{children}</div>
    </PageShell>
  );
}
