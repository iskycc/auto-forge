import { caseAssetGuides } from "./case-assets";
import { executionGuides } from "./execution-guides";
import { gettingStartedGuides } from "./getting-started";
import { platformGuides } from "./platform-guides";
import type { DocumentationArticle, DocumentationSummary } from "./model";

// Only documentation routes load article bodies. Shared help links import model.ts.
export const documentationArticles: readonly DocumentationArticle[] = [
  ...gettingStartedGuides,
  ...caseAssetGuides,
  ...executionGuides,
  ...platformGuides,
];

export const documentationSummaries: readonly DocumentationSummary[] = documentationArticles.map(
  ({ topic, label, title, group, summary, keywords }) => ({
    topic,
    label,
    title,
    group,
    summary,
    keywords,
  }),
);

export function findDocumentationArticle(topic: string): DocumentationArticle | undefined {
  return documentationArticles.find((article) => article.topic === topic);
}
