"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Alert, Anchor, Breadcrumb, Card, Steps, Table, Tag, Typography } from "antd";
import {
  documentationHref,
  type DocumentationArticle,
  type DocumentationSummary,
} from "@/lib/user-documentation/model";
import { DocumentationDiagramView } from "./documentation-diagram";

export function DocumentationArticleView({
  article,
  related,
}: {
  article: DocumentationArticle;
  related: readonly DocumentationSummary[];
}) {
  useEffect(() => {
    // A streamed article can arrive after the browser's initial fragment lookup.
    // Reconcile the requested section once the article has committed its layout.
    const frame = window.requestAnimationFrame(() => {
      const sectionId = window.location.hash.slice(1);
      if (article.sections.some((section) => section.id === sectionId)) {
        document.getElementById(sectionId)?.scrollIntoView({ block: "start", behavior: "instant" });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [article.topic, article.sections]);

  return (
    <article className="grid min-w-0 grid-cols-1 gap-5">
      <Breadcrumb
        items={[
          {
            title: (
              <Link href="/docs" prefetch={false}>
                文档首页
              </Link>
            ),
          },
          { title: article.group },
          { title: article.label },
        ]}
      />
      <Card>
        <Tag color="blue">{article.group}</Tag>
        <Typography.Title level={1} style={{ fontSize: 28, marginTop: 16 }}>
          {article.title}
        </Typography.Title>
        <Typography.Paragraph type="secondary">{article.summary}</Typography.Paragraph>
        <DocumentationDiagramView diagram={article.diagram} />
      </Card>
      <Card size="small" title="本页内容">
        <Anchor
          direction="horizontal"
          affix={false}
          offsetTop={88}
          items={article.sections.map((section) => ({
            key: section.id,
            href: `#${section.id}`,
            title: section.title,
          }))}
        />
      </Card>
      {article.sections.map((section, index) => (
        <section key={section.id} id={section.id} className="min-w-0 scroll-mt-[88px]">
          <Card>
            <Typography.Title level={2} style={{ fontSize: 20, marginTop: 0 }}>
              {index + 1}. {section.title}
            </Typography.Title>
            {section.paragraphs?.map((paragraph) => (
              <Typography.Paragraph key={paragraph}>{paragraph}</Typography.Paragraph>
            ))}
            {section.steps ? (
              <Steps
                orientation="vertical"
                current={-1}
                items={section.steps.map((step) => ({ title: step.title, content: step.detail }))}
              />
            ) : null}
            {section.table ? (
              <Table
                size="small"
                pagination={false}
                tableLayout="fixed"
                columns={section.table.columns.map((title, columnIndex) => ({
                  title,
                  dataIndex: String(columnIndex),
                  ...(columnIndex === 0 ? { width: "25%" } : {}),
                  onCell: () => ({ style: { overflowWrap: "anywhere" as const } }),
                }))}
                dataSource={section.table.rows.map((row, rowIndex) => ({
                  key: rowIndex,
                  ...Object.fromEntries(
                    row.map((value, columnIndex) => [String(columnIndex), value]),
                  ),
                }))}
              />
            ) : null}
            {section.note ? (
              <Alert
                className="mt-4"
                showIcon
                type={section.note.tone}
                title={section.note.title}
                description={section.note.description}
              />
            ) : null}
          </Card>
        </section>
      ))}
      <Card title="继续阅读">
        <div className="grid grid-cols-2 gap-3">
          {related.map((entry) => (
            <Link
              key={entry.topic}
              href={documentationHref(entry.topic)}
              prefetch={false}
              className="rounded-lg border border-border p-4 text-foreground hover:border-primary"
            >
              <Typography.Text strong>{entry.label}</Typography.Text>
              <Typography.Paragraph type="secondary" style={{ margin: "8px 0 0" }}>
                {entry.summary}
              </Typography.Paragraph>
            </Link>
          ))}
        </div>
      </Card>
    </article>
  );
}
