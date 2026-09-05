import { redirect } from "next/navigation";

import { requirePageAnyPermission } from "@/lib/auth";

export default async function LegacyAutomationPage(): Promise<never> {
  await requirePageAnyPermission(["case_suite.read"]);
  redirect("/case-suites");
}
