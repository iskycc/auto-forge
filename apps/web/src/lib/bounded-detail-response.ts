import { DomainError } from "@autoforge/domain";
import { z } from "zod";

const MAXIMUM_DETAIL_MEMBERS = 500;
const MAXIMUM_DETAIL_BYTES = 2 * 1024 * 1024;
export const detailViewSchema = z.enum(["full", "summary"]).default("full");

/** Legacy small responses keep their shape; large clients must use explicitly paged resources. */
export async function boundedDetailResponse<T>(input: {
  summary: T;
  memberCount: number;
  view: "full" | "summary";
  pageUrl: string;
  load(): Promise<unknown>;
}): Promise<Response> {
  const tooLarge = () =>
    new DomainError(
      "DETAIL_RESPONSE_TOO_LARGE",
      `完整详情超过响应上限，请使用 ?view=summary 读取摘要，并通过 ${input.pageUrl} 分页读取成员。`,
    );
  if (input.view === "full" && input.memberCount > MAXIMUM_DETAIL_MEMBERS) throw tooLarge();
  const body = JSON.stringify(input.view === "summary" ? input.summary : await input.load());
  if (new TextEncoder().encode(body).byteLength > MAXIMUM_DETAIL_BYTES) throw tooLarge();
  return new Response(body, {
    headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
  });
}
