import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { Disclosure } from "@/components/ui/disclosure";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";
import { Archive, Database, ExternalLink, FolderOpen, HardDrive } from "lucide-react";
import Link from "next/link";
import { LinkButton } from "@/components/ui/link-button";

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
    <div className={cn("page-stack", uiPatterns["page-stack"])}>
      <section className={cn("page-hero", uiPatterns["page-hero"])}>
        <div>
          <span className={cn("eyebrow", uiPatterns["eyebrow"])}>受管对象</span>
          <h1>文件与 JAR 来源</h1>
          <p>管理当前项目的来源资产和导入文件；空间占用与清理请前往存储空间。</p>
        </div>
        <span className={cn("storage-pill", pageStyles["storage-pill"])}>
          {objects.storage === "local" ? <HardDrive size={16} /> : <Database size={16} />}
          {objects.storage === "local" ? "本地对象存储" : "MinIO 对象存储"}
        </span>
      </section>
      <div
        className={cn(
          "management-toolbar management-scope-toolbar",
          uiPatterns["management-toolbar"],
          pageStyles["management-scope-toolbar"],
        )}
      >
        <Badge className={cn("permission-chip", uiPatterns["permission-chip"])}>
          范围：当前项目
        </Badge>
        <Link href="/settings/platform?section=storage">查看存储空间</Link>
      </div>
      <Card
        as="section"
        className={cn(
          "card table-card management-table-card",
          uiPatterns["card"],
          pageStyles["table-card"],
          pageStyles["management-table-card"],
        )}
      >
        <div className={cn("section-title-row", pageStyles["section-title-row"])}>
          <div>
            <span className={cn("eyebrow", uiPatterns["eyebrow"])}>源码管理</span>
            <h2>TestNG JAR</h2>
          </div>
          {canImport ? (
            <LinkButton
              variant="primary"
              className={cn(
                "button button-primary",
                uiPatterns["button"],
                uiPatterns["button-primary"],
              )}
              href="/cases/import"
            >
              <Archive size={16} /> 导入 JAR
            </LinkButton>
          ) : null}
        </div>
        <form className={cn("management-toolbar", uiPatterns["management-toolbar"])} method="get">
          <Input
            aria-label="搜索 JAR 来源"
            name="query"
            defaultValue={query}
            placeholder="文件名或来源名称"
          />
          <Button type="submit">搜索来源</Button>
        </form>
        {sources.length === 0 ? (
          <EmptyState
            className={cn(
              "empty-state table-empty",
              uiPatterns["empty-state"],
              uiPatterns["table-empty"],
            )}
          >
            <span className={cn("empty-icon", uiPatterns["empty-icon"])}>
              <Archive size={25} />
            </span>
            <strong>暂无 JAR 来源</strong>
            <p>导入并预览 TestNG JAR 后，可在这里设置全量用例来源。</p>
          </EmptyState>
        ) : (
          <div
            className={cn("table-scroll", uiPatterns["table-scroll"], pageStyles["table-scroll"])}
          >
            <Table
              className={cn(
                "data-table source-list-table",
                uiPatterns["data-table"],
                pageStyles["source-list-table"],
              )}
            >
              <TableHeader>
                <TableRow>
                  <TableHead>JAR 来源</TableHead>
                  <TableHead>规模</TableHead>
                  <TableHead>摘要</TableHead>
                  <TableHead>导入时间</TableHead>
                  <TableHead>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sources.map((source) => (
                  <TableRow key={source.id}>
                    <TableCell>
                      <span className={cn("class-cell", pageStyles["class-cell"])}>
                        <strong>{source.originalFileName}</strong>
                        <small>
                          {source.classCount} 类 ·{" "}
                          {source.lifecycleStatus === "archived" ? "已归档" : "可用"}
                        </small>
                        <Disclosure header={<>对象键与摘要</>}>
                          <code>{source.objectKey}</code>
                        </Disclosure>
                      </span>
                    </TableCell>
                    <TableCell>
                      {source.classCount} 类 · {source.methodCount} 方法
                    </TableCell>
                    <TableCell>
                      <code className={cn("digest", pageStyles["digest"])}>
                        {source.sha256.slice(0, 12)}…
                      </code>
                    </TableCell>
                    <TableCell>
                      <time dateTime={source.createdAt} title={`UTC：${source.createdAt}`}>
                        {formatDate(source.createdAt, timeZone)}
                      </time>
                    </TableCell>
                    <TableCell>
                      <span className={cn("row-actions", pageStyles["row-actions"])}>
                        <LinkButton
                          className={cn(
                            "button button-secondary",
                            uiPatterns["button"],
                            uiPatterns["button-secondary"],
                          )}
                          href={`/case-sources/${source.id}`}
                        >
                          <ExternalLink size={14} /> 预览
                        </LinkButton>
                        {hasPermission(identity, "case_source.manage", source.projectId) ? (
                          <SourceActions
                            sourceId={source.id}
                            authoritative={source.authoritative}
                          />
                        ) : null}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <CursorPagination
          cursorKey="sourceCursor"
          nextCursor={nextSourceCursor}
          count={sources.length}
          label="来源分页"
        />
      </Card>

      <Card
        as="section"
        className={cn(
          "card table-card management-table-card",
          uiPatterns["card"],
          pageStyles["table-card"],
          pageStyles["management-table-card"],
        )}
      >
        <div className={cn("section-title-row", pageStyles["section-title-row"])}>
          <div>
            <span className={cn("eyebrow", uiPatterns["eyebrow"])}>对象浏览器</span>
            <h2>纳管文件</h2>
          </div>
          <span className={cn("table-count", pageStyles["table-count"])}>
            本页 {objects.items.length} 个对象
          </span>
        </div>
        <form className={cn("management-toolbar", uiPatterns["management-toolbar"])} method="get">
          <Input
            aria-label="对象键前缀"
            name="prefix"
            defaultValue={prefix}
            placeholder="按对象键前缀筛选"
          />
          <Button type="submit">筛选文件</Button>
        </form>
        {objects.items.length === 0 ? (
          <EmptyState
            className={cn(
              "empty-state table-empty",
              uiPatterns["empty-state"],
              uiPatterns["table-empty"],
            )}
          >
            <span className={cn("empty-icon", uiPatterns["empty-icon"])}>
              <FolderOpen size={25} />
            </span>
            <strong>对象空间为空</strong>
            <p>导入 JAR 后，内容寻址对象会显示在这里。</p>
          </EmptyState>
        ) : (
          <div
            className={cn("table-scroll", uiPatterns["table-scroll"], pageStyles["table-scroll"])}
          >
            <Table
              className={cn(
                "data-table object-list-table",
                uiPatterns["data-table"],
                pageStyles["object-list-table"],
              )}
            >
              <TableHeader>
                <TableRow>
                  <TableHead>文件 / 对象键</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>大小</TableHead>
                  <TableHead>更新时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {objects.items.map((item) => {
                  const source = sourceByKey.get(item.objectKey);
                  return (
                    <TableRow key={item.objectKey}>
                      <TableCell>
                        {source ? (
                          <Link
                            className={cn("object-link", pageStyles["object-link"])}
                            href={`/case-sources/${source.id}`}
                          >
                            {source.originalFileName}
                          </Link>
                        ) : (
                          <code
                            className={cn("object-key", pageStyles["object-key"])}
                            title={item.objectKey}
                          >
                            {item.objectKey}
                          </code>
                        )}
                      </TableCell>
                      <TableCell>{source ? "TestNG JAR" : "受管对象"}</TableCell>
                      <TableCell>{formatBytes(item.sizeBytes)}</TableCell>
                      <TableCell>
                        <time dateTime={item.lastModified} title={`UTC：${item.lastModified}`}>
                          {formatDate(item.lastModified, timeZone)}
                        </time>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
        <CursorPagination
          nextCursor={objects.nextCursor}
          count={objects.items.length}
          label="文件分页"
        />
      </Card>
    </div>
  );
}

const pageStyles = {
  "class-cell":
    "[&_small]:overflow-hidden [&_small]:text-muted-foreground [&_small]:text-xs [&_small]:text-ellipsis [&_small]:whitespace-nowrap flex min-w-[180px] flex-col gap-1 [&_strong]:text-sm [&_code]:text-muted-foreground [&_code]:text-xs [&_code]:[overflow-wrap:anywhere] [&_code]:whitespace-normal",
  digest: "text-muted-foreground text-xs",
  "management-scope-toolbar": "items-center",
  "management-table-card":
    "flex flex-col gap-4 p-4 xl:p-5 [&_.management-toolbar]:my-0 [&_.management-pagination]:my-0 [&_.ui-card-content_>_.table-empty]:min-h-[240px]",
  "object-key": "block max-w-full overflow-hidden text-ellipsis whitespace-nowrap",
  "object-link": "text-info font-semibold [&:hover]:[text-decoration:underline]",
  "object-list-table":
    "[&_td]:min-w-0 [&_td]:[overflow-wrap:anywhere] min-w-[720px] [table-layout:fixed] [&_th:first-child]:w-[52%]",
  "row-actions": "inline-flex items-center gap-2",
  "source-list-table":
    "min-w-[1040px] [table-layout:fixed] [&_th:first-child]:w-[34%] [&_th:nth-child(2)]:w-[16%] [&_th:nth-child(3)]:w-[14%] [&_th:nth-child(4)]:w-[20%] [&_th:last-child]:w-[250px] [&_td]:min-w-0 [&_td]:[overflow-wrap:anywhere]",
  "storage-pill":
    "inline-flex items-center gap-2 border border-solid border-border rounded-full py-[9px] px-[13px] bg-card text-muted-foreground text-xs font-semibold shadow-xs",
  "section-title-row":
    "flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-border pb-4 [&_h2]:m-0 [&_h2]:text-base [&_h2]:font-semibold",
  "table-card": "overflow-hidden",
  "table-scroll": "rounded-lg border border-border",
  "table-count": "text-muted-foreground text-xs whitespace-nowrap",
} as const;
