import { redirect } from "next/navigation";
import { hasPermission, hasPermissionInAnyScope } from "@autoforge/domain";
import { storageInventoryCategorySchema } from "@autoforge/contracts";
import { FileSourcesPanel, type FileSourceFilters } from "@/components/file-sources-panel";
import { LogArchives } from "@/components/log-archives";
import { StorageInventory } from "@/components/storage-inventory";
import { SectionTabs } from "@/components/section-tabs";
import { TabContent } from "@/components/ui/tab-content";
import { Badge } from "@/components/ui/badge";
import { uiPatterns } from "@/components/ui/patterns";
import { requirePageAnyPermission } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import { fileStorageLocation, type FileStorageSection } from "@/lib/file-storage-location";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const sections = {
  sources: {
    label: "文件来源",
    title: "文件与 JAR 来源",
    description: "管理当前项目的来源资产、TestNG JAR 与导入文件。",
  },
  storage: {
    label: "存储空间",
    title: "存储空间",
    description: "查看全平台文件、数据库与对象存储的空间占用。",
  },
  archives: {
    label: "日志归档",
    title: "日志归档",
    description: "按月压缩执行日志，下载离线查看并安全释放原存储空间。",
  },
} satisfies Record<FileStorageSection, { label: string; title: string; description: string }>;

export default async function FileStoragePage({
  searchParams,
}: {
  searchParams: Promise<FileSourceFilters & { section?: string; category?: string }>;
}) {
  const identity = await requirePageAnyPermission(["case_source.read", "settings.read"]);
  const parameters = await searchParams;
  const canReadSources = hasPermissionInAnyScope(identity, "case_source.read");
  const canReadStorage = hasPermission(identity, "settings.read");
  const activeSection: FileStorageSection =
    parameters.section === "storage" ||
    parameters.section === "archives" ||
    parameters.section === "sources"
      ? parameters.section
      : canReadSources
        ? "sources"
        : "storage";
  if (activeSection === "sources" ? !canReadSources : !canReadStorage) redirect("/forbidden");
  const services = await getPlatformServices();
  const heading = sections[activeSection];
  const archivePage =
    activeSection === "archives"
      ? await services.logArchives.list(undefined, identity.user.id)
      : undefined;
  const projects =
    activeSection === "archives" && hasPermission(identity, "project.read")
      ? await services.identityAccess.listProjects(identity)
      : [];
  const category = storageInventoryCategorySchema.safeParse(parameters.category).data;

  return (
    <section className={cn("page-stack", uiPatterns["page-stack"])}>
      <header
        className={cn(
          "page-header settings-page-header",
          uiPatterns["page-header"],
          uiPatterns["settings-page-header"],
        )}
      >
        <div>
          <p className={cn("eyebrow", uiPatterns["eyebrow"])}>文件管理</p>
          <h1>{heading.title}</h1>
          <p>{heading.description}</p>
          <Badge className={cn("permission-chip", uiPatterns["permission-chip"])}>
            {activeSection === "sources" ? "范围：当前项目" : "范围：全平台"}
          </Badge>
        </div>
      </header>
      <SectionTabs
        label="文件管理模块"
        tabs={(Object.keys(sections) as FileStorageSection[])
          .filter((section) => (section === "sources" ? canReadSources : canReadStorage))
          .map((section) => ({
            href: fileStorageLocation(section),
            label: sections[section].label,
            active: section === activeSection,
          }))}
      />
      <TabContent activeKey={activeSection} className="gap-5">
        {activeSection === "sources" ? <FileSourcesPanel filters={parameters} /> : null}
        {activeSection === "storage" ? (
          <StorageInventory
            canManage={hasPermission(identity, "settings.manage")}
            {...(category ? { initialCategory: category } : {})}
            initialQuery={parameters.query?.slice(0, 240) ?? ""}
            key={`${category ?? "all"}:${parameters.query ?? ""}`}
            timeZone={services.configurationStore.read().web.timeZone}
          />
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
