import type { Metadata } from "next";

import { JarImporter } from "@/components/jar-importer";
import { requireAuthorizedPageProjectScope, requirePageProjectScope } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";

export const metadata: Metadata = { title: "导入 TestNG JAR" };
export const dynamic = "force-dynamic";

export default async function ImportJarPage({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: string | string[] }>;
}) {
  const { identity, projectIds } = await requirePageProjectScope("case_source.manage");
  const requested = (await searchParams).projectId;
  const requestedProjectId = (Array.isArray(requested) ? requested[0] : requested)?.trim();
  const projectId = requestedProjectId ?? projectIds?.[0] ?? DEFAULT_PROJECT_ID;
  requireAuthorizedPageProjectScope(identity, "case_source.manage", projectId);
  const services = await getPlatformServices();
  const projects = (await services.identityAccess.listProjects(identity).catch(() => [])).filter(
    (project) => !projectIds || projectIds.includes(project.id),
  );
  return (
    <div className="page-stack narrow-page">
      <section className="page-hero">
        <div>
          <span className="eyebrow">用例来源</span>
          <h1>导入 TestNG JAR</h1>
          <p>静态读取 class 注解，预览测试类和方法后再写入用例库。</p>
        </div>
      </section>
      <JarImporter
        maxJarBytes={services.config.maxJarBytes}
        projectId={projectId}
        projects={projects.map(({ id, name }) => ({ id, name }))}
      />
    </div>
  );
}
