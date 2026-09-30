import { authorizeReadModelQuery } from "@/lib/read-model-authorization";
import { NextResponse } from "next/server";
import { z } from "zod";
import { DomainError } from "@autoforge/domain";
import { apiErrorResponse, readJsonBody, rejectRateLimited } from "@/lib/api-response";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

const inputSchema = z.object({
  ids: z
    .array(z.string().regex(/^[a-f0-9]{64}$/))
    .min(1)
    .max(10),
});

async function authorizedSnapshots(request: Request, ids: string[]) {
  const identity = await authenticateRequest(request);
  const services = await getPlatformServices();
  const results = [];
  for (const id of ids) {
    const snapshot = await services.readModels.inspect(id);
    if (!snapshot)
      throw new DomainError("READ_MODEL_NOT_FOUND", "当前数据已过期，请重新打开页面。");
    authorizeReadModelQuery(identity, snapshot.query);
    const current = await services.readModels.read(snapshot.query);
    results.push({ query: snapshot.query, status: current.status });
  }
  return { results, services, identity };
}

export async function GET(request: Request) {
  try {
    const input = inputSchema.parse({
      ids: new URL(request.url).searchParams.get("ids")?.split(","),
    });
    const { results } = await authorizedSnapshots(request, input.ids);
    return NextResponse.json(
      { items: results.map((entry) => entry.status) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const input = inputSchema.parse(await readJsonBody(request, 2048));
    const { results, services, identity } = await authorizedSnapshots(request, input.ids);
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(
        `read-model:refresh:v1:${identity.user.id}`,
        10,
        60_000,
      ),
    );
    for (const projectId of new Set(results.map((entry) => entry.query.projectId)))
      await services.readModels.invalidate(projectId);
    return NextResponse.json({ requested: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
