import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_VERSION = 1;
const MAX_TOKEN_LENGTH = 2_048;
const MAX_RESOURCE_ID_LENGTH = 512;

export type PermanentShareResourceType = "case_definition" | "run_batch";

type PermanentShareClaims = {
  version: 1;
  resourceType: PermanentShareResourceType;
  resourceId: string;
};

export function issuePermanentShareToken(
  masterKey: string,
  resourceType: PermanentShareResourceType,
  resourceId: string,
): string {
  if (!resourceId || resourceId.length > MAX_RESOURCE_ID_LENGTH) {
    throw new Error("Permanent share resource ID is invalid.");
  }
  const claims: PermanentShareClaims = {
    version: TOKEN_VERSION,
    resourceType,
    resourceId,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${signature(masterKey, payload)}`;
}

export function readPermanentShareToken(
  masterKey: string,
  token: string,
  expectedResourceType: PermanentShareResourceType,
): string | null {
  if (!token || token.length > MAX_TOKEN_LENGTH) return null;
  const [payload, suppliedSignature, extra] = token.split(".");
  if (!payload || !suppliedSignature || extra) return null;
  const expectedSignature = signature(masterKey, payload);
  const supplied = Buffer.from(suppliedSignature, "utf8");
  const expected = Buffer.from(expectedSignature, "utf8");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Partial<PermanentShareClaims>;
    return claims.version === TOKEN_VERSION &&
      claims.resourceType === expectedResourceType &&
      typeof claims.resourceId === "string" &&
      claims.resourceId.length > 0 &&
      claims.resourceId.length <= MAX_RESOURCE_ID_LENGTH
      ? claims.resourceId
      : null;
  } catch {
    return null;
  }
}

function signature(masterKey: string, payload: string): string {
  return createHmac("sha256", masterKey).update(`permanent-share:${payload}`).digest("base64url");
}
