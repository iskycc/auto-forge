import type { DdtSrTagMembers } from "@autoforge/contracts";

/** Apply only the completed result; cancellation/failure never leaves a partial selection. */
export async function collectSuiteSrTagMembers(
  readPage: (cursor?: string) => Promise<DdtSrTagMembers>,
  signal: AbortSignal,
  onProgress: (count: number) => void,
) {
  const members = new Map<string, { id: string; srNum: string }>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let index = 0; index <= 100_000; index++) {
    signal.throwIfAborted();
    const page = await readPage(cursor);
    signal.throwIfAborted();
    for (const item of page.items) members.set(item.id, item);
    if (members.size > 100_000) throw new Error("选择结果超过 100,000 条，请缩小标签范围。");
    onProgress(members.size);
    if (!page.nextCursor) return [...members.values()];
    if (cursors.has(page.nextCursor)) throw new Error("任务用例分页未能继续，请刷新后重试。");
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error("任务用例分页过多，请缩小标签范围。");
}
