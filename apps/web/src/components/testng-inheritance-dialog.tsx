"use client";

import { useRouter } from "next/navigation";
import { testNgInheritancePageSchema } from "@autoforge/contracts";
import { clearBrowserSnapshots } from "@/lib/browser-read-cache";
import { readApiError } from "@/lib/client-api";
import {
  VersionCaseInheritanceDialog,
  type InheritanceVersion,
} from "./version-case-inheritance-dialog";

export function TestNgInheritanceDialog(props: {
  scope: { projectId: string; projectVersionId: string; testStageId: string };
  scopeLabels: { project: string; version: string; stage: string };
  versions: InheritanceVersion[];
  onClose: () => void;
}) {
  const router = useRouter();
  return (
    <VersionCaseInheritanceDialog
      {...props}
      caseType="TestNG"
      rules={[
        "复制当前用例、测试方法和展示配置；目标已有相同完整类名的用例自动跳过，不覆盖。",
        "安全复用原 JAR，无需上传或扫描；sources JAR 仍仅用于源码查看。历史记录、任务成员、JDK 与依赖包不会一起复制。",
      ]}
      copyPage={async (input, signal) => {
        clearBrowserSnapshots();
        const response = await fetch("/api/v1/case-sources/jar/inherit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...input,
            projectId: props.scope.projectId,
            targetProjectVersionId: props.scope.projectVersionId,
            targetTestStageId: props.scope.testStageId,
          }),
          signal,
        });
        const error = await readApiError(response, "继承 TestNG 用例失败，请稍后继续。");
        if (error) throw error;
        return testNgInheritancePageSchema.parse(await response.json());
      }}
      onChanged={async () => {
        clearBrowserSnapshots();
        router.refresh();
      }}
    />
  );
}
