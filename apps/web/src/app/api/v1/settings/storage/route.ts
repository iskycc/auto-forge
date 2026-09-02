import { storageInventoryCategorySchema, storageInventoryPageSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/lib/api-response";
import { authorizeRequest } from "@/lib/auth";
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
    return apiErrorResponse(error);
  }
}
