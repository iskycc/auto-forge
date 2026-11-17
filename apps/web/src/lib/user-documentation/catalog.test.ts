import { describe, expect, it } from "vitest";
import { documentationArticles, documentationSummaries, findDocumentationArticle } from "./catalog";
import {
  documentationGroups,
  documentationHref,
  documentationTopics,
  searchDocumentation,
} from "./model";

describe("user documentation navigation", () => {
  it("provides a usable guide and diagram for every navigable topic", () => {
    expect(documentationArticles.map((entry) => entry.topic)).toEqual(documentationTopics);
    for (const article of documentationArticles) {
      expect(documentationGroups).toContain(article.group);
      expect(article.label).toMatch(/^[\p{Script=Han}]{4}$/u);
      expect(article.sections.length).toBeGreaterThanOrEqual(3);
      expect(article.diagram.nodes).toHaveLength(4);
      expect(article.diagram.caption.length).toBeGreaterThan(10);
      expect(new Set(article.sections.map((section) => section.id)).size).toBe(
        article.sections.length,
      );
      for (const section of article.sections) {
        expect(section.id).toMatch(/^[a-z][a-z0-9-]*$/);
        if (section.table)
          for (const row of section.table.rows)
            expect(row).toHaveLength(section.table.columns.length);
      }
      for (const topic of article.related) expect(findDocumentationArticle(topic)).toBeDefined();
    }
  });

  it("keeps contextual public links pointing to existing, stable sections", () => {
    const targets = [
      ["public-tasks", "run-and-control"],
      ["execution-records", "public-progress"],
      ["case-logs", "public-case-log"],
      ["failure-analysis", "public-analysis"],
    ] as const;
    for (const [topic, section] of targets) {
      expect(findDocumentationArticle(topic)?.sections.some((entry) => entry.id === section)).toBe(
        true,
      );
      expect(documentationHref(topic, section)).toBe(`/docs/${topic}#${section}`);
    }
    expect(documentationHref()).toBe("/docs");
    expect(findDocumentationArticle("unpublished-feature")).toBeUndefined();
  });

  it("searches user terminology, normalizes case and preserves multi-keyword intent", () => {
    expect(
      searchDocumentation(documentationSummaries, "ＤＤＴ").map((entry) => entry.topic),
    ).toContain("ddt-cases");
    expect(
      searchDocumentation(documentationSummaries, "jenkins 插件").map((entry) => entry.topic),
    ).toContain("integrations");
    expect(
      searchDocumentation(documentationSummaries, "日志 归档").map((entry) => entry.topic),
    ).toContain("log-archives");
    expect(searchDocumentation(documentationSummaries, "  ")).toEqual(documentationSummaries);
    expect(searchDocumentation(documentationSummaries, "没有这样的功能名称")).toEqual([]);
  });
});
