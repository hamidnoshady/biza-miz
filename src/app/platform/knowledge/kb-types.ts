/**
 * Client-side shapes of the knowledge-base records the console CRUD routes
 * return (mirrors knowledge-service.ts rows; kept here so no panel imports
 * the server module into the browser bundle).
 */
export interface ConsoleCategory {
  id: string;
  parentId: string | null;
  slug: string;
  title: string;
  description: string;
  icon: string;
  tone: string;
  sortOrder: number;
  isActive: boolean;
  articleCount: number;
}

export interface ConsoleTag {
  id: string;
  slug: string;
  label: string;
  description: string;
  articleCount: number;
}

export interface ConsoleArticle {
  id: string;
  slug: string;
  categoryId: string | null;
  sectionKeys: string[];
  title: string;
  summary: string;
  bodyMd: string;
  videoUrl: string;
  coverImageUrl: string;
  status: "draft" | "published";
  sortOrder: number;
  /** Optimistic concurrency token; sent back as `expectedVersion` on save. */
  version: number;
  tagIds: string[];
  publishedAt: string | null;
  updatedAt: string;
}
