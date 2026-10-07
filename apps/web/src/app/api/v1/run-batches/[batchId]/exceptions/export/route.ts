import { NextResponse } from "next/server";
import { Readable } from "node:stream";
import { z } from "zod";
import { apiErrorResponse } from "@/lib/api-response";
import { executionExceptionProjectScope } from "@/lib/execution-exceptions-access";
import { createExecutionExceptionWorkbookStream } from "@/lib/execution-exceptions-export-xlsx";
import { exportContentDisposition } from "@/lib/run-batch-export-xlsx";
import { getPlatformServices } from "@/lib/services";

const querySchema = z
  .object({
    access_token: z.string().min(1).optional(),
    time_zone: z
      .string()
      .min(1)
      .max(64)
      .default("UTC")
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, "展示时区无效。"),
  })
  .strict();

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ batchId: string }> }) {
  try {
    const { batchId } = await context.params;
    const input = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const services = await getPlatformServices();
    const projectIds = await executionExceptionProjectScope(
      request,
      batchId,
      input.access_token,
      services,
    );
    const prepared = await services.executionExceptionExport({
      batchId,
      ...(projectIds ? { projectIds } : {}),
    });
    request.signal.throwIfAborted();
    const workbook = createExecutionExceptionWorkbookStream({
      ...prepared,
      timeZone: input.time_zone,
      signal: request.signal,
    });
    const filename = `run-batch-${prepared.firstPage.batchId.slice(0, 8)}-exceptions.xlsx`;
    return new NextResponse(
      Readable.toWeb(workbook.stream) as ReadableStream<Uint8Array<ArrayBuffer>>,
      {
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": exportContentDisposition(filename),
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  } catch (cause) {
    return apiErrorResponse(cause);
  }
}
