import { PlatformConfigurationStore } from "@autoforge/platform-config";
import { LocalObjectStore } from "../../../packages/object-store/src/local-object-store";

export async function readPlatformObject(objectKey: string): Promise<Buffer> {
  const directory =
    process.env.AUTOFORGE_E2E_PLATFORM_CONFIG_DIR ?? process.env.AUTOFORGE_E2E_DATA_DIR;
  if (!directory) throw new Error("E2E platform directory is required to verify stored objects.");
  const configuration = new PlatformConfigurationStore(directory).read();
  if (configuration.mode === "lite")
    return Buffer.from(await new LocalObjectStore(directory).read(objectKey));
  const minio = configuration.full!.minio;
  const endpoint = new URL(minio.endpoint);
  const { MinioObjectStore } =
    await import("../../../packages/object-store/src/minio-object-store");
  const objects = new MinioObjectStore({
    endPoint: endpoint.hostname,
    port: Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80)),
    useSSL: endpoint.protocol === "https:",
    accessKey: minio.accessKey,
    secretKey: minio.secretKey,
    bucket: minio.bucket,
    region: minio.region,
  });
  return Buffer.from(await objects.read(objectKey));
}
