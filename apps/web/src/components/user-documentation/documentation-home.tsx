"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowRightOutlined } from "@ant-design/icons";
import { Card, Empty, Tag, Typography } from "antd";
import {
  documentationGroups,
  documentationHref,
  documentationSearchQuery,
  searchDocumentation,
  type DocumentationDiagram,
  type DocumentationSummary,
} from "@/lib/user-documentation/model";
import { DocumentationDiagramView } from "./documentation-diagram";

export function DocumentationHome({
  summaries,
  diagram,
}: {
  summaries: readonly DocumentationSummary[];
  diagram: DocumentationDiagram;
}) {
  const query = documentationSearchQuery(useSearchParams().get("q") ?? "");
  const matches = searchDocumentation(summaries, query);
  return (
    <div className="grid min-w-0 gap-6">
      <Card>
        <div className="mb-4 flex flex-wrap gap-2">
          <Tag color="blue">使用指南</Tag>
          <Tag>无需登录</Tag>
        </div>
        <Typography.Title level={1} style={{ marginTop: 0, fontSize: 30 }}>
          让每一次执行都有据可循
        </Typography.Title>
        <Typography.Paragraph type="secondary">
          从导入用例到任务执行、公开协作与结果分析，在这里找到操作步骤、流程示意和常见问题。
        </Typography.Paragraph>
        <DocumentationDiagramView diagram={diagram} />
      </Card>
      {query ? (
        <Typography.Text type="secondary" className="break-all">
          搜索“{query}”，找到 {matches.length} 篇说明
        </Typography.Text>
      ) : null}
      {!matches.length ? (
        <Card>
          <Empty description="没有匹配的文档，请尝试其他关键词" />
        </Card>
      ) : null}
      {documentationGroups
        .filter((group) => matches.some((entry) => entry.group === group))
        .map((group) => (
          <section key={group} aria-label={group} className="min-w-0">
            <Typography.Title level={2} style={{ fontSize: 20, marginTop: 0 }}>
              {group}
            </Typography.Title>
            <div className="grid grid-cols-2 gap-4 2xl:grid-cols-3">
              {matches
                .filter((entry) => entry.group === group)
                .map((entry) => (
                  <Link
                    key={entry.topic}
                    href={documentationHref(entry.topic)}
                    prefetch={false}
                    className="block min-w-0 text-foreground"
                  >
                    <Card hoverable className="h-full" styles={{ body: { height: "100%" } }}>
                      <div className="grid h-full grid-rows-[auto_1fr_auto] gap-2">
                        <Typography.Title level={3} style={{ fontSize: 17, margin: 0 }}>
                          {entry.label}
                        </Typography.Title>
                        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                          {entry.summary}
                        </Typography.Paragraph>
                        <Typography.Text className="text-primary-text">
                          阅读指南 <ArrowRightOutlined />
                        </Typography.Text>
                      </div>
                    </Card>
                  </Link>
                ))}
            </div>
          </section>
        ))}
    </div>
  );
}
