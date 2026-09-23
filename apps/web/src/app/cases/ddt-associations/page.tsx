import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";
import { LinkButton } from "@/components/ui/link-button";
import { hasPermission } from "@autoforge/domain";
import { DdtSrAssociations } from "@/components/ddt-sr-associations";
import { requireAuthorizedPageProjectScope, requirePageProjectScope } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import {
  selectableProjectIds,
  selectedProjectHierarchy,
  selectedProjectId,
} from "@/lib/selected-project";

export const dynamic = "force-dynamic";
export default async function DdtAssociationsPage() {
  const { identity } = await requirePageProjectScope("case.read");
  const services = await getPlatformServices();
  const projects = await services.identities.listProjects(selectableProjectIds(identity));
  const projectId = await selectedProjectId(identity, projects, "case.read");
  requireAuthorizedPageProjectScope(identity, "case.read", projectId);
  const structure = projectId ? await services.projectStructures.list(projectId) : undefined;
  const hierarchy = await selectedProjectHierarchy(structure);
  const version = structure?.versions.find((item) => item.id === hierarchy.projectVersionId);
  const stage = version?.stages.find((item) => item.id === hierarchy.testStageId);
  return (
    <div className={cn("page-stack", uiPatterns["page-stack"])}>
      <header className={cn("page-header", uiPatterns["page-header"])}>
        <div>
          <p className={cn("eyebrow", uiPatterns["eyebrow"])}>DDT / SR</p>
          <h1>SR 测试类关联</h1>
          <p>为 SR 设置需求分类，统一使用分类的执行类；现有及后续导入用例自动继承。</p>
        </div>
        <LinkButton
          className={cn(
            "button button-secondary",
            uiPatterns["button"],
            uiPatterns["button-secondary"],
          )}
          href="/cases?tab=ddt&ddtView=cases"
        >
          返回 DDT 用例
        </LinkButton>
      </header>
      {projectId && version && stage ? (
        <>
          <div className={cn("ddt-association-scope", pageStyles["ddt-association-scope"])}>
            <strong>
              {version.name} / {stage.name}
            </strong>
            <span>候选测试类范围和 SR 关联仅在当前项目版本、测试阶段生效。</span>
          </div>
          <DdtSrAssociations
            key={`${projectId}:${version.id}:${stage.id}`}
            scope={{ projectId, projectVersionId: version.id, testStageId: stage.id }}
            canManage={hasPermission(identity, "case.manage", projectId)}
          />
        </>
      ) : (
        <Card
          as="section"
          className={cn("card empty-state", uiPatterns["card"], uiPatterns["empty-state"])}
        >
          <strong>请先选择完整的项目层级</strong>
          <p>从顶栏选择项目版本与测试阶段后配置 SR 关联。</p>
        </Card>
      )}
    </div>
  );
}

const pageStyles = {
  "ddt-association-scope":
    "flex items-center gap-4 text-muted-foreground text-sm [&_strong]:text-foreground",
} as const;
