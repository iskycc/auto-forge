import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeSrTagScope } from "@/lib/ddt-sr-tag-api";
import { apiErrorResponse } from "@/lib/api-response";
import { prepareSrTagExport } from "@/lib/sr-tag-export";
import { readRunBatchExportFile } from "@/lib/run-batch-export-file";
import { srTagExportFilename, exportContentDisposition } from "@/lib/export-filename";
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const template = z.enum(["0", "1"]).parse(url.searchParams.get("template") ?? "0") === "1";
    const { scope, services, versionName } = await authorizeSrTagScope(request, url, "case.read");
    const pages = template
      ? (async function* () {
          yield [];
        })()
      : services.ddtSrTagImports.exportPages(scope, request.signal);
    const prepared = await prepareSrTagExport(
      pages,
      services.configurationStore.paths.dataDirectory,
      request.signal,
    );
    const filename = srTagExportFilename({
      versionName,
      template,
      exportedAt: services.clock.now(),
      timeZone: services.configurationStore.read().web.timeZone,
    });
    return new NextResponse(
      Readable.toWeb(readRunBatchExportFile(prepared, request.signal)) as ReadableStream<
        Uint8Array<ArrayBuffer>
      >,
      {
        headers: {
          "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "content-disposition": exportContentDisposition(filename),
          "content-length": String(prepared.sizeBytes),
          "cache-control": "no-store",
        },
      },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
