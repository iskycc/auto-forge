import { createHash } from "node:crypto";
import type { Clock, IdentityAccessRepository, PlatformOperationsRepository } from "./ports";

export type RuntimeIncident = {
  id: string;
  kind:
    | "log_io"
    | "background_refresh"
    | "web_pressure"
    | "database_busy"
    | "execution_control"
    | "resource_pressure";
  createdAt: string;
};

const descriptions: Record<RuntimeIncident["kind"], string> = {
  resource_pressure:
    "平台 CPU 使用率较高或可用内存不足，已暂缓后台工作，优先保障页面响应与执行控制。请结合资源监控检查持续负载。",
  execution_control:
    "执行控制工作线程异常，领取、续租或上报可能需要重试。请检查节点诊断日志与数据库状态。",
  log_io:
    "日志读取或写入出现超时、拥塞或磁盘错误。日志查询使用独立线程；失败的上传由执行机保留并重试。请检查平台节点磁盘空间、I/O 延迟和诊断日志。",
  background_refresh:
    "后台刷新或维护任务暂时失败，统计页面继续使用上一次成功快照。请检查节点诊断日志、数据库与存储资源状态。",
  web_pressure:
    "平台检测到 Web 响应延迟，已暂缓后台统计以释放资源。请检查节点 CPU、内存和磁盘负载。",
  database_busy:
    "平台数据库出现锁竞争或连接异常，请稍后重试失败的操作。请检查数据库连接、长事务、磁盘延迟和数据库负载。",
};

/** Deliver at most one bounded recipient page per cycle; retries reuse notification IDs. */
export class RuntimeNotificationService {
  private delivery: { incident: RuntimeIncident; afterUserId?: string } | undefined;

  constructor(
    private readonly identities: Pick<
      IdentityAccessRepository,
      "listSystemRoleBindings" | "listRoles" | "findUser"
    >,
    private readonly notifications: Pick<PlatformOperationsRepository, "createNotification">,
    private readonly source: {
      pendingIncident(): RuntimeIncident | undefined;
      acknowledgeIncident(id: string): void;
    },
    private readonly clock: Clock,
    private readonly nodeLabel: string,
  ) {}

  async deliverNextPage(): Promise<void> {
    const incident = this.delivery?.incident ?? this.source.pendingIncident();
    if (!incident) return;
    this.delivery ??= { incident };
    const roles = await this.identities.listRoles();
    const recipients = new Set(
      roles
        .filter((role) => role.active && role.permissions.includes("settings.manage"))
        .map((role) => role.id),
    );
    const bindings = await this.identities.listSystemRoleBindings(undefined, {
      limit: 50,
      ...(this.delivery.afterUserId ? { afterUserId: this.delivery.afterUserId } : {}),
    });
    const userIds = [...new Set(bindings.map((binding) => binding.userId))];
    for (const userId of userIds) {
      if (!bindings.some((binding) => binding.userId === userId && recipients.has(binding.roleId)))
        continue;
      if ((await this.identities.findUser(userId))?.status !== "active") continue;
      await this.notifications.createNotification({
        id: createHash("sha256").update(`${incident.id}:${userId}`).digest("hex"),
        userId,
        kind: `platform.${incident.kind}`,
        severity: "warning",
        title: "平台运行保护提示",
        message: `节点 ${this.nodeLabel}：${descriptions[incident.kind]}`,
        createdAt: this.clock.now().toISOString(),
      });
    }
    if (userIds.length < 50) {
      this.source.acknowledgeIncident(incident.id);
      this.delivery = undefined;
    } else this.delivery.afterUserId = userIds.at(-1)!;
  }
}
