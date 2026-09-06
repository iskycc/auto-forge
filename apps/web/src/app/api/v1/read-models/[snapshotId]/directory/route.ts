import { NextResponse } from "next/server";
import { z } from "zod";
import { caseDirectoryFilterSchema, DIRECTORY_CHUNK_SIZE } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import { authenticateRequest } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ snapshotId: string }> },
) {
  try {
    const { snapshotId } = await params;
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(snapshotId);
    const filter = caseDirectoryFilterSchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const identity = await authenticateRequest(request);
    const services = await getPlatformServices();
    const original = await services.readModels.inspect(snapshotId);
    if (
      !original ||
      (original.query.kind !== "case_directory" && original.query.kind !== "suite_directory")
    ) {
      throw new DomainError("READ_MODEL_NOT_FOUND", "目录已过期，请刷新页面。");
    }
    const query = original.query;
    services.identityAccess.authorize(
      identity,
      query.kind === "case_directory" ? "case.read" : "case_suite.read",
      query.projectId,
    );
    if (filter.missingSuiteId) {
      services.identityAccess.authorize(identity, "case_suite.read", query.projectId);
      await services.caseSuites.getSummary(filter.missingSuiteId, [query.projectId]);
    }
    const projection = await services.readModels.read(
      query.kind === "case_directory"
        ? { ...query, chunkSize: DIRECTORY_CHUNK_SIZE, tree: true, filter }
        : { ...query, chunkSize: DIRECTORY_CHUNK_SIZE, tree: true, search: filter.query },
    );
    return NextResponse.json(
      {
        status: projection.status,
        manifest: projection.payload,
        synchronized: projection.synchronized,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
