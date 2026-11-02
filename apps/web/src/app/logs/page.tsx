import { Alert } from "antd";
import { hasPermission } from "@autoforge/domain";
import { LogDatabases } from "@/components/log-databases";
import { LogArchives } from "@/components/log-archives";
import { SectionTabs } from "@/components/section-tabs";
import { TabContent } from "@/components/ui/tab-content";
import { Badge } from "@/components/ui/badge";
import { uiPatterns } from "@/components/ui/patterns";
import { requirePagePermission } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
export const dynamic = "force-dynamic";
export default async function LogManagementPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string; logCursor?: string; cursor?: string }>;
}) {
  const identity = await requirePagePermission("settings.read", undefined);
  const parameters = await searchParams;
  const services = await getPlatformServices();
  const section =
    parameters.section === "archives"
      ? "archives"
      : parameters.section === "databases"
        ? "databases"
        : services.logDatabases
          ? "databases"
          : "archives";
  const logPage =
    section === "databases" && services.logDatabases
      ? await services.logDatabases.list(parameters.logCursor?.slice(0, 128))
      : undefined;
  const archivePage =
    section === "archives"
      ? await services.logArchives.list(parameters.cursor?.slice(0, 128), identity.user.id)
      : undefined;
  const projects =
    archivePage && hasPermission(identity, "project.read")
      ? await services.identityAccess.listProjects(identity)
      : [];
  return (
    <section className={uiPatterns["page-stack"]}>
      <header className={uiPatterns["page-header"]}>
        <div>
          <p className={uiPatterns.eyebrow}>Log Management</p>
          <h1>日志管理</h1>
          <p>管理日志存储、容量与月度归档，执行记录和业务结果独立保留。</p>
          <Badge>范围：全平台</Badge>
        </div>
      </header>
      <SectionTabs
        label="日志管理模块"
        tabs={[
          { href: "/logs?section=databases", label: "日志配置", active: section === "databases" },
          { href: "/logs?section=archives", label: "日志归档", active: section === "archives" },
        ]}
      />
      <TabContent activeKey={section} className="gap-5">
        {section === "databases" ? (
          logPage ? (
            <LogDatabases
              initial={logPage}
              canManage={hasPermission(identity, "settings.manage")}
            />
          ) : (
            <Alert
              type="info"
              showIcon
              title="当前使用本地日志存储"
              description="Lite 的日志保存在平台数据目录，无需配置 PostgreSQL 日志服务器；可在日志归档中管理月度归档。"
            />
          )
        ) : null}
        {archivePage ? (
          <LogArchives
            projects={projects}
            initial={archivePage}
            canManage={
              hasPermission(identity, "settings.manage") && hasPermission(identity, "log.read")
            }
          />
        ) : null}
      </TabContent>
    </section>
  );
}
