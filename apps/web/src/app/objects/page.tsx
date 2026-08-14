import { Archive, Database, ExternalLink, FolderOpen, HardDrive } from "lucide-react";
import Link from "next/link";

import { SourceActions } from "@/components/source-actions";
import { Button, Select } from "@/components/ui";
import { getPlatformServices } from "@/lib/services";
import { requireAuthorizedPageProjectScope, requirePageProjectScope } from "@/lib/auth";
import { hasPermission, projectIdsForPermission } from "@autoforge/domain";

export const dynamic = "force-dynamic";

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export default async function ObjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: string | string[] }>;
}) {
  const { identity, projectIds } = await requirePageProjectScope("case_source.read");
  const requested = (await searchParams).projectId;
  const requestedProjectId = (Array.isArray(requested) ? requested[0] : requested)?.trim();
  const projectId = requestedProjectId;
  const effectiveProjectIds = requireAuthorizedPageProjectScope(
    identity,
    "case_source.read",
    projectId,
  );
  const sourceManagementProjectIds = projectIdsForPermission(identity, "case_source.manage");
  const canImport =
    sourceManagementProjectIds === undefined || sourceManagementProjectIds.length > 0;
  const services = await getPlatformServices();
  const [allObjects, sources, projects] = await Promise.all([
    services.caseSources.listObjects({ limit: 100 }, effectiveProjectIds),
    services.catalog.listSources(100, effectiveProjectIds),
    services.identityAccess.listProjects(identity).catch(() => []),
  ]);
  const objects = allObjects;
  const sourceByKey = new Map(sources.map((source) => [source.objectKey, source]));

  return (
    <div className="page-stack">
      <section className="page-hero">
        <div>
          <span className="eyebrow">受管对象</span>
          <h1>文件与 JAR 来源</h1>
          <p>只展示 AutoForge 对象空间；Lite 对应本地数据目录，Full 对应 MinIO bucket。</p>
        </div>
        <span className="storage-pill">
          {objects.storage === "local" ? <HardDrive size={16} /> : <Database size={16} />}
          {objects.storage === "local" ? "本地对象存储" : "MinIO 对象存储"}
        </span>
      </section>
      <form action="/objects" className="card filter-panel source-filter-panel" method="get">
        <label>
          项目
          <Select defaultValue={projectId ?? ""} name="projectId">
            <option value="">全部授权项目</option>
            {projects
              .filter((project) => !projectIds || projectIds.includes(project.id))
              .map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
          </Select>
        </label>
        <Button className="button button-secondary" type="submit">
          切换项目
        </Button>
      </form>

      <section className="card table-card">
        <div className="section-title-row">
          <div>
            <span className="eyebrow">源码管理</span>
            <h2>TestNG JAR</h2>
          </div>
          {canImport ? (
            <Link className="button button-primary" href="/cases/import">
              <Archive size={16} /> 导入 JAR
            </Link>
          ) : null}
        </div>
        {sources.length === 0 ? (
          <div className="empty-state table-empty">
            <span className="empty-icon">
              <Archive size={25} />
            </span>
            <strong>暂无 JAR 来源</strong>
            <p>导入并预览 TestNG JAR 后，可在这里设置全量用例来源。</p>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="data-table source-list-table">
              <thead>
                <tr>
                  <th>JAR 来源</th>
                  <th>规模</th>
                  <th>摘要</th>
                  <th>导入时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((source) => (
                  <tr key={source.id}>
                    <td>
                      <span className="class-cell">
                        <strong>{source.originalFileName}</strong>
                        <code>{source.objectKey}</code>
                      </span>
                    </td>
                    <td>
                      {source.classCount} 类 · {source.methodCount} 方法
                    </td>
                    <td>
                      <code className="digest">{source.sha256.slice(0, 12)}…</code>
                    </td>
                    <td>
                      <time dateTime={source.createdAt}>{formatDate(source.createdAt)}</time>
                    </td>
                    <td>
                      <span className="row-actions">
                        <Link
                          className="button button-secondary"
                          href={`/case-sources/${source.id}`}
                        >
                          <ExternalLink size={14} /> 预览
                        </Link>
                        {hasPermission(identity, "case_source.manage", source.projectId) ? (
                          <SourceActions
                            sourceId={source.id}
                            authoritative={source.authoritative}
                          />
                        ) : null}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card table-card">
        <div className="section-title-row">
          <div>
            <span className="eyebrow">对象浏览器</span>
            <h2>纳管文件</h2>
          </div>
          <span className="table-count">本页 {objects.items.length} 个对象</span>
        </div>
        {objects.items.length === 0 ? (
          <div className="empty-state table-empty">
            <span className="empty-icon">
              <FolderOpen size={25} />
            </span>
            <strong>对象空间为空</strong>
            <p>导入 JAR 后，内容寻址对象会显示在这里。</p>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="data-table object-list-table">
              <thead>
                <tr>
                  <th>对象键</th>
                  <th>类型</th>
                  <th>大小</th>
                  <th>更新时间</th>
                </tr>
              </thead>
              <tbody>
                {objects.items.map((item) => {
                  const source = sourceByKey.get(item.objectKey);
                  return (
                    <tr key={item.objectKey}>
                      <td>
                        {source ? (
                          <Link className="object-link" href={`/case-sources/${source.id}`}>
                            {item.objectKey}
                          </Link>
                        ) : (
                          <code className="object-key" title={item.objectKey}>
                            {item.objectKey}
                          </code>
                        )}
                      </td>
                      <td>{source ? "TestNG JAR" : "受管对象"}</td>
                      <td>{formatBytes(item.sizeBytes)}</td>
                      <td>
                        <time dateTime={item.lastModified}>{formatDate(item.lastModified)}</time>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
