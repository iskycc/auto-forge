import { NextResponse } from "next/server";
import { ddtSrTagFilterSchema, ddtSrTagMembersSchema } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import { authenticateRequest } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { readSrTagMetadata } from "@/lib/ddt-sr-tag-api";

export async function GET(request: Request, { params }: { params: Promise<{ suiteId: string }> }) {
  try {
    const identity = await authenticateRequest(request);
    const services = await getPlatformServices();
    const { suiteId } = await params;
    const projectScope = services.identityAccess.projectScope(identity, "case_suite.read");
    const suite = await services.caseSuites.getSummary(suiteId, projectScope);
    const projectVersionId = suite.policy.projectVersionId;
    if (!projectVersionId) throw new DomainError("DDT_SCOPE_REQUIRED", "任务未设置项目版本。");
    const scope = { projectId: suite.projectId, projectVersionId };
    const url = new URL(request.url);
    if (url.searchParams.get("view") !== "members")
      return NextResponse.json(await readSrTagMetadata(services.ddtSrTags, scope, url), {
        headers: { "Cache-Control": "no-store" },
      });
    const filter = ddtSrTagFilterSchema.parse({
      ...Object.fromEntries(url.searchParams),
      tagIds: url.searchParams.getAll("tagId"),
    });
    const checkRevision = (current: number) => {
      if (current !== filter.revision)
        throw new DomainError("REVISION_CONFLICT", "任务已发生变化，请刷新后重新选择。");
    };
    checkRevision(suite.revision);
    const page = await services.ddtSrTags.members(scope, suiteId, filter);
    checkRevision((await services.caseSuites.getSummary(suiteId, projectScope)).revision);
    return NextResponse.json(ddtSrTagMembersSchema.parse(page), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
