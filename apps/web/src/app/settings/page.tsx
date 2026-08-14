import { redirect } from "next/navigation";

import { requirePagePermission } from "@/lib/auth";

export default async function ManagementPage(): Promise<never> {
  await requirePagePermission("settings.read", undefined);
  redirect("/settings/platform?section=configuration");
}
