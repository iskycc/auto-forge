import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { RegistrationPageView } from "@/components/registration-page";
import { currentIdentity } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import { registrationReturnPath } from "@/lib/registration-return-path";

export const metadata: Metadata = { title: "创建账号" };

export default async function RegistrationPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const returnTo = registrationReturnPath((await searchParams).returnTo);
  const identity = await currentIdentity();
  if (identity) redirect(identity.user.forcePasswordChange ? "/account/security" : returnTo);
  const availability = await (
    await getPlatformServices()
  ).identityAccess.registrationAvailability();
  if (availability.reason === "setup_required") redirect("/setup");
  return <RegistrationPageView availability={availability} returnTo={returnTo} />;
}
