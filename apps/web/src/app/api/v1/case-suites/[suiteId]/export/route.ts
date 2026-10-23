import { NextResponse } from "next/server";
import { Readable } from "node:stream";

import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest, requestId } from "@/lib/auth";
import { createCaseSuiteExportWorkbookStream } from "@/lib/case-suite-export-xlsx";
import { caseSuiteExportFilename, exportContentDisposition } from "@/lib/export-filename";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ suiteId: string }> };

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    const { suiteId } = await context.params;
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "case_suite.read");
    const prepared = await services.caseSuites.prepareCaseExport(suiteId, projectIds);
    const filename = caseSuiteExportFilename({
      suiteName: prepared.suite.name,
      exportedAt: services.clock.now(),
      timeZone: services.configurationStore.read().web.timeZone,
    });
    const workbook = createCaseSuiteExportWorkbookStream(prepared.rows);
    const abortExport = () => workbook.stream.destroy(new Error("任务用例导出请求已取消。"));
    request.signal.addEventListener("abort", abortExport, { once: true });
    workbook.stream.once("close", () => request.signal.removeEventListener("abort", abortExport));

    return new NextResponse(
      Readable.toWeb(workbook.stream) as ReadableStream<Uint8Array<ArrayBuffer>>,
      {
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": exportContentDisposition(filename),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
