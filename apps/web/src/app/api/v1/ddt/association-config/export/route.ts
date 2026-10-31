import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateRequest } from "@/lib/auth";
import { authorizeDdtScope } from "@/lib/ddt-api";
import { apiErrorResponse } from "@/lib/api-response";
import { prepareDdtAssociationExport } from "@/lib/ddt-association-export";
import { readRunBatchExportFile } from "@/lib/run-batch-export-file";
import { ddtAssociationExportFilename, exportContentDisposition } from "@/lib/export-filename";
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const template = z.enum(["0", "1"]).parse(url.searchParams.get("template") ?? "0") === "1";
    const identity = await authenticateRequest(request);
    const { scope, services, labels } = await authorizeDdtScope(identity, "case.read", url);
    const prepared = await prepareDdtAssociationExport(
      (section) =>
        template
          ? (async function* () {
              yield { section, rows: [] };
            })()
          : services.ddtAssociations.exportPages(scope, section, request.signal),
      services.configurationStore.paths.dataDirectory,
      request.signal,
    );
    const filename = ddtAssociationExportFilename({
      versionName: labels.version,
      stageName: labels.stage,
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
          "cache-control": "private, no-store",
        },
      },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
