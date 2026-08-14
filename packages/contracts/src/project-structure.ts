import { z } from "zod";

const identifierSchema = z.string().trim().min(1).max(128);
const nameSchema = z.string().trim().min(1).max(128);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const archiveFormatSchema = z.enum(["zip", "tar.gz"]);

export const createProjectVersionInputSchema = z.object({ name: nameSchema });

export const createTestStageInputSchema = z.object({
  name: nameSchema,
  description: z.string().trim().max(2_000).default(""),
});

export const runtimeAssetKindSchema = z.enum(["jdk", "jar-bundle"]);

export const runtimeAssetUrlInputSchema = z
  .object({
    kind: runtimeAssetKindSchema,
    url: z
      .url()
      .max(2_048)
      .refine(
        (value) => {
          const url = new URL(value);
          return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
        },
        { message: "运行时资源链接必须使用 HTTP 或 HTTPS，且不能包含凭据。" },
      ),
    fileName: z.string().trim().min(1).max(255),
    sha256: sha256Schema,
    sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    archiveFormat: archiveFormatSchema,
  })
  .superRefine((input, context) => {
    const fileName = input.fileName.toLowerCase();
    const matches =
      input.archiveFormat === "zip"
        ? fileName.endsWith(".zip")
        : fileName.endsWith(".tar.gz") || fileName.endsWith(".tgz");
    if (!matches) {
      context.addIssue({
        code: "custom",
        path: ["fileName"],
        message: "文件名扩展名必须与压缩格式一致。",
      });
    }
  });

export const projectAdapterConfigurationInputSchema = z.object({
  jdkAssetId: identifierSchema.optional(),
  jarBundleAssetId: identifierSchema.optional(),
  expectedRevision: z.number().int().nonnegative(),
});

export const runtimeAssetUploadMetadataSchema = z.object({
  kind: runtimeAssetKindSchema,
  archiveFormat: archiveFormatSchema,
});

export type CreateProjectVersionInput = z.infer<typeof createProjectVersionInputSchema>;
export type CreateTestStageInput = z.infer<typeof createTestStageInputSchema>;
export type RuntimeAssetUrlInput = z.infer<typeof runtimeAssetUrlInputSchema>;
export type ProjectAdapterConfigurationInput = z.infer<
  typeof projectAdapterConfigurationInputSchema
>;
