import { NextResponse } from "next/server";
import { DomainError } from "@autoforge/domain";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { publicLinkBase } from "@/lib/public-link-base";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ suiteId: string }> };

async function authorizePublisher(request: Request, suiteId: string) {
  if (request.method !== "GET") requireSameOrigin(request);
  const identity = await authenticateRequest(request);
  if (identity.sessionId.startsWith("api-token:"))
    throw new DomainError("AUTH_REQUIRED", "请登录浏览器账号后管理公开执行链接。");
  const services = await getPlatformServices();
  const scope = services.identityAccess.projectScope(identity, "case_suite.manage");
  const suite = await services.caseSuites.getSummary(suiteId, scope);
  services.identityAccess.authorize(identity, "run.create", suite.projectId);
  return { identity, services, suite };
}

export async function GET(request: Request, context: Context) {
  try {
    const { suiteId } = await context.params;
    const { identity, services } = await authorizePublisher(request, suiteId);
    const path = await services.publicSuiteExecutions.linkPath(suiteId, identity.user.id);
    return NextResponse.json(
      {
        url: path
          ? new URL(
              path,
              publicLinkBase(services.configurationStore.read().web.publicBaseUrl, request),
            ).toString()
          : null,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (cause) {
    return apiErrorResponse(cause);
  }
}

export async function POST(request: Request, context: Context) {
  const id = requestId(request);
  try {
    const { suiteId } = await context.params;
    const { identity, services, suite } = await authorizePublisher(request, suiteId);
    const path = await services.publicSuiteExecutions.publish(suiteId, identity.user.id);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "case_suite.execution_link.publish",
      resourceType: "case_suite",
      resourceId: suiteId,
      projectId: suite.projectId,
      requestId: id,
    });
    return NextResponse.json(
      {
        url: new URL(
          path,
          publicLinkBase(services.configurationStore.read().web.publicBaseUrl, request),
        ).toString(),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (cause) {
    return apiErrorResponse(cause, id);
  }
}

export async function DELETE(request: Request, context: Context) {
  const id = requestId(request);
  try {
    const { suiteId } = await context.params;
    const { identity, services, suite } = await authorizePublisher(request, suiteId);
    await services.publicSuiteExecutions.revoke(suiteId, identity.user.id);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "case_suite.execution_link.revoke",
      resourceType: "case_suite",
      resourceId: suiteId,
      projectId: suite.projectId,
      requestId: id,
    });
    return NextResponse.json({ revoked: true });
  } catch (cause) {
    return apiErrorResponse(cause, id);
  }
}
