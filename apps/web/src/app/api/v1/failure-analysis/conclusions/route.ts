import {
  failureAnalysisHistoryPageSchema,
  failureAnalysisCaseConclusionPageSchema,
  failureAnalysisInheritanceScopeSchema,
} from "@autoforge/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/lib/api-response";
import { authorizeRequest } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

const querySchema = z
  .object({
    projectId: z.string().min(1),
    batchId: z.string().min(1),
    caseDefinitionId: z.string().min(1),
    scope: failureAnalysisInheritanceScopeSchema.default("same_case"),
    view: z.enum(["conclusions", "cases", "case_history"]).default("conclusions"),
    query: z.string().max(200).optional(),
    cursor: z.string().max(1_024).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine((input) => input.view === "conclusions" || input.scope === "task_recent_batches", {
    message: "按用例查看结论需要本任务近 5 次批跑范围。",
  });

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const input = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    await authorizeRequest(request, "run.read", input.projectId);
    const services = await getPlatformServices();
    if (input.view === "cases") {
      const page = await services.failureAnalysis.listTaskConclusionCases({
        projectId: input.projectId,
        batchId: input.batchId,
        limit: input.limit,
        ...(input.query ? { query: input.query } : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
      });
      return NextResponse.json(failureAnalysisCaseConclusionPageSchema.parse(page), {
        headers: { "Cache-Control": "private, no-store" },
      });
    }
    if (input.view === "case_history") {
      const page = await services.failureAnalysis.listTaskCaseConclusionHistory({
        projectId: input.projectId,
        batchId: input.batchId,
        caseDefinitionId: input.caseDefinitionId,
      });
      return NextResponse.json(failureAnalysisHistoryPageSchema.parse(page), {
        headers: { "Cache-Control": "private, no-store" },
      });
    }
    const page = await services.failureAnalysis.listCompletedConclusions({
      projectId: input.projectId,
      batchId: input.batchId,
      caseDefinitionId: input.caseDefinitionId,
      scope: input.scope,
      limit: input.limit,
      ...(input.query ? { query: input.query } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
    });
    return NextResponse.json(failureAnalysisHistoryPageSchema.parse(page), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
