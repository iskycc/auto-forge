import { Descriptions, Tag } from "antd";
import { ddtCaseLookupSchema } from "@autoforge/contracts";
import { isDomainError } from "@autoforge/domain";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CaseHistoryContent } from "@/components/case-detail-content";
import { OpenRunDialogButton } from "@/components/global-run-dialog";
import { requirePagePermission } from "@/lib/auth";
import { loadDdtCaseDetail } from "@/lib/load-ddt-case-detail";
import { getPlatformServices } from "@/lib/services";

export const dynamic = "force-dynamic";

export default async function DdtCaseDetailPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parsedLookup = ddtCaseLookupSchema.safeParse(await searchParams);
  if (!parsedLookup.success) notFound();
  const { caseId, ...scope } = parsedLookup.data;
  const identity = await requirePagePermission("case.read", scope.projectId);
  const services = await getPlatformServices();
  let detail;
  try {
    detail = await loadDdtCaseDetail(services, identity, scope, caseId);
  } catch (error) {
    if (isDomainError(error) && error.code === "DDT_CASE_NOT_FOUND") notFound();
    throw error;
  }
  const { item, executionDetail } = detail;
  return (
    <div className="page-stack grid min-w-0 gap-5">
      <section className="grid min-w-0 gap-3">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <Link
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary"
            href={`/cases?${new URLSearchParams({ tab: "ddt", ...scope })}`}
            prefetch={false}
          >
            <ArrowLeft size={15} aria-hidden="true" /> 返回 DDT 用例管理
          </Link>
          {executionDetail?.canRun &&
          executionDetail.executable &&
          executionDetail.definition.enabled &&
          !executionDetail.definition.archived ? (
            <OpenRunDialogButton ddtCase={item} variant="primary" />
          ) : null}
        </div>
        <h1 className="m-0 text-2xl font-semibold leading-snug [overflow-wrap:anywhere]">
          {item.caseId}
        </h1>
        <div>
          <Tag color="blue">DDT 用例 · r{item.revision}</Tag>
        </div>
        <Descriptions
          size="small"
          column={2}
          styles={{ content: { overflowWrap: "anywhere" } }}
          items={[
            { key: "sr", label: "SR", children: item.srNum },
            { key: "source", label: "来源", children: item.sourceName || "—" },
            {
              key: "class",
              label: "当前执行类",
              span: 2,
              children: executionDetail ? (
                <code>{executionDetail.definition.className}</code>
              ) : (
                "尚未关联执行类"
              ),
            },
          ]}
        />
      </section>
      <CaseHistoryContent
        detail={(executionDetail ?? detail.historyDetail)!}
        caseDefinitionId={item.id}
        projectId={scope.projectId}
      />
    </div>
  );
}
