import Link from "next/link";
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
    <div className="page-stack">
      <header className="page-header">
        <div>
          <p className="eyebrow">DDT / SR</p>
          <h1>SR 测试类关联</h1>
          <p>为 SR 设置需求分类，统一使用分类的执行类；现有及后续导入用例自动继承。</p>
        </div>
        <Link className="button button-secondary" href="/cases?tab=ddt&ddtView=cases">
          返回 DDT 用例
        </Link>
      </header>
      {projectId && version && stage ? (
        <>
          <div className="ddt-association-scope">
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
        <section className="card empty-state">
          <strong>请先选择完整的项目层级</strong>
          <p>从顶栏选择项目版本与测试阶段后配置 SR 关联。</p>
        </section>
      )}
    </div>
  );
}
