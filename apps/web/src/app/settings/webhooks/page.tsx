import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";
import { hasPermission } from "@autoforge/domain";

import { CursorPagination } from "@/components/cursor-pagination";
import { WebhookSettings } from "@/components/webhook-settings";
import { requireAuthorizedPageProjectScope, requirePageProjectScope } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import { selectableProjectIds, selectedProjectId } from "@/lib/selected-project";

export const dynamic = "force-dynamic";

export default async function WebhookSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string; status?: string; webhookId?: string }>;
}) {
  const parameters = await searchParams;
  const { identity } = await requirePageProjectScope("project.read");
  const services = await getPlatformServices();
  const projects = await services.identities.listProjects(selectableProjectIds(identity));
  const projectId = await selectedProjectId(identity, projects, "project.read");
  if (!projectId) {
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
            <p className={cn("eyebrow", uiPatterns["eyebrow"])}>Webhook</p>
            <h1>任务完成通知</h1>
            <p>当前账号没有可访问的项目。</p>
          </div>
        </header>
      </section>
    );
  }
  requireAuthorizedPageProjectScope(identity, "project.read", projectId);
  const [configurations, deliveries] = await Promise.all([
    services.webhooks.listConfigurations(projectId),
    services.webhooks.listDeliveriesPage(projectId, { ...parameters, limit: 30 }),
  ]);
  return (
    <section className={cn("page-stack", uiPatterns["page-stack"])}>
      <header
        className={cn(
          "page-header settings-page-header webhook-page-header",
          uiPatterns["page-header"],
          uiPatterns["settings-page-header"],
        )}
      >
        <div>
          <p className={cn("eyebrow", uiPatterns["eyebrow"])}>Webhook</p>
          <h1>任务完成通知</h1>
          <p>在任务正常结束、执行异常或取消后，将批次结果可靠推送到项目内部系统。</p>
        </div>
      </header>
      <WebhookSettings
        key={`${projectId}:${parameters.cursor ?? ""}:${parameters.status ?? ""}:${parameters.webhookId ?? ""}`}
        deliveryFilter={{ status: parameters.status ?? "", webhookId: parameters.webhookId ?? "" }}
        canManage={hasPermission(identity, "project.manage", projectId)}
        initialConfigurations={configurations}
        initialDeliveries={deliveries.items}
        projectId={projectId}
      />
      <CursorPagination
        nextCursor={deliveries.nextCursor}
        count={deliveries.items.length}
        label="投递历史分页"
      />
    </section>
  );
}
