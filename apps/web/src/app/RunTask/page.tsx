import type { Metadata } from "next";
import { z } from "zod";
import { Result } from "antd";
import { isDomainError } from "@autoforge/domain";
import { PublicSuiteExecution } from "@/components/public-suite-execution";
import { ColorModeToggle } from "@/components/color-mode-toggle";
import { getPlatformServices } from "@/lib/services";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "任务公开执行",
  robots: { index: false, follow: false },
};

export default async function PublicTaskPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = z
    .object({ SuiteId: z.string().min(1).max(128), PublisherId: z.string().min(1).max(128) })
    .safeParse(await searchParams);
  if (!query.success) return <InvalidLink />;
  const services = await getPlatformServices();
  const view = await services.publicSuiteExecutions
    .read(query.data.SuiteId, query.data.PublisherId)
    .catch((cause: unknown) => {
      if (isDomainError(cause) && cause.code === "PUBLIC_SUITE_LINK_NOT_FOUND") return null;
      throw cause;
    });
  return view ? (
    <PublicSuiteExecution
      key={`${view.suiteId}:${view.publisher.id}`}
      initial={view}
      baseUrl={services.configurationStore.read().web.publicBaseUrl}
    />
  ) : (
    <InvalidLink />
  );
}

function InvalidLink() {
  return (
    <main className="grid min-h-screen place-items-center bg-background p-8">
      <Result
        status="warning"
        title="公开执行链接不可用"
        subTitle="任务可能已删除、链接已撤销，或分享人已停用。请联系任务维护人。"
        extra={<ColorModeToggle />}
      />
    </main>
  );
}
