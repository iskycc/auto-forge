"use client";

import { ddtInheritancePageSchema } from "@autoforge/contracts";
import type { DdtScope } from "@autoforge/domain";
import { requestDdtJson } from "@/lib/ddt-client";
import type { DdtScopeLabels } from "./ddt-api-reference";
import {
  VersionCaseInheritanceDialog,
  type InheritanceVersion,
} from "./version-case-inheritance-dialog";

export type DdtInheritanceVersion = InheritanceVersion;

export function DdtInheritanceDialog(props: {
  scope: DdtScope;
  scopeLabels: DdtScopeLabels;
  versions: DdtInheritanceVersion[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  return (
    <VersionCaseInheritanceDialog
      {...props}
      caseType="DDT"
      rules={[
        "保留 CaseID、SR、普通字段及完整用户旅程；目标已存在的 CaseID（忽略大小写）自动跳过。",
        "执行类使用目标版本的 SR 分类与关联。来源的分类、模板、历史和任务成员不会一起复制。",
      ]}
      copyPage={async (input, signal) =>
        ddtInheritancePageSchema.parse(
          await requestDdtJson<unknown>(
            `/api/v1/ddt/cases/inherit?${new URLSearchParams(props.scope)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(input),
              signal,
            },
          ),
        )
      }
    />
  );
}
