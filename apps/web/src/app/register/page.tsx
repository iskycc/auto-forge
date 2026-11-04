import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { RegistrationPageView } from "@/components/registration-page";
import { currentIdentity } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import { authenticationReturnPath } from "@/lib/authentication-return-path";
import { AuthenticationEntryRedirect } from "@/components/authentication-entry-redirect";

export const metadata: Metadata = { title: "创建账号" };

export default async function RegistrationPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const returnTo = authenticationReturnPath((await searchParams).returnTo);
  const identity = await currentIdentity();
  if (identity)
    return (
      <AuthenticationEntryRedirect
        mode={identity.user.forcePasswordChange ? "change_password" : "continue"}
      />
    );
  const availability = await (
    await getPlatformServices()
  ).identityAccess.registrationAvailability();
  if (availability.reason === "setup_required") redirect("/setup");
  return <RegistrationPageView availability={availability} returnTo={returnTo} />;
}
