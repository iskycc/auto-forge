import { NextResponse } from "next/server";
import { z } from "zod";
import { DomainError } from "@autoforge/domain";
import {
  batchComparisonPartSchema,
  caseDirectoryPartSchema,
  suiteDirectoryPartSchema,
} from "@autoforge/contracts";
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
    const input = z
      .object({ generation: z.string().uuid(), ordinal: z.coerce.number().int().min(0) })
      .parse(Object.fromEntries(new URL(request.url).searchParams));
    const identity = await authenticateRequest(request);
    const services = await getPlatformServices();
    const snapshot = await services.readModels.inspect(snapshotId);
    if (
      !snapshot ||
      !["case_directory", "batch_comparison", "suite_directory"].includes(snapshot.query.kind)
    )
      throw new DomainError("READ_MODEL_NOT_FOUND", "用例目录已过期，请刷新。");
    services.identityAccess.authorize(
      identity,
      snapshot.query.kind === "suite_directory"
        ? "case_suite.read"
        : snapshot.query.kind === "case_directory"
          ? "case.read"
          : "run.read",
      snapshot.query.projectId,
    );
    if (snapshot.query.kind === "batch_comparison" && snapshot.query.rightProjectId) {
      services.identityAccess.authorize(identity, "run.read", snapshot.query.rightProjectId);
    }
    const part = await services.readModels.part(snapshotId, input.generation, input.ordinal);
    if (part === null)
      throw new DomainError("READ_MODEL_GENERATION_CONFLICT", "数据已更新，请重新读取。");
    return NextResponse.json(
      (snapshot.query.kind === "suite_directory"
        ? suiteDirectoryPartSchema
        : snapshot.query.kind === "case_directory"
          ? caseDirectoryPartSchema
          : batchComparisonPartSchema
      ).parse(part),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
