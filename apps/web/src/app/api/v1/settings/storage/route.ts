import {
  deleteStorageRuntimeAssetInputSchema,
  deleteStorageRuntimeAssetResultSchema,
  storageInventoryCategorySchema,
  storageInventoryPageSchema,
} from "@autoforge/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export const runtime = "nodejs";

const querySchema = z.object({
  cursor: z.string().min(1).max(16_384).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  category: storageInventoryCategorySchema.optional(),
  query: z.string().trim().max(240).optional(),
  refresh: z.enum(["0", "1"]).default("0"),
});

export async function GET(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    await authorizeRequest(request, "settings.read");
    const url = new URL(request.url);
    const input = querySchema.parse({
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
      category: url.searchParams.get("category") || undefined,
      query: url.searchParams.get("query") || undefined,
      refresh: url.searchParams.get("refresh") ?? undefined,
    });
    const services = await getPlatformServices();
    return NextResponse.json(
      storageInventoryPageSchema.parse(
        await services.storageInventory.list({
          limit: input.limit,
          ...(input.cursor ? { cursor: input.cursor } : {}),
          ...(input.category ? { category: input.category } : {}),
          ...(input.query ? { query: input.query } : {}),
          refresh: input.refresh === "1",
        }),
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
    const input = deleteStorageRuntimeAssetInputSchema.parse(await readJsonBody(request, 8 * 1024));
    const services = await getPlatformServices();
    const asset = await services.projectStructures.deleteRuntimeAsset(input.runtimeAssetId);
    services.storageInventory.invalidateSummary();
    const result = deleteStorageRuntimeAssetResultSchema.parse({
      runtimeAssetId: asset.id,
      projectId: asset.projectId,
      category: asset.kind === "jdk" ? "jdk" : "dependency",
      sourceType: asset.sourceType,
      fileName: asset.fileName,
      deletedBytes: asset.sourceType === "upload" ? asset.sizeBytes : 0,
    });
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "storage.runtime_asset_delete",
      resourceType: "project_runtime_asset",
      resourceId: asset.id,
      projectId: asset.projectId,
      requestId: currentRequestId,
      details: {
        category: result.category,
        sourceType: result.sourceType,
        fileName: result.fileName,
        deletedBytes: result.deletedBytes,
      },
    });
    return NextResponse.json(result);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
