import { ArrowLeft, Clock3, Link2 } from "lucide-react";
import Link from "next/link";

export function RunBatchDetailHero({
  batchId,
  sequenceNumber,
  suiteName,
  suiteVersion,
  projectVersionName,
  shared = false,
}: {
  batchId: string;
  sequenceNumber: number;
  suiteName: string;
  suiteVersion: number;
  projectVersionName?: string;
  shared?: boolean;
}) {
  return (
    <>
      {!shared ? (
        <Link className="back-link" href="/execution-records">
          <ArrowLeft size={16} /> 返回执行记录
        </Link>
      ) : null}
      {shared ? (
        <div className="shared-run-detail-notice" role="status">
          <Link2 size={16} aria-hidden="true" />
          永久匿名只读执行详情
        </div>
      ) : null}
      <section className="page-hero execution-detail-hero">
        <div>
          <span className="eyebrow">Execution Batch</span>
          <h1>{suiteName}</h1>
          <p title={batchId}>
            批次 #{sequenceNumber} · 任务版本 v{suiteVersion} · 项目版本
            {projectVersionName ? `「${projectVersionName}」` : "未关联"}
          </p>
        </div>
        <span className="hero-icon violet">
          <Clock3 size={24} />
        </span>
      </section>
    </>
  );
}
