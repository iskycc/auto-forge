import { NextResponse } from "next/server";
import { z } from "zod";
import { readDirectoryBranch } from "@autoforge/application";
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
    const input = z
      .object({
        generation: z.string().uuid(),
        ordinal: z.coerce.number().int().nonnegative(),
      })
      .parse(Object.fromEntries(new URL(request.url).searchParams));
    const identity = await authenticateRequest(request);
    const services = await getPlatformServices();
    const snapshot = await services.readModels.inspect(snapshotId);
    if (
      !snapshot ||
      (snapshot.query.kind !== "case_directory" && snapshot.query.kind !== "suite_directory") ||
      !snapshot.query.tree
    )
      throw new DomainError("READ_MODEL_NOT_FOUND", "目录已过期，请刷新。");
    services.identityAccess.authorize(
      identity,
      snapshot.query.kind === "case_directory" ? "case.read" : "case_suite.read",
      snapshot.query.projectId,
    );
    if (snapshot.query.kind === "case_directory" && snapshot.query.filter?.missingSuiteId)
      services.identityAccess.authorize(identity, "case_suite.read", snapshot.query.projectId);
    const branch = await readDirectoryBranch({
      kind: snapshot.query.kind,
      ordinal: input.ordinal,
      readPart: (ordinal) => services.readModels.part(snapshotId, input.generation, ordinal),
    });
    return NextResponse.json(branch, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
