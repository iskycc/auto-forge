"use client";

import { useCallback } from "react";

import { isConcurrentModificationError, type ApiClientError } from "@/lib/client-api";

import { useConfirm } from "./ui-feedback";

const RESOURCE_TITLES: Readonly<Record<string, string>> = {
  CASE_SUITE_REVISION_CONFLICT: "用例任务已被其他人修改",
  CASE_DEFINITION_REVISION_CONFLICT: "用例已被其他人修改",
  DDT_CASE_REVISION_CONFLICT: "DDT 用例已被其他人修改",
  DDT_TEMPLATE_REVISION_CONFLICT: "DDT 模板已被其他人修改",
  RUNNER_GROUP_REVISION_CONFLICT: "执行机组已被其他人修改",
  WEBHOOK_REVISION_CONFLICT: "Webhook 已被其他人修改",
  CASE_SOURCE_REVISION_CONFLICT: "用例来源已被其他人修改",
  CASE_SOURCE_SYNC_STALE: "来源对比结果已经失效",
  PROJECT_ADAPTER_CONFIGURATION_REVISION_CONFLICT: "运行时配置已被其他人修改",
  PLATFORM_CONFIGURATION_CONFLICT: "平台配置已被其他人修改",
  REVISION_CONFLICT: "当前内容已被其他人修改",
};

/**
 * 乐观锁冲突不能降级为易被忽略的内联错误。弹窗会保留用户当前输入，只有用户
 * 明确选择后才重新加载权威数据；硬刷新用于确保非受控表单和本地列表状态一起重建。
 */
export function useConcurrentModificationFeedback(): (error: unknown) => Promise<boolean> {
  const confirmAction = useConfirm();
  return useCallback(
    async (error: unknown): Promise<boolean> => {
      if (!isConcurrentModificationError(error)) return false;
      const reload = await confirmAction({
        title: concurrentModificationTitle(error),
        description: `${error.message} 为避免覆盖其他人的修改，请重新加载最新内容后再编辑。重新加载会放弃当前页面尚未保存的输入。`,
        confirmLabel: "重新加载最新内容",
        cancelLabel: "暂不重新加载",
        tone: "warning",
      });
      if (reload) window.location.reload();
      return true;
    },
    [confirmAction],
  );
}

export function concurrentModificationTitle(error: ApiClientError): string {
  return RESOURCE_TITLES[error.code] ?? "当前内容已被其他人修改";
}
