import { hasPermission } from "@autoforge/domain";
import { SystemDiagnostics } from "@/components/system-diagnostics";
import { Badge } from "@/components/ui/badge";
import { uiPatterns } from "@/components/ui/patterns";
import { requirePagePermission } from "@/lib/auth";
export const dynamic = "force-dynamic";
export default async function SystemInformationPage() {
  const identity = await requirePagePermission("settings.read", undefined);
  return (
    <section className={uiPatterns["page-stack"]}>
      <header className={uiPatterns["page-header"]}>
        <div>
          <p className={uiPatterns.eyebrow}>System Information</p>
          <h1>系统信息</h1>
          <p>查看运行资源、请求指标、执行配置与中间件使用情况，按需刷新并复用短期快照。</p>
          <Badge>范围：全平台</Badge>
        </div>
      </header>
      <SystemDiagnostics canManage={hasPermission(identity, "settings.manage")} />
    </section>
  );
}
