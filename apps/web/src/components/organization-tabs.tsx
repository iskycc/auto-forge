import type { AuthenticatedIdentity } from "@autoforge/domain";

import { hasPermissionInAnyScope } from "@/lib/auth";
import { SectionTabs } from "./section-tabs";

export function organizationSections(identity: AuthenticatedIdentity) {
  const projectRead = hasPermissionInAnyScope(identity, "project.read");
  return [
    ...(projectRead || hasPermissionInAnyScope(identity, "user.read")
      ? [{ id: "users", label: "用户管理", href: "/settings/access?section=users" }]
      : []),
    ...(projectRead || hasPermissionInAnyScope(identity, "role.read")
      ? [{ id: "roles", label: "角色权限", href: "/settings/access?section=roles" }]
      : []),
    ...(hasPermissionInAnyScope(identity, "ldap.read")
      ? [{ id: "ldap", label: "目录配置", href: "/settings/access?section=ldap" }]
      : []),
    { id: "sessions", label: "登录会话", href: "/settings/access?section=sessions" },
  ];
}

export function OrganizationTabs({
  identity,
  activeSection,
}: {
  identity: AuthenticatedIdentity;
  activeSection: string;
}) {
  return (
    <SectionTabs
      label="组织管理模块"
      tabs={organizationSections(identity).map((section) => ({
        ...section,
        active: section.id === activeSection,
      }))}
    />
  );
}
