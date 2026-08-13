import {
  Activity,
  Boxes,
  CalendarClock,
  Database,
  FolderKey,
  Network,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import type { Permission } from "@autoforge/domain";

import { hasPermissionInAnyScope, requirePagePermission } from "@/lib/auth";

const managementEntries = [
  {
    href: "/settings/access#users",
    title: "用户管理",
    description: "创建本地账号、停用用户、重置密码并撤销会话。",
    icon: UserRound,
    permissions: ["user.read"],
  },
  {
    href: "/settings/access#roles",
    title: "角色与权限",
    description: "管理系统角色、项目角色和自定义权限集合。",
    icon: ShieldCheck,
    permissions: ["role.read"],
  },
  {
    href: "/settings/projects",
    title: "项目与成员",
    description: "创建项目、转移所有者并维护成员作用域。",
    icon: Boxes,
    permissions: ["project.read"],
  },
  {
    href: "/settings/access#ldap",
    title: "LDAP 配置",
    description: "配置 LDAPS/StartTLS、测试连接、同步用户和组映射。",
    icon: Network,
    permissions: ["ldap.read"],
  },
  {
    href: "/settings/automation",
    title: "计划与目录作业",
    description: "查看计划任务触发、关联批次和 LDAP 同步历史。",
    icon: CalendarClock,
    permissions: ["case_suite.read", "ldap.read"],
  },
  {
    href: "/settings/environments",
    title: "环境与密文",
    description: "管理版本化执行环境和加密密文引用。",
    icon: FolderKey,
    permissions: ["environment.read", "secret.manage"],
  },
  {
    href: "/settings/platform",
    title: "平台配置",
    description: "配置部署模式、JAR 上传容量、调度阈值和基础设施。",
    icon: Database,
    permissions: ["settings.read"],
  },
  {
    href: "/settings/access#sessions",
    title: "会话管理",
    description: "查看当前账号会话并撤销不再需要的登录。",
    icon: Activity,
    permissions: ["settings.read"],
  },
  {
    href: "/settings/access#audit",
    title: "安全审计",
    description: "查看近期身份、权限和管理操作审计记录。",
    icon: ShieldCheck,
    permissions: ["audit.read"],
  },
] satisfies Array<{
  href: string;
  title: string;
  description: string;
  icon: typeof Activity;
  permissions: Permission[];
}>;

export default async function ManagementPage() {
  const identity = await requirePagePermission("settings.read", undefined);
  const visibleEntries = managementEntries.filter((entry) =>
    entry.permissions.some((permission) => hasPermissionInAnyScope(identity, permission)),
  );

  return (
    <section className="page-stack">
      <header className="page-header">
        <div>
          <p className="eyebrow">Administration</p>
          <h1>管理中心</h1>
          <p>集中进入账号、权限、LDAP、项目、执行环境和平台运行配置。</p>
        </div>
      </header>
      <nav className="management-grid" aria-label="后台管理功能">
        {visibleEntries.map((entry) => {
          const Icon = entry.icon;
          return (
            <Link className="content-card management-card" href={entry.href} key={entry.href}>
              <span className="settings-icon" aria-hidden="true">
                <Icon size={20} />
              </span>
              <span>
                <strong>{entry.title}</strong>
                <small>{entry.description}</small>
              </span>
            </Link>
          );
        })}
      </nav>
    </section>
  );
}
