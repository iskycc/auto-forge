import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

export async function initializePlatform(configurationFile, settingsFile, endpoint, send = fetch) {
  const current = JSON.parse(await readFile(configurationFile, "utf8"));
  const settings = JSON.parse(await readFile(settingsFile, "utf8"));
  if (current.mode === "full") {
    if (
      !Object.entries(settings.full).every(([field, value]) =>
        isDeepStrictEqual(current.full?.[field], value),
      )
    )
      throw new Error(
        "The platform already uses another Full configuration; this command cannot migrate it or rotate deployed credentials.",
      );
    return "already-configured";
  }
  const url = new URL("/api/v1/auth/setup-platform", endpoint);
  const response = await send(url, {
    method: "POST",
    headers: { "content-type": "application/json", origin: url.origin },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      bootstrapToken: current.secrets.adminBootstrapToken,
      configuration: {
        revision: current.revision,
        mode: "full",
        web: {
          ...current.web,
          publicBaseUrl: settings.publicBaseUrl,
          runnerBaseUrl: settings.runnerBaseUrl,
        },
        limits: current.limits,
        scheduler: current.scheduler,
        worker: { ...current.worker, healthPort: 3001 },
        full: {
          databaseUrl: settings.full.databaseUrl,
          redisUrl: settings.full.redisUrl,
          natsServers: settings.full.natsServers,
          natsToken: settings.full.natsToken,
          minioEndpoint: settings.full.minio.endpoint,
          minioAccessKey: settings.full.minio.accessKey,
          minioSecretKey: settings.full.minio.secretKey,
          minioBucket: settings.full.minio.bucket,
          minioRegion: settings.full.minio.region,
        },
      },
    }),
  });
  if (!response.ok) {
    const result = await response.json();
    throw new Error(
      `Full initialization rejected: HTTP ${response.status}, code ${result.error?.code ?? "unknown"}, request ${result.error?.requestId ?? "unknown"}. Check the platform logs; existing installations must follow the migration guide.`,
    );
  }
  return "configured";
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await initializePlatform(
    "/var/lib/autoforge/config/platform.json",
    "/opt/setup-values.json",
    "http://web:3000",
  );
  process.stdout.write(
    "Full infrastructure settings are ready; restart Web before starting worker.\n",
  );
}
