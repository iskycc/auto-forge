import { ArrowLeft, BookOpenText } from "lucide-react";
import Link from "next/link";

import { CaseSuiteDetailsView } from "@/components/case-suite-details";
import { getPlatformServices } from "@/lib/services";
import { requirePagePermission } from "@/lib/auth";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ suiteId: string }> };

export default async function CaseSuitePage({ params }: Props) {
  await requirePagePermission("case_suite.read");
  const { suiteId } = await params;
  const suite = await (await getPlatformServices()).caseSuites.get(suiteId);
  return (
    <div className="page-stack">
      <section className="page-hero">
        <div>
          <Link className="back-link" href="/case-suites">
            <ArrowLeft size={15} /> 用例任务
          </Link>
          <h1>{suite.name}</h1>
          <p>{suite.description || "未填写任务说明。"}</p>
        </div>
        <Link className="button button-primary button-large" href="/cases">
          <BookOpenText size={17} /> 添加用例
        </Link>
      </section>
      <CaseSuiteDetailsView initialSuite={suite} />
    </div>
  );
}
