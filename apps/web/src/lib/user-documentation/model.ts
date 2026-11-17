export const documentationTopics = [
  "quick-start",
  "account-access",
  "project-versions",
  "testng-cases",
  "ddt-cases",
  "sr-associations",
  "case-tasks",
  "run-tasks",
  "public-tasks",
  "execution-records",
  "case-logs",
  "failure-analysis",
  "ai-analysis",
  "runners",
  "file-assets",
  "log-archives",
  "integrations",
  "platform-settings",
] as const;

export type DocumentationTopic = (typeof documentationTopics)[number];
export type DocumentationGroup = "开始使用" | "用例资产" | "执行协作" | "平台管理";
export type DocumentationDiagram = {
  title: string;
  caption: string;
  nodes: readonly { title: string; detail: string }[];
};
export type DocumentationSection = {
  id: string;
  title: string;
  paragraphs?: readonly string[];
  steps?: readonly { title: string; detail: string }[];
  table?: { columns: readonly string[]; rows: readonly (readonly string[])[] };
  note?: { tone: "info" | "warning" | "success"; title: string; description: string };
};
export type DocumentationArticle = {
  topic: DocumentationTopic;
  label: string;
  title: string;
  group: DocumentationGroup;
  summary: string;
  keywords: readonly string[];
  diagram: DocumentationDiagram;
  sections: readonly DocumentationSection[];
  related: readonly DocumentationTopic[];
};
export type DocumentationSummary = Pick<
  DocumentationArticle,
  "topic" | "label" | "title" | "group" | "summary" | "keywords"
>;

export const documentationGroups: readonly DocumentationGroup[] = [
  "开始使用",
  "用例资产",
  "执行协作",
  "平台管理",
];

export function documentationHref(topic?: DocumentationTopic, section?: string): string {
  if (!topic) return "/docs";
  if (!documentationTopics.includes(topic)) throw new Error("Unknown documentation topic.");
  if (section && !/^[a-z][a-z0-9-]*$/.test(section))
    throw new Error("Invalid documentation section.");
  return `/docs/${topic}${section ? `#${section}` : ""}`;
}

export function documentationSearchQuery(value: string): string {
  return value.slice(0, 80);
}

export function searchDocumentation(
  summaries: readonly DocumentationSummary[],
  query: string,
): readonly DocumentationSummary[] {
  const words = documentationSearchQuery(query)
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return summaries;
  return summaries.filter((entry) => {
    const searchable = [entry.title, entry.label, entry.summary, ...entry.keywords]
      .join(" ")
      .normalize("NFKC")
      .toLowerCase();
    return words.every((word) => searchable.includes(word));
  });
}
