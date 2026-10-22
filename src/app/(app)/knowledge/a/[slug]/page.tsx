import { KbArticleView } from "@/app/dashboard/knowledge/kb-article";

/**
 * One knowledge-base guide. The route stays a thin server wrapper that unwraps
 * the slug so the view below it can be a client component (fetching the
 * catalogue for the side menu and the article body at once).
 *
 * Deep links matter here: /knowledge/a/pos-basics#تسویهٔ-چندگانه
 * scrolls to that heading, because every rendered heading carries its anchor
 * id from kbHeadings and the arrow button beside it copies the link.
 */
export default async function KbArticlePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <KbArticleView slug={decodeURIComponent(slug)} />;
}
