import {
  ddtAssociationImportEventSchema,
  type DdtAssociationImportProgress,
} from "@autoforge/contracts";
import { throwApiErrorResponse } from "./client-api";

/** A 200 response begins the stream; only a validated final frame confirms completion. */
export async function readAssociationImportProgress(
  response: Response,
  onProgress: (progress: DdtAssociationImportProgress) => void,
): Promise<DdtAssociationImportProgress> {
  if (!response.ok) await throwApiErrorResponse(response, "关联配置导入失败。");
  if (!response.body) throw new Error("导入进度流为空，请刷新关联后重新预览。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "",
    completed: DdtAssociationImportProgress | undefined;
  const frame = (line: string) => {
    if (!line.trim()) return;
    if (completed) throw new Error("导入完成后收到额外进度，请刷新核对配置。");
    const event = ddtAssociationImportEventSchema.parse(JSON.parse(line));
    if (event.type === "failed") throw new Error(event.message);
    onProgress(event);
    if (event.type === "completed") completed = event;
  };
  try {
    for (;;) {
      const chunk = await reader.read();
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        if (end > 8192) throw new Error("导入进度数据超出预算，请刷新核对配置。");
        frame(pending.slice(0, end));
        pending = pending.slice(end + 1);
      }
      if (pending.length > 8192) throw new Error("导入进度数据超出预算，请刷新核对配置。");
      if (chunk.done) break;
    }
    frame(pending);
    if (!completed) throw new Error("导入连接已中断，部分配置可能已保存；请刷新后重新预览导入。");
    return completed;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
