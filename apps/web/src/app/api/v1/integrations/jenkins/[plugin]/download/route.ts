import { join } from "node:path";
import { z } from "zod";
import { readJenkinsPlugin } from "@/lib/jenkins-plugin-resources";
import { getPlatformServices } from "@/lib/services";
import { apiErrorResponse } from "@/lib/api-response";

/** Public software distribution: only the two hash-verified, embedded artifacts are reachable. */
export async function GET(_request: Request, context: { params: Promise<{ plugin: string }> }) {
  try {
    const plugin = z
      .enum(["execution", "dependency-publisher"])
      .parse((await context.params).plugin);
    const services = await getPlatformServices();
    const resource = await readJenkinsPlugin(
      join(services.config.workspaceRoot, "resources/jenkins"),
      plugin,
    );
    return new Response(new Uint8Array(resource.content), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${resource.fileName}"`,
        "Content-Length": String(resource.content.byteLength),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Checksum-Sha256": resource.sha256,
      },
    });
  } catch (cause) {
    return apiErrorResponse(cause);
  }
}
