import { ArrowLeft, BookOpenText } from "lucide-react";
import Link from "next/link";

import { CaseSuiteDetailsView } from "@/components/case-suite-details";
import { CaseSuiteEditor } from "@/components/case-suite-editor";
import { getPlatformServices } from "@/lib/services";
import { requirePageProjectScope } from "@/lib/auth";
import { hasPermission } from "@autoforge/domain";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ suiteId: string }> };

export default async function CaseSuitePage({ params }: Props) {
  const { identity, projectIds } = await requirePageProjectScope("case_suite.read");
  const { suiteId } = await params;
  const services = await getPlatformServices();
  const suite = await services.caseSuites.get(suiteId, projectIds);
  const canManage = hasPermission(identity, "case_suite.manage", suite.projectId);
  const [runners, runnerGroups, projectStructure] = await Promise.all([
    services.runnerControl.list(500),
    services.runnerGroups.list(),
    services.projectStructures.list(suite.projectId),
  ]);
  const schedule = (await services.platformOperations.listSchedules(identity)).find(
    (candidate) => candidate.suiteId === suiteId,
  );
  return (
    <div className="page-stack">
      <section className="page-hero">
        <div>
          <Link className="back-link" href="/case-suites">
            <ArrowLeft size={15} /> 用例任务
          </Link>
          <h1>{suite.name}</h1>
          <p>{suite.description || "未填写任务说明。"}</p>
        </div>
        {canManage ? (
          <Link className="button button-primary button-large" href="/cases">
            <BookOpenText size={17} /> 添加用例
          </Link>
        ) : null}
      </section>
      <CaseSuiteEditor
        artifactsEnabled={services.config.artifactCollectionEnabled}
        canManage={canManage}
        projectVersions={projectStructure.versions}
        runnerGroups={runnerGroups}
        runners={runners}
        {...(schedule ? { schedule } : {})}
        suite={suite}
      />
      <CaseSuiteDetailsView canManage={canManage} initialSuite={suite} />
    </div>
  );
}
