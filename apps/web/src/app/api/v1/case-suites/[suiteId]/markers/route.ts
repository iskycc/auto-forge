import { z, ZodError } from "zod";
import {
  caseSuiteMarkerRevisionSchema,
  caseSuiteMarkerEditSchema,
  caseSuiteMemberKindSchema,
  caseSuiteMemberRemarkSchema,
} from "@autoforge/contracts";
import { DomainError, assertCaseSuiteActive, isDomainError } from "@autoforge/domain";
import { apiErrorResponse, readCaseSuiteMarkerUpload, readJsonBody } from "@/lib/api-response";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ suiteId: string }> };

const querySchema = z.object({
  kind: caseSuiteMemberKindSchema.default("standard"),
  cursor: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  search: z.string().trim().max(512).default(""),
});
const updateSchema = z
  .object({
    expectedRevision: caseSuiteMarkerRevisionSchema,
    edit: caseSuiteMarkerEditSchema,
    remark: caseSuiteMemberRemarkSchema,
  })
  .strict();

export async function GET(request: Request, { params }: Context) {
  try {
    const identity = await authenticateRequest(request);
    const input = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const services = await getPlatformServices();
    const { suiteId } = await params;
    const result = await services.caseSuites.listMarkerMembers(
      suiteId,
      input,
      services.identityAccess.projectScope(identity, "case_suite.read"),
    );
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    return apiErrorResponse(cause);
  }
}

export async function PUT(request: Request, context: Context) {
  return updateMarkers(request, context, "edit");
}

export async function POST(request: Request, context: Context) {
  return updateMarkers(request, context, "import");
}

async function updateMarkers(request: Request, { params }: Context, operation: "edit" | "import") {
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const services = await getPlatformServices();
    const { suiteId } = await params;
    const scope = services.identityAccess.projectScope(identity, "case_suite.manage");
    const suite = await services.caseSuites.getSummary(suiteId, scope);
    assertCaseSuiteActive(suite);
    const input =
      operation === "edit"
        ? await readMarkerEdit(request)
        : await readMarkerImport(request, services);
    request.signal.throwIfAborted();
    const change = {
      expectedRevision: input.expectedRevision,
      actorId: identity.user.id,
      remark: input.remark,
    };
    if ("rows" in input) {
      const updated = await services.caseSuites.importMemberMarkers(
        suiteId,
        input.rows,
        change,
        scope,
        request.signal,
      );
      return Response.json({ revision: updated.revision, updatedCount: input.rows.length });
    }
    const updated = await services.caseSuites.updateMemberMarkers(
      suiteId,
      input.edits,
      change,
      scope,
    );
    return Response.json({ revision: updated.revision, updatedCount: input.edits.length });
  } catch (cause) {
    return apiErrorResponse(cause);
  }
}

async function readMarkerEdit(request: Request) {
  const input = updateSchema.parse(await readJsonBody(request, 16 * 1024));
  return { expectedRevision: input.expectedRevision, edits: [input.edit], remark: input.remark };
}

async function readMarkerImport(
  request: Request,
  services: Awaited<ReturnType<typeof getPlatformServices>>,
) {
  const expectedRevision = z.coerce
    .number()
    .int()
    .nonnegative()
    .parse(new URL(request.url).searchParams.get("revision") ?? undefined);
  const file = await readCaseSuiteMarkerUpload(request);
  try {
    return {
      expectedRevision,
      remark: file.remark,
      rows: await services.parseCaseSuiteMarkers(file.content, file.fileName),
    };
  } catch (cause) {
    if (isDomainError(cause) || cause instanceof ZodError) throw cause;
    throw new DomainError(
      "CASE_SUITE_MARKER_FILE_INVALID",
      cause instanceof Error ? cause.message : "读取标识表失败。",
      { cause },
    );
  }
}
