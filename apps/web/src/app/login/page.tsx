import { redirect } from "next/navigation";

import { currentIdentity } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ passwordChanged?: string }>;
}) {
  const services = await getPlatformServices();
  const identity = await currentIdentity();
  if (identity) redirect(identity.user.forcePasswordChange ? "/account/security" : "/");
  if (await services.identityAccess.setupRequired()) redirect("/setup");
  const passwordChanged = (await searchParams).passwordChanged === "1";

  redirect(passwordChanged ? "/?login=1&passwordChanged=1" : "/?login=1");
}
