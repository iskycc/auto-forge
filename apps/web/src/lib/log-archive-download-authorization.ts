import "server-only";
import type { LogArchiveRecord } from "@autoforge/application";
import { DomainError } from "@autoforge/domain";
import { authorizeRequest } from "./auth";
import type { getPlatformServices } from "./services";
import { verifyArchiveDownloadTicket } from "./log-archive-download-ticket";

export function assertArchiveDownloadable(
  job: LogArchiveRecord,
): asserts job is LogArchiveRecord & { objectKey: string; filename: string; sha256: string } {
  if (!job.objectKey || !job.filename || !job.sha256)
    throw new DomainError("LOG_ARCHIVE_NOT_READY", "归档尚未通过完整性校验，暂不能下载。");
  if (job.copyState && job.copyState !== "retained")
    throw new DomainError(
      "LOG_ARCHIVE_OFFLINE",
      "平台归档副本已离线或正在移除，请使用已下载的归档包。",
    );
}

export async function authorizeArchiveDownload(
  request: Request,
  archiveId: string,
  services: Awaited<ReturnType<typeof getPlatformServices>>,
): Promise<{ actorId: string; sha256?: string }> {
  const ticket = new URL(request.url).searchParams.get("ticket");
  if (ticket === null) {
    const identity = await authorizeRequest(request, "settings.manage", undefined);
    await authorizeRequest(request, "log.read", undefined);
    return { actorId: identity.user.id };
  }
  const now = services.clock.now();
  const claims = verifyArchiveDownloadTicket(services.config.masterKey, ticket, now);
  if (!claims || claims.archiveId !== archiveId)
    throw new DomainError(
      "AUTHENTICATION_FAILED",
      "归档下载链接无效或已过期，请在归档页面重新复制。",
    );
  // Resolve the original session instead of trusting a stale permission snapshot.
  // The digest is scoped by the ticket and cannot be used as a session cookie.
  const identity = await services.identities.resolveSession(claims.sessionHash, now.toISOString());
  if (
    !identity ||
    identity.user.id !== claims.actorId ||
    identity.user.status !== "active" ||
    identity.user.forcePasswordChange
  )
    throw new DomainError(
      "AUTHENTICATION_FAILED",
      "生成下载链接的登录会话已失效，请重新登录后复制。",
    );
  services.identityAccess.authorize(identity, "settings.manage", undefined);
  services.identityAccess.authorize(identity, "log.read", undefined);
  return { actorId: identity.user.id, sha256: claims.sha256 };
}
