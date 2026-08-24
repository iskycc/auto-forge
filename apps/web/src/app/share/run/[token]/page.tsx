import { Link2Off } from "lucide-react";
import type { Metadata } from "next";

import { PublicRunProgress } from "@/components/public-run-progress";
import { readPermanentShareToken } from "@/lib/permanent-share-token";
import { buildRunProgress } from "@/lib/run-progress";
import { getPlatformServices } from "@/lib/services";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "执行结果公开访问",
};

export default async function SharedRunPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const services = await getPlatformServices();
  const batchId = readPermanentShareToken(services.config.masterKey, token, "run_batch");
  if (!batchId) return <InvalidRunShare />;
  const batch = await services.runBatches.get(batchId).catch(() => null);
  if (!batch) return <InvalidRunShare />;
  return <PublicRunProgress accessToken={token} initial={buildRunProgress(batch)} permanent />;
}

function InvalidRunShare() {
  return (
    <main className="shared-case-page shared-case-page-center">
      <section className="shared-case-invalid" aria-label="执行结果永久分享链接不可用">
        <span aria-hidden="true">
          <Link2Off size={30} strokeWidth={1.8} />
        </span>
        <h1>链接无效</h1>
        <p>该执行结果永久分享链接无效，或对应的执行记录已经被删除。</p>
      </section>
    </main>
  );
}
