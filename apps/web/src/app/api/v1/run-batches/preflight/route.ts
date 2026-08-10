import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { NextResponse } from "next/server";

import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const input = await readJsonBody(request, 128 * 1024);
    const services = await getPlatformServices();
    const projectScope = services.identityAccess.projectScope(identity, "run.create");
    const projectId =
      stringProperty(input, "projectId") ?? projectScope?.at(0) ?? DEFAULT_PROJECT_ID;
    services.identityAccess.authorize(identity, "run.create", projectId);
    if (stringProperty(input, "environmentVersionId")) {
      services.identityAccess.authorize(identity, "environment.read", projectId);
    }
    const scopedInput =
      typeof input === "object" && input !== null && !Array.isArray(input)
        ? { ...input, projectId }
        : input;
    return NextResponse.json(await services.runBatches.preflight(scopedInput));
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

function stringProperty(value: unknown, property: string): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[property];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}
