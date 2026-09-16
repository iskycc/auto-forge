import { createUserInputSchema } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import { NextResponse } from "next/server";
import { z } from "zod";

import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { userCreationValidationErrors } from "@/lib/user-creation-validation";

const listQuerySchema = z.object({
  query: z.string().trim().max(120).optional(),
  source: z.enum(["local", "ldap"]).optional(),
  cursor: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export async function GET(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    const url = new URL(request.url);
    const input = listQuerySchema.parse(Object.fromEntries(url.searchParams));
    return NextResponse.json(
      await (
        await getPlatformServices()
      ).identityAccess.listUsers(identity, {
        ...(input.query ? { query: input.query } : {}),
        ...(input.source ? { source: input.source } : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
        limit: input.limit,
      }),
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const parsed = createUserInputSchema.safeParse(await readJsonBody(request, 16 * 1024));
    if (!parsed.success) {
      throw new DomainError(
        "VALIDATION_FAILED",
        userCreationValidationErrors(parsed.error.issues)
          .map(({ message }) => message)
          .join(" ") || "请提交有效的用户信息。",
        { cause: parsed.error, details: parsed.error.issues },
      );
    }
    const user = await (
      await getPlatformServices()
    ).identityAccess.createUser(identity, parsed.data, currentRequestId);
    return NextResponse.json(user, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
