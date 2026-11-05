import { FAILURE_ANALYSIS_EXPORT_OUTCOMES } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import { NextResponse } from "next/server";
import { Readable } from "node:stream";
import { join } from "node:path";
import { z } from "zod";
import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import { attemptLogExportText } from "@/lib/attempt-log-export";
import {
  failureLogEntryName,
  prepareFailureLogArchive,
  type FailureLogArchiveEntry,
} from "@/lib/failure-log-archive";
import { failureLogsExportFilename, exportContentDisposition } from "@/lib/export-filename";
import { readRunBatchExportFile } from "@/lib/run-batch-export-file";

const querySchema = z.object({
  scope: z.enum(["round", "final", "all"]),
  round: z.coerce.number().int().min(1).optional(),
});
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ batchId: string }> }) {
  try {
    const identity = await authenticateRequest(request);
    const { batchId } = await context.params;
    const query = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    if (query.scope === "round" && query.round === undefined)
      throw new DomainError("INVALID_ROUND", "按轮次导出时必须提供轮次号。");
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "run.read");
    const exported = await services.runBatchExport.prepare({
      batchId,
      scope: query.scope,
      ...(query.round !== undefined ? { round: query.round } : {}),
      outcomes: [...FAILURE_ANALYSIS_EXPORT_OUTCOMES],
      ...(projectIds ? { projectIds } : {}),
    });
    services.identityAccess.authorize(identity, "log.read", exported.projectId);
    async function* entries(): AsyncGenerator<FailureLogArchiveEntry> {
      let ordinal = 0;
      for await (const rows of exported.pages) {
        for (const row of rows) {
          request.signal.throwIfAborted();
          if (!row.attemptId) continue;
          yield {
            name: failureLogEntryName(
              row.ddt ? row.displayName : row.casePath || row.displayName,
              row.round,
              ++ordinal,
            ),
            content: (async function* () {
              // BOM makes Chinese text directly readable in common offline Windows editors.
              yield "\ufeff";
              yield* attemptLogExportText(
                (page) =>
                  services.executionControl.listLogs({ ...page, projectIds: [exported.projectId] }),
                row.attemptId!,
                request.signal,
              );
            })(),
          };
        }
      }
    }
    const timeZone = services.configurationStore.read().web.timeZone;
    const filename = failureLogsExportFilename({
      batch: exported.batch,
      scope: query.scope,
      round: query.round,
      exportedAt: services.clock.now(),
      timeZone,
    });
    const prepared = await prepareFailureLogArchive(
      entries(),
      request.signal,
      join(services.configurationStore.paths.dataDirectory, "tmp", "exports"),
    );
    const stream = readRunBatchExportFile(prepared, request.signal);
    return new NextResponse(Readable.toWeb(stream) as ReadableStream<Uint8Array<ArrayBuffer>>, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": exportContentDisposition(filename),
        "Content-Length": String(prepared.sizeBytes),
        "Cache-Control": "no-store",
      },
    });
  } catch (cause) {
    return apiErrorResponse(cause);
  }
}
