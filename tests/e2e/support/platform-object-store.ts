import { PlatformConfigurationStore } from "@autoforge/platform-config";
import { LocalObjectStore } from "../../../packages/object-store/src/local-object-store";

export async function readPlatformObject(objectKey: string): Promise<Buffer> {
  return Buffer.from(await (await openE2eObjectStore()).read(objectKey));
}

export async function openE2eObjectStore() {
  const directory =
    process.env.AUTOFORGE_E2E_PLATFORM_CONFIG_DIR ?? process.env.AUTOFORGE_E2E_DATA_DIR;
  if (!directory) throw new Error("E2E platform directory is required to verify stored objects.");
  const configuration = new PlatformConfigurationStore(directory).read();
  if (configuration.mode === "lite") return new LocalObjectStore(directory);
  const minio = configuration.full!.minio;
  const endpoint = new URL(minio.endpoint);
  const { MinioObjectStore } =
    await import("../../../packages/object-store/src/minio-object-store");
  return new MinioObjectStore({
    endPoint: endpoint.hostname,
    port: Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80)),
    useSSL: endpoint.protocol === "https:",
    accessKey: minio.accessKey,
    secretKey: minio.secretKey,
    bucket: minio.bucket,
    region: minio.region,
  });
}
