import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocumentationArticleView } from "@/components/user-documentation/documentation-article";
import { documentationSummaries, findDocumentationArticle } from "@/lib/user-documentation/catalog";

type ArticlePageProps = { params: Promise<{ topic: string }> };

export async function generateMetadata({ params }: ArticlePageProps): Promise<Metadata> {
  const article = findDocumentationArticle((await params).topic);
  return { title: article ? `${article.label} · 使用文档` : "文档未找到" };
}

export default async function DocumentationArticlePage({ params }: ArticlePageProps) {
  const article = findDocumentationArticle((await params).topic);
  if (!article) notFound();
  return (
    <DocumentationArticleView
      article={article}
      related={documentationSummaries.filter((entry) => article.related.includes(entry.topic))}
    />
  );
}
