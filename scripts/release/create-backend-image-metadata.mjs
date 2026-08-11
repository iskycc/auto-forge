import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
const [imageReference, version, variant, outputPath] = process.argv.slice(2);
if (!imageReference || !version || !variant || !outputPath) {
  throw new Error("usage: create-backend-image-metadata.mjs IMAGE VERSION VARIANT OUTPUT");
}
const { stdout } = await execute("docker", [
  "image",
  "inspect",
  "--format",
  "{{json .}}",
  imageReference,
]);
const image = JSON.parse(stdout);
if (!/^sha256:[a-f0-9]{64}$/.test(image.Id ?? "")) throw new Error("Docker image ID is invalid.");
await writeFile(
  outputPath,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      product: "AutoForge Backend",
      version,
      variant,
      imageReference,
      immutableImageId: image.Id,
      architecture: image.Architecture,
      operatingSystem: image.Os,
      createdAt: image.Created,
      labels: image.Config?.Labels ?? {},
    },
    null,
    2,
  )}\n`,
);
