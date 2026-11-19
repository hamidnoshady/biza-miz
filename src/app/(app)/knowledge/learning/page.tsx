import LearningCenterPage from "@/app/dashboard/knowledge/learning-center";

/**
 * «مسیر یادگیری من» — the member Learning Center (issue #972, Phase E).
 *
 * A child of the existing `/knowledge` centre, so it inherits the same shell,
 * navigation and loading boundary; the article browser and the learning view
 * link to each other rather than competing.
 */
export default function LearningPage() {
  return <LearningCenterPage />;
}
