import { z } from "zod";
import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

const querySchema = z.object({
  changeId: z.string().min(1).max(128).optional(),
  cursor: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export async function GET(request: Request, { params }: { params: Promise<{ suiteId: string }> }) {
  try {
    const identity = await authenticateRequest(request);
    const input = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const services = await getPlatformServices();
    const { suiteId } = await params;
    const result = await services.caseSuites.listMemberChanges(
      suiteId,
      input,
      services.identityAccess.projectScope(identity, "case_suite.read"),
    );
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    return apiErrorResponse(cause);
  }
}
