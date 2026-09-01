import { DomainError } from "@autoforge/domain";
import { NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/lib/api-response";
import { authorizeRequest } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ analysisId: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    const projectId = z.string().min(1).parse(new URL(request.url).searchParams.get("projectId"));
    await authorizeRequest(request, "run.read", projectId);
    const services = await getPlatformServices();
    const evidence = await services.failureAnalysis.readScreenshot(
      (await context.params).analysisId,
      projectId,
    );
    if (!evidence) {
      throw new DomainError("FAILURE_ANALYSIS_EVIDENCE_NOT_FOUND", "分析证明截图不存在。");
    }
    return new NextResponse(Buffer.from(evidence.content), {
      headers: {
        "Content-Type": evidence.mediaType,
        "Content-Length": String(evidence.content.byteLength),
        "Content-Disposition": `inline; filename="${safeFileName(evidence.fileName)}"`,
        "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/gu, "_").slice(0, 180) || "evidence.png";
}
