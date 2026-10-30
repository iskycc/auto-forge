import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import {
  createLogArchiveDownloadLinksSchema,
  logArchiveDownloadLinksSchema,
} from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import {
  authorizeRequest,
  requestId,
  requireSameOrigin,
  sessionTokenFromRequest,
} from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { assertArchiveDownloadable } from "@/lib/log-archive-download-authorization";
import {
  ARCHIVE_DOWNLOAD_TTL_MS,
  issueArchiveDownloadTicket,
} from "@/lib/log-archive-download-ticket";
import { publicLinkBase } from "@/lib/public-link-base";

export async function POST(request: Request) {
  const id = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authorizeRequest(request, "settings.manage", undefined);
    await authorizeRequest(request, "log.read", undefined);
    const session = sessionTokenFromRequest(request);
    if (!session || identity.sessionId.startsWith("api-token:"))
      throw new DomainError("AUTH_REQUIRED", "请登录平台后勾选归档并复制下载链接。");
    const { archiveIds } = createLogArchiveDownloadLinksSchema.parse(
      await readJsonBody(request, 8192),
    );
    const services = await getPlatformServices();
    const now = services.clock.now();
    const base = publicLinkBase(services.configurationStore.read().web.publicBaseUrl, request);
    const sessionHash = createHash("sha256").update(session).digest("hex");
    const items = [];
    for (const archiveId of archiveIds) {
      const job = await services.logArchives.find(archiveId);
      assertArchiveDownloadable(job);
      const ticket = issueArchiveDownloadTicket(
        services.config.masterKey,
        {
          archiveId,
          actorId: identity.user.id,
          sessionHash,
          sha256: job.sha256,
        },
        now,
      );
      const url = new URL(`/api/v1/settings/log-archives/${archiveId}/download`, base);
      url.searchParams.set("ticket", ticket);
      items.push({
        archiveId,
        filename: job.filename,
        url: url.toString(),
        sha256: job.sha256,
        sizeBytes: job.archiveBytes,
      });
    }
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "platform.log_archive_download_links_created",
      resourceType: "log_archive",
      requestId: id,
      details: { archiveIds: archiveIds.join(","), count: items.length },
    });
    return NextResponse.json(
      logArchiveDownloadLinksSchema.parse({
        items,
        expiresAt: new Date(now.getTime() + ARCHIVE_DOWNLOAD_TTL_MS).toISOString(),
      }),
      {
        headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer" },
      },
    );
  } catch (cause) {
    return apiErrorResponse(cause, id);
  }
}
