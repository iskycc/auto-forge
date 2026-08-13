import { ldapConfigurationInputSchema } from "@autoforge/contracts";
import { isDomainError, type DomainError } from "@autoforge/domain";
import { NextResponse } from "next/server";

import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import {
  apiErrorResponse,
  logServerError,
  readJsonBody,
  rejectRateLimited,
} from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const services = await getPlatformServices();
    const identity = await authenticateRequest(request);
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(`ldap:test:v1:${identity.user.id}`, 5, 60_000),
    );
    const input = ldapConfigurationInputSchema.parse(await readJsonBody(request, 192 * 1024));
    await services.identityAccess.testLdapConfiguration(identity, input, currentRequestId);
    return NextResponse.json({ connected: true });
  } catch (error) {
    // 面向用户的领域消息刻意保持通用；底层连接/TLS 故障只记录到服务端日志用于定位。
    if (isDomainError(error) && error.cause !== undefined) {
      logServerError(
        new Error(describeLdapFailureCauses(error)),
        currentRequestId,
        "LDAP connection test failed",
      );
    }
    return apiErrorResponse(error, currentRequestId);
  }
}

function describeLdapFailureCauses(error: DomainError): string {
  const messages: string[] = [];
  const visit = (cause: unknown, depth: number): void => {
    if (messages.length >= 8 || depth > 3) return;
    if (cause instanceof AggregateError) {
      for (const inner of cause.errors) visit(inner, depth + 1);
      return;
    }
    if (cause instanceof Error) {
      messages.push(`${cause.name}: ${cause.message}`);
      visit(cause.cause, depth + 1);
      return;
    }
    if (cause !== undefined && cause !== null) messages.push(String(cause));
  };
  visit(error.cause, 0);
  return messages.join(" <- ") || "cause unavailable";
}
