import { Readable } from "node:stream";
import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth";
import { exportContentDisposition } from "@/lib/export-filename";
import { getPlatformServices } from "@/lib/services";
import { createCaseSuiteMarkerWorkbook } from "@/lib/case-suite-marker-xlsx";

export async function GET(request: Request, { params }: { params: Promise<{ suiteId: string }> }) {
  try {
    const identity = await authenticateRequest(request);
    const services = await getPlatformServices();
    const { suiteId } = await params;
    const scope = services.identityAccess.projectScope(identity, "case_suite.read");
    const suite = await services.caseSuites.getSummary(suiteId, scope);
    const stream = createCaseSuiteMarkerWorkbook(
      services.caseSuites.exportMarkerMembers(suiteId, scope),
      request.signal,
    );
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array<ArrayBuffer>>, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": exportContentDisposition(`${suite.name} - 任务用例标识.xlsx`),
        "Cache-Control": "no-store",
      },
    });
  } catch (cause) {
    return apiErrorResponse(cause);
  }
}
