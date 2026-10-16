import { createVersionCaseExecutionResponse } from "@/lib/version-case-execution-handler";

type Context = { params: Promise<{ projectId: string; versionId: string; stageId: string }> };

export async function POST(request: Request, context: Context) {
  return createVersionCaseExecutionResponse(request, context.params);
}
