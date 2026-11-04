import { redirect } from "next/navigation";

import { currentIdentity } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import { AuthenticationEntryRedirect } from "@/components/authentication-entry-redirect";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ passwordChanged?: string; returnTo?: string }>;
}) {
  const services = await getPlatformServices();
  const identity = await currentIdentity();
  const parameters = await searchParams;
  if (!identity && (await services.identityAccess.setupRequired())) redirect("/setup");
  return (
    <AuthenticationEntryRedirect
      mode={
        identity ? (identity.user.forcePasswordChange ? "change_password" : "continue") : "login"
      }
      passwordChanged={parameters.passwordChanged === "1"}
    />
  );
}
