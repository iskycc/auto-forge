import type { Metadata } from "next";
import { DocumentationHome } from "@/components/user-documentation/documentation-home";
import { documentationSummaries, findDocumentationArticle } from "@/lib/user-documentation/catalog";

export const metadata: Metadata = { title: "使用文档" };

export default function DocumentationPage() {
  return (
    <DocumentationHome
      summaries={documentationSummaries}
      diagram={findDocumentationArticle("quick-start")!.diagram}
    />
  );
}
