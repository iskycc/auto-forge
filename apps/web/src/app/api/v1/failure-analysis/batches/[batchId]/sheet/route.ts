import { readAnalysisSheet } from "@/lib/failure-analysis-sheet-http";
export async function GET(request: Request, context: { params: Promise<{ batchId: string }> }) {
  return readAnalysisSheet(request, (await context.params).batchId, "project");
}
