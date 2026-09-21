import { Archive, Database, ExternalLink, FolderOpen, HardDrive } from "lucide-react";
import Link from "next/link";

import { CursorPagination } from "@/components/cursor-pagination";
import { Button, Input } from "@/components/ui";
import { SourceActions } from "@/components/source-actions";
import { getPlatformServices } from "@/lib/services";
import { requireAuthorizedPageProjectScope, requirePageProjectScope } from "@/lib/auth";
import { hasPermission, projectIdsForPermission } from "@autoforge/domain";
import { selectableProjectIds, selectedProjectId } from "@/lib/selected-project";
import { formatPlatformDateTime } from "@/lib/platform-date-time";

export const dynamic = "force-dynamic";

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function formatDate(value: string, timeZone: string): string {
  return formatPlatformDateTime(value, timeZone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default async function ObjectsPage({
  searchParams,
}: {
  searchParams: Promise<{
    cursor?: string;
    sourceCursor?: string;
    query?: string;
    prefix?: string;
    projectVersionId?: string;
    testStageId?: string;
  }>;
}) {
  const filters = await searchParams;
  const query = filters.query?.trim().slice(0, 120) ?? "";
  const prefix = filters.prefix?.trim().slice(0, 512) ?? "";
  const { identity } = await requirePageProjectScope("case_source.read");
  const services = await getPlatformServices();
  const timeZone = services.configurationStore.read().web.timeZone;
  const projects = await services.identities
    .listProjects(selectableProjectIds(identity))
    .catch(() => []);
  const projectId = await selectedProjectId(identity, projects, "case_source.read");
  const effectiveProjectIds = requireAuthorizedPageProjectScope(
    identity,
    "case_source.read",
    projectId,
  );
  const sourceManagementProjectIds = projectIdsForPermission(identity, "case_source.manage");
  const canImport =
    sourceManagementProjectIds === undefined ||
    Boolean(projectId && sourceManagementProjectIds.includes(projectId));
  const [allObjects, sourceWindow] = await Promise.all([
    services.caseSources.listObjects(
      {
        limit: 50,
        ...(filters.cursor ? { cursor: filters.cursor.slice(0, 512) } : {}),
        ...(prefix ? { prefix } : {}),
      },
      effectiveProjectIds,
    ),
    services.catalog.listSources(51, effectiveProjectIds, {
      ...(filters.sourceCursor ? { cursor: filters.sourceCursor.slice(0, 128) } : {}),
      ...(query ? { query } : {}),
      ...(filters.projectVersionId ? { projectVersionId: filters.projectVersionId } : {}),
      ...(filters.testStageId ? { testStageId: filters.testStageId } : {}),
    }),
  ]);
  const sources = sourceWindow.slice(0, 50);
  const nextSourceCursor = sourceWindow.length > 50 ? sources.at(-1)?.id : undefined;
  const objects = allObjects;
  const sourceByKey = new Map(sources.map((source) => [source.objectKey, source]));

  return (
    <div className="page-stack">
      <section className="page-hero">
        <div>
          <span className="eyebrow">受管对象</span>
          <h1>文件与 JAR 来源</h1>
          <p>管理当前项目的来源资产和导入文件；空间占用与清理请前往存储空间。</p>
        </div>
        <span className="storage-pill">
          {objects.storage === "local" ? <HardDrive size={16} /> : <Database size={16} />}
          {objects.storage === "local" ? "本地对象存储" : "MinIO 对象存储"}
        </span>
      </section>
      <div className="management-toolbar">
        <span className="permission-chip">范围：当前项目</span>
        <Link href="/settings/platform?section=storage">查看存储空间</Link>
      </div>
      <section className="card table-card management-table-card">
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
        <form className="management-toolbar" method="get">
          <Input
            aria-label="搜索 JAR 来源"
            name="query"
            defaultValue={query}
            placeholder="文件名或来源名称"
          />
          <Button type="submit">搜索来源</Button>
        </form>
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
                        <small>
                          {source.classCount} 类 ·{" "}
                          {source.lifecycleStatus === "archived" ? "已归档" : "可用"}
                        </small>
                        <details>
                          <summary>对象键与摘要</summary>
                          <code>{source.objectKey}</code>
                        </details>
                      </span>
                    </td>
                    <td>
                      {source.classCount} 类 · {source.methodCount} 方法
                    </td>
                    <td>
                      <code className="digest">{source.sha256.slice(0, 12)}…</code>
                    </td>
                    <td>
                      <time dateTime={source.createdAt} title={`UTC：${source.createdAt}`}>
                        {formatDate(source.createdAt, timeZone)}
                      </time>
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
        <CursorPagination
          cursorKey="sourceCursor"
          nextCursor={nextSourceCursor}
          count={sources.length}
          label="来源分页"
        />
      </section>

      <section className="card table-card management-table-card">
        <div className="section-title-row">
          <div>
            <span className="eyebrow">对象浏览器</span>
            <h2>纳管文件</h2>
          </div>
          <span className="table-count">本页 {objects.items.length} 个对象</span>
        </div>
        <form className="management-toolbar" method="get">
          <Input
            aria-label="对象键前缀"
            name="prefix"
            defaultValue={prefix}
            placeholder="按对象键前缀筛选"
          />
          <Button type="submit">筛选文件</Button>
        </form>
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
                  <th>文件 / 对象键</th>
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
                            {source.originalFileName}
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
                        <time dateTime={item.lastModified} title={`UTC：${item.lastModified}`}>
                          {formatDate(item.lastModified, timeZone)}
                        </time>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <CursorPagination
          nextCursor={objects.nextCursor}
          count={objects.items.length}
          label="文件分页"
        />
      </section>
    </div>
  );
}
