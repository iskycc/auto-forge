import { changeAnalysisSheet, readAnalysisSheetResource } from "@/lib/failure-analysis-sheet-http";
type Context = { params: Promise<{ batchId: string; action: string }> };
export async function GET(request: Request, context: Context) {
  const { batchId, action } = await context.params;
  return readAnalysisSheetResource(request, batchId, action, "published");
}
export async function POST(request: Request, context: Context) {
  const { batchId, action } = await context.params;
  return changeAnalysisSheet(request, batchId, action, "published");
}
