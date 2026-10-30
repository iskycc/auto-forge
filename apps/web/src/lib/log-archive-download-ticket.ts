import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const ARCHIVE_DOWNLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const claimsSchema = z
  .object({
    schemaVersion: z.literal(1),
    archiveId: z.string().uuid(),
    actorId: z.string().uuid(),
    sessionHash: z.string().regex(/^[a-f0-9]{64}$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.number().int().positive(),
  })
  .strict();
type ArchiveDownloadClaims = z.infer<typeof claimsSchema>;

export function issueArchiveDownloadTicket(
  secret: string,
  input: Omit<ArchiveDownloadClaims, "schemaVersion" | "expiresAt">,
  now: Date,
): string {
  const claims = claimsSchema.parse({
    ...input,
    schemaVersion: 1,
    expiresAt: now.getTime() + ARCHIVE_DOWNLOAD_TTL_MS,
  });
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${signature(secret, payload)}`;
}

export function verifyArchiveDownloadTicket(
  secret: string,
  encoded: string,
  now: Date,
): ArchiveDownloadClaims | null {
  if (encoded.length > 4096) return null;
  const [payload, digest, extra] = encoded.split(".");
  if (!payload || !digest || extra) return null;
  const expected = Buffer.from(signature(secret, payload));
  const supplied = Buffer.from(digest);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  try {
    const claims = claimsSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    return claims.expiresAt > now.getTime() &&
      claims.expiresAt <= now.getTime() + ARCHIVE_DOWNLOAD_TTL_MS
      ? claims
      : null;
  } catch {
    return null;
  }
}
function signature(secret: string, payload: string) {
  return createHmac("sha256", secret)
    .update("autoforge-archive-download-v1\0")
    .update(payload)
    .digest("base64url");
}
