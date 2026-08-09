import { Layers3 } from "lucide-react";

import { CaseSuiteManager } from "@/components/case-suite-manager";
import { getPlatformServices } from "@/lib/services";

export const dynamic = "force-dynamic";

export default async function CaseSuitesPage() {
  const suites = await (await getPlatformServices()).caseSuites.list();
  return (
    <div className="page-stack">
      <section className="page-hero">
        <div>
          <span className="eyebrow">CaseSuite</span>
          <h1>用例任务</h1>
          <p>创建可复用的测试集合，从用例库批量添加或随时移除用例。</p>
        </div>
        <span className="hero-icon violet">
          <Layers3 size={24} />
        </span>
      </section>
      <CaseSuiteManager initialSuites={suites} />
    </div>
  );
}
