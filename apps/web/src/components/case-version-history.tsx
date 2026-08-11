"use client";

import { Button } from "@/components/ui";

import { apiErrorSchema } from "@autoforge/contracts";
import type { CaseVersion } from "@autoforge/domain";
import { History, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

const CHANGE_REASON_LABELS: Record<string, string> = {
  "source.import": "来源导入",
  "manual.restore": "手动恢复",
};

export function CaseVersionHistory({
  caseDefinitionId,
  versions,
  currentVersion,
  canManage,
}: {
  caseDefinitionId: string;
  versions: CaseVersion[];
  currentVersion: number;
  canManage: boolean;
}) {
  const router = useRouter();
  const [pendingVersion, setPendingVersion] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function restore(version: number): Promise<void> {
    if (
      !window.confirm(
        `确定从 v${version} 创建新版本？当前执行内容（分组、参数、方法）将被该版本快照覆盖。`,
      )
    ) {
      return;
    }
    setPendingVersion(version);
    setError(null);
    try {
      const response = await fetch(
        `/api/v1/case-definitions/${encodeURIComponent(caseDefinitionId)}/versions/${version}/restore`,
        { method: "POST" },
      );
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        const parsed = apiErrorSchema.safeParse(payload);
        throw new Error(
          parsed.success ? parsed.data.error.message : `请求失败（HTTP ${response.status}）。`,
        );
      }
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "恢复版本失败。");
    } finally {
      setPendingVersion(null);
    }
  }

  return (
    <div className="table-scroll">
      {error ? (
        <div className="inline-feedback" role="alert">
          {error}
        </div>
      ) : null}
      <table className="data-table">
        <thead>
          <tr>
            <th>版本</th>
            <th>变更原因</th>
            <th>操作人</th>
            <th>创建时间</th>
            {canManage ? <th>操作</th> : null}
          </tr>
        </thead>
        <tbody>
          {versions.map((version) => (
            <tr key={version.id}>
              <td>
                <strong>v{version.version}</strong>
                {version.version === currentVersion ? (
                  <span className="tag current-version-tag">当前</span>
                ) : null}
              </td>
              <td>{CHANGE_REASON_LABELS[version.changeReason] ?? version.changeReason}</td>
              <td>{version.createdBy ?? <span className="muted">—</span>}</td>
              <td>
                <time dateTime={version.createdAt}>{formatDate(version.createdAt)}</time>
              </td>
              {canManage ? (
                <td>
                  {version.version === currentVersion ? (
                    <span className="muted">—</span>
                  ) : (
                    <Button
                      className="secondary-button"
                      disabled={pendingVersion !== null}
                      onClick={() => void restore(version.version)}
                      type="button"
                    >
                      {pendingVersion === version.version ? (
                        <LoaderCircle className="spin" size={14} />
                      ) : (
                        <History size={14} />
                      )}
                      从该版本创建
                    </Button>
                  )}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
