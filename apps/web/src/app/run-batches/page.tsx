import { Activity } from "lucide-react";

import { RunBatchPlanner } from "@/components/run-batch-planner";
import { getPlatformServices } from "@/lib/services";
import { requirePagePermission } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function RunBatchesPage() {
  await requirePagePermission("run.read");
  const services = await getPlatformServices();
  const [suites, runners, batches] = await Promise.all([
    services.caseSuites.list(200),
    services.runnerControl.list(500),
    services.runBatches.list(100),
  ]);
  return (
    <div className="page-stack">
      <section className="page-hero">
        <div>
          <span className="eyebrow">Dynamic Scheduler</span>
          <h1>用例批跑</h1>
          <p>选择任务、执行机和环境，平台依据 Agent 实时资源快照动态生成执行分配。</p>
        </div>
        <span className="hero-icon violet">
          <Activity size={24} />
        </span>
      </section>
      <RunBatchPlanner
        initialSuites={suites}
        initialRunners={runners}
        initialBatches={batches}
        policy={services.runBatches.policy()}
      />
    </div>
  );
}
