import {
  deleteStorageRuntimeAssetInputSchema,
  deleteStorageRuntimeAssetResultSchema,
  deleteStorageRuntimeAssetsInputSchema,
  deleteStorageRuntimeAssetsResultSchema,
  storageInventoryCategorySchema,
  storageInventoryPageSchema,
  type DeleteStorageRuntimeAssetResult,
} from "@autoforge/contracts";
import type { ProjectRuntimeAsset } from "@autoforge/domain";
import { NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { mapApiError } from "@/lib/api-error-mapping";
import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export const runtime = "nodejs";

const querySchema = z.object({
  nodeId: z.string().uuid().optional(),
  cursor: z.string().min(1).max(16_384).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  category: storageInventoryCategorySchema.optional(),
  query: z.string().trim().max(240).optional(),
  refresh: z.enum(["0", "1"]).default("0"),
});

const deleteRequestSchema = z.union([
  deleteStorageRuntimeAssetInputSchema,
  deleteStorageRuntimeAssetsInputSchema,
]);

export async function GET(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    await authorizeRequest(request, "settings.read");
    const url = new URL(request.url);
    const input = querySchema.parse({
      nodeId: url.searchParams.get("nodeId") ?? undefined,
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
      category: url.searchParams.get("category") || undefined,
      query: url.searchParams.get("query") || undefined,
      refresh: url.searchParams.get("refresh") ?? undefined,
    });
    const services = await getPlatformServices();
    return NextResponse.json(
      storageInventoryPageSchema.parse(
        await services.readStorageInventory(
          {
            ...(input.nodeId ? { nodeId: input.nodeId } : {}),
            limit: input.limit,
            ...(input.cursor ? { cursor: input.cursor } : {}),
            ...(input.category ? { category: input.category } : {}),
            ...(input.query ? { query: input.query } : {}),
            refresh: input.refresh === "1",
          },
          request.headers,
        ),
      ),
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authorizeRequest(request, "settings.manage", undefined);
    const input = deleteRequestSchema.parse(await readJsonBody(request, 32 * 1024));
    const services = await getPlatformServices();
    if ("runtimeAssetId" in input) {
      const asset = await services.projectStructures.deleteRuntimeAsset(input.runtimeAssetId);
      services.storageInventory.invalidateSummary();
      const result = deletionResult(asset);
      await services.identityAccess.recordAuthorizedOperation(
        identity,
        deletionAudit(result, currentRequestId),
      );
      return NextResponse.json(result);
    }

    const outcomes = await services.projectStructures.deleteRuntimeAssets(input.runtimeAssetIds);
    const deleted: DeleteStorageRuntimeAssetResult[] = [];
    const failures: Array<{ runtimeAssetId: string; code: string; message: string }> = [];
    for (const outcome of outcomes) {
      if (outcome.status === "failed") {
        const mapped = mapApiError(outcome.error, currentRequestId);
        failures.push({
          runtimeAssetId: outcome.runtimeAssetId,
          code: mapped.body.error.code,
          message: mapped.body.error.message,
        });
        continue;
      }
      const result = deletionResult(outcome.asset);
      deleted.push(result);
      await services.identityAccess.recordAuthorizedOperation(
        identity,
        deletionAudit(result, currentRequestId),
      );
    }
    if (deleted.length > 0) services.storageInventory.invalidateSummary();
    return NextResponse.json(
      deleteStorageRuntimeAssetsResultSchema.parse({
        deleted,
        failures,
        deletedCount: deleted.length,
        failedCount: failures.length,
        deletedBytes: deleted.reduce((total, result) => total + result.deletedBytes, 0),
      }),
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

function deletionResult(asset: ProjectRuntimeAsset): DeleteStorageRuntimeAssetResult {
  return deleteStorageRuntimeAssetResultSchema.parse({
    runtimeAssetId: asset.id,
    projectId: asset.projectId,
    category: asset.kind === "jdk" ? "jdk" : "dependency",
    sourceType: asset.sourceType,
    fileName: asset.fileName,
    deletedBytes: asset.sourceType === "upload" ? asset.sizeBytes : 0,
  });
}

function deletionAudit(result: DeleteStorageRuntimeAssetResult, currentRequestId: string) {
  return {
    action: "storage.runtime_asset_delete",
    resourceType: "project_runtime_asset",
    resourceId: result.runtimeAssetId,
    projectId: result.projectId,
    requestId: currentRequestId,
    details: {
      category: result.category,
      sourceType: result.sourceType,
      fileName: result.fileName,
      deletedBytes: result.deletedBytes,
    },
  };
}
