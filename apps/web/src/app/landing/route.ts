import type { Permission } from "@autoforge/domain";

import { currentIdentity, hasPermissionInAnyScope } from "@/lib/auth";

const landingRoutes: ReadonlyArray<{ permission: Permission; href: string }> = [
  { permission: "case.read", href: "/" },
  { permission: "run.read", href: "/run-batches" },
  { permission: "runner.read", href: "/runners" },
  { permission: "audit.read", href: "/audit" },
  { permission: "settings.read", href: "/settings" },
  { permission: "project.read", href: "/settings/projects" },
  { permission: "user.read", href: "/settings/access?section=users" },
];

export async function GET(): Promise<Response> {
  const identity = await currentIdentity();
  const destination = !identity
    ? "/login"
    : identity.user.forcePasswordChange
      ? "/account/security"
      : (landingRoutes.find(({ permission }) => hasPermissionInAnyScope(identity, permission))
          ?.href ?? "/account/security");

  // Keep Location relative. The custom production server deliberately uses an
  // internal listener origin for Next.js, which must never replace the host the
  // browser used or the session cookie would be lost during this hand-off.
  return new Response(null, {
    status: 307,
    headers: {
      "Cache-Control": "private, no-store",
      Location: destination,
    },
  });
}
