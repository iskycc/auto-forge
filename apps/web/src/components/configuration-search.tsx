"use client";

import type { Permission } from "@autoforge/domain";
import { ChevronRight, Search } from "lucide-react";
import Link from "next/link";

import { ActionDialog } from "@/components/action-dialog";
import { Input } from "@/components/ui";

type ConfigurationSearchItem = {
  label: string;
  description: string;
  keywords: string;
  href: string;
  permission: Permission;
};

const CONFIGURATION_SEARCH_ITEMS: readonly ConfigurationSearchItem[] = [
  platformField("监听地址", "Web 服务绑定的主机地址", "hostname 网络 ip", "hostname"),
  platformField("HTTP 端口", "Web 服务监听端口", "port 端口", "port"),
  platformField("平台时区", "页面展示和筛选使用的 IANA 时区", "timezone 时间", "timeZone"),
  platformField(
    "外部访问地址",
    "分享链接、导出日志和 Jenkins 使用的地址",
    "public url",
    "publicBaseUrl",
  ),
  platformField(
    "内部访问地址",
    "Runner Agent 连接控制面的地址",
    "runner agent url",
    "runnerBaseUrl",
  ),
  platformField(
    "公开大盘刷新间隔",
    "公开首页统计的刷新秒数",
    "dashboard refresh",
    "publicDashboardRefreshSeconds",
  ),
  platformField("JAR 大小上限", "测试 JAR 上传容量限制", "jar mib upload", "maxJarMebibytes"),
  platformField(
    "目标 Java 版本",
    "TestNG 静态发现使用的 Java 目标版本",
    "jdk java",
    "testNgTargetJavaVersion",
  ),
  platformField(
    "Runner 领取限流",
    "单个 Runner 每分钟领取上限",
    "claim rate",
    "runnerClaimRateLimitPerMinute",
  ),
  platformField("会话有效期", "登录会话持续时间", "session ttl", "sessionTtlHours"),
  platformField(
    "登录尝试上限",
    "每 IP 登录失败窗口限制",
    "auth login",
    "authLoginAttemptsPerWindow",
  ),
  platformField(
    "用例执行超时",
    "所有用例进程统一执行期限",
    "timeout case",
    "caseExecutionTimeoutSeconds",
  ),
  platformField(
    "执行产物收集",
    "控制 Runner 是否收集声明的产物",
    "artifact",
    "artifactCollectionEnabled",
  ),
  platformField(
    "CPU 调度阈值",
    "Runner CPU 利用率调度保护",
    "scheduler cpu",
    "maximumCpuUtilizationPercent",
  ),
  platformField(
    "内存调度阈值",
    "Runner 内存利用率调度保护",
    "scheduler memory",
    "maximumMemoryUtilizationPercent",
  ),
  platformField("负载调度阈值", "每 CPU 核心最大系统负载", "scheduler load", "maximumLoadPerCpu"),
  platformField(
    "指标最大年龄",
    "调度允许使用的 Runner 指标新鲜度",
    "metrics age",
    "metricsMaximumAgeSeconds",
  ),
  platformField(
    "项目最大并发",
    "单项目同时执行的上限",
    "project concurrency",
    "projectMaximumConcurrency",
  ),
  platformField(
    "优先级老化间隔",
    "排队任务提升优先级的周期",
    "priority aging",
    "priorityAgingIntervalMinutes",
  ),
  platformField(
    "后台 worker 并发",
    "后台任务消费并发数",
    "worker concurrency",
    "workerConcurrency",
  ),
  platformField("worker 健康端口", "Full worker 健康检查端口", "health port", "workerHealthPort"),
  platformField(
    "worker 关闭等待",
    "后台任务优雅退出期限",
    "shutdown grace",
    "workerShutdownGraceMs",
  ),
  platformField("worker 指标", "是否暴露 worker 指标", "metrics", "workerMetricsEnabled"),
  routeItem(
    "项目与成员",
    "项目、成员和项目角色绑定",
    "project member role",
    "/settings/projects?section=members",
    "project.read",
  ),
  routeItem(
    "项目执行配置",
    "项目版本、测试阶段、JDK 与依赖",
    "project jdk adapter stage",
    "/settings/projects?section=execution",
    "project.read",
  ),
  routeItem(
    "用户管理",
    "本地与目录用户管理",
    "user account",
    "/settings/access?section=users#users",
    "user.read",
  ),
  routeItem(
    "角色与权限",
    "系统和项目角色权限配置",
    "role permission rbac",
    "/settings/access?section=roles#roles",
    "role.read",
  ),
  routeItem(
    "LDAP 配置",
    "目录连接、用户与群组映射",
    "ldap directory",
    "/settings/access?section=ldap#ldap",
    "ldap.read",
  ),
  routeItem(
    "服务账号与 API 令牌",
    "自动化访问凭据与作用域",
    "token api service",
    "/settings/platform?section=accounts",
    "settings.read",
  ),
  routeItem(
    "数据保留",
    "日志、产物、执行和审计清理策略",
    "retention cleanup",
    "/settings/platform?section=retention",
    "settings.read",
  ),
  routeItem(
    "系统诊断",
    "运行配置、存储和依赖健康状态",
    "diagnostics health",
    "/settings/platform?section=diagnostics",
    "settings.read",
  ),
  routeItem(
    "存储空间",
    "数据库、日志、JDK 和依赖占用",
    "storage disk jdk dependency",
    "/settings/platform?section=storage",
    "settings.read",
  ),
  routeItem(
    "回调通知",
    "Webhook 通知端点与投递",
    "webhook callback",
    "/settings/webhooks",
    "project.read",
  ),
];

