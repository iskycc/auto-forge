import { Button, Input, Select } from "@/components/ui";

import { FileArchive, Import, Search } from "lucide-react";
import Link from "next/link";

import { CaseSelectionTable } from "@/components/case-selection-table";
import { getPlatformServices } from "@/lib/services";
import { requireAuthorizedPageProjectScope, requirePageProjectScope } from "@/lib/auth";

export const dynamic = "force-dynamic";

type CasesPageProps = {
  searchParams: Promise<{
    query?: string | string[];
    cursor?: string | string[];
    projectId?: string | string[];
  }>;
};

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function CasesPage({ searchParams }: CasesPageProps) {
  const { identity, projectIds } = await requirePageProjectScope("case.read");
  const parameters = await searchParams;
  const query = single(parameters.query)?.trim();
  const cursor = single(parameters.cursor);
  const requestedProjectId = single(parameters.projectId);
  const projectId = requestedProjectId;
  const effectiveProjectIds = requireAuthorizedPageProjectScope(identity, "case.read", projectId);
  const services = await getPlatformServices();
  const [page, suites, projects] = await Promise.all([
    services.catalog.listCases({
      ...(effectiveProjectIds ? { projectIds: effectiveProjectIds } : {}),
      ...(query ? { query } : {}),
      ...(cursor ? { cursor } : {}),
      limit: 50,
    }),
    services.caseSuites.list(200, effectiveProjectIds),
    services.identityAccess.listProjects(identity).catch(() => []),
  ]);

  return (
    <div className="page-stack">
      <section className="page-hero">
        <div>
          <span className="eyebrow">TestNG 资产</span>
          <h1>用例库</h1>
          <p>一个 TestNG 测试类对应一个用例定义，测试方法作为可执行项保存在版本快照中。</p>
        </div>
        <Link
          className="button button-primary button-large"
          href={
            projectId ? `/cases/import?projectId=${encodeURIComponent(projectId)}` : "/cases/import"
          }
        >
          <Import size={18} aria-hidden="true" /> 导入 JAR
        </Link>
      </section>

      <section className="card table-card">
        <div className="table-toolbar">
          <form className="case-search" action="/cases" role="search">
            {projectId ? <input name="projectId" type="hidden" value={projectId} /> : null}
            <Search size={17} aria-hidden="true" />
            <Input
              name="query"
              type="search"
              defaultValue={query}
              placeholder="按类名或包名搜索"
              aria-label="搜索用例"
            />
            <Button className="button button-secondary" type="submit">
              搜索
            </Button>
          </form>
          <form action="/cases" method="get">
            {query ? <input name="query" type="hidden" value={query} /> : null}
            <Select aria-label="项目筛选" defaultValue={projectId ?? ""} name="projectId">
              <option value="">全部授权项目</option>
              {projects
                .filter((project) => !projectIds || projectIds.includes(project.id))
                .map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
            </Select>
            <Button className="button button-secondary" type="submit">
              切换项目
            </Button>
          </form>
          <span className="table-count">本页 {page.items.length} 个测试类</span>
        </div>

        {page.items.length === 0 ? (
          <div className="empty-state table-empty">
            <span className="empty-icon">
              <FileArchive size={27} />
            </span>
            <strong>{query ? "没有匹配的测试类" : "用例库还是空的"}</strong>
            <p>
              {query
                ? "尝试缩短关键词，或清除筛选条件。"
                : "导入一个包含 TestNG @Test 注解的 JAR。"}
            </p>
            {query ? (
              <Link className="button button-secondary" href="/cases">
                清除搜索
              </Link>
            ) : (
              <Link className="button button-primary" href="/cases/import">
                导入第一个 JAR
              </Link>
            )}
          </div>
        ) : (
          <CaseSelectionTable cases={page.items} suites={suites} />
        )}

        {page.nextCursor && (
          <div className="pagination">
            <Link
              className="button button-secondary"
              href={`/cases?${new URLSearchParams({ ...(query ? { query } : {}), ...(projectId ? { projectId } : {}), cursor: page.nextCursor }).toString()}`}
            >
              下一页
            </Link>
          </div>
        )}
      </section>
    </div>
  );
}
