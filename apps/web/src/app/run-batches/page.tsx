import { redirect } from "next/navigation";

export default async function RunBatchesPage() {
  redirect("/execution-records");
}