export function ConfigurationSearchDialog({
  onClose,
  onQueryChange,
  open,
  permissions,
  query,
}: {
  onClose: () => void;
  onQueryChange: (value: string) => void;
  open: boolean;
  permissions: readonly Permission[];
  query: string;
}) {
  const granted = new Set(permissions);
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const visibleItems = CONFIGURATION_SEARCH_ITEMS.filter(
    (item) => granted.has(item.permission) && matchesConfiguration(item, normalizedQuery),
  ).slice(0, 24);
  return (
    <ActionDialog
      className="configuration-search-dialog"
      description="搜索平台、项目、访问和运行配置，点击结果直接定位。"
      onClose={onClose}
      open={open}
      title="配置搜索"
    >
      <div className="configuration-search-input">
        <Search aria-hidden="true" size={18} />
        <Input
          aria-label="搜索配置项"
          autoFocus
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          placeholder="例如：内部访问地址、JDK、并发、LDAP…"
          type="search"
          value={query}
        />
      </div>
      <div className="configuration-search-results">
        {visibleItems.length === 0 ? (
          <p className="popover-empty">没有匹配的可访问配置。</p>
        ) : (
          visibleItems.map((item) => (
            <Link href={item.href} key={item.href} onClick={onClose}>
              <span>
                <strong>{item.label}</strong>
                <small>{item.description}</small>
              </span>
              <ChevronRight aria-hidden="true" size={17} />
            </Link>
          ))
        )}
      </div>
    </ActionDialog>
  );
}

function platformField(
  label: string,
  description: string,
  keywords: string,
  fieldName: string,
): ConfigurationSearchItem {
  return routeItem(
    label,
    description,
    keywords,
    `/settings/platform?section=configuration&focus=${encodeURIComponent(fieldName)}`,
    "settings.read",
  );
}

function routeItem(
  label: string,
  description: string,
  keywords: string,
  href: string,
  permission: Permission,
): ConfigurationSearchItem {
  return { label, description, keywords, href, permission };
}

function matchesConfiguration(item: ConfigurationSearchItem, query: string): boolean {
  if (!query) return true;
  return `${item.label} ${item.description} ${item.keywords}`
    .toLocaleLowerCase("zh-CN")
    .includes(query);
}
