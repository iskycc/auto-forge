import type { Permission } from "@autoforge/domain";
import { redirect } from "next/navigation";

import { currentIdentity, hasPermissionInAnyScope } from "@/lib/auth";

const landingRoutes: Array<{ permission: Permission; href: string }> = [
  { permission: "case.read", href: "/" },
  { permission: "run.read", href: "/run-batches" },
  { permission: "runner.read", href: "/runners" },
  { permission: "audit.read", href: "/audit" },
  { permission: "environment.read", href: "/settings/environments" },
  { permission: "settings.read", href: "/settings" },
  { permission: "project.read", href: "/settings/projects" },
  { permission: "user.read", href: "/settings/access?section=users" },
];

export default async function LandingPage() {
  const identity = await currentIdentity();
  if (!identity) redirect("/login");
  if (identity.user.forcePasswordChange) redirect("/account/security");
  const destination = landingRoutes.find(({ permission }) =>
    hasPermissionInAnyScope(identity, permission),
  );
  redirect(destination?.href ?? "/account/security");
}
