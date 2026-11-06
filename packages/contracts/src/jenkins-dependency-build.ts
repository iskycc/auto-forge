import { z } from "zod";

export const jenkinsDependencyConnectionSchema = z
  .object({
    jobUrl: z
      .url()
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          /\/job\/[^/]+\/?$/.test(url.pathname)
        );
      }, "请填写 Jenkins 任务地址（以 /job/任务名/ 结尾），不能包含凭据、查询或片段。"),
    username: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .refine((value) => !/[:\r\n]/.test(value), "用户名不能包含冒号或换行。"),
    apiToken: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !/[\r\n]/.test(value), "API 密钥不能包含换行。"),
    parameters: z
      .array(
        z
          .object({
            name: z
              .string()
              .trim()
              .min(1)
              .max(128)
              .refine((value) => !/[\r\n]/.test(value)),
            value: z.string().max(16000),
          })
          .strict(),
      )
      .max(100)
      .superRefine((parameters, context) => {
        const names = new Set<string>();
        for (const [index, parameter] of parameters.entries()) {
          if (names.has(parameter.name))
            context.addIssue({
              code: "custom",
              path: [index, "name"],
              message: "构建参数名称不能重复。",
            });
          names.add(parameter.name);
        }
      }),
  })
  .strict();

export const saveJenkinsDependencyConfigurationSchema = jenkinsDependencyConnectionSchema
  .omit({ apiToken: true })
  .extend({
    apiToken: jenkinsDependencyConnectionSchema.shape.apiToken.optional(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();

export const jenkinsDependencyBuildSchema = z
  .object({
    id: z.string().min(1).max(128),
    status: z.enum([
      "submitting",
      "queued",
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "unknown",
      "closed",
    ]),
    jobUrl: z.url(),
    queueUrl: z.url().optional(),
    buildUrl: z.url().optional(),
    buildNumber: z.number().int().nonnegative().optional(),
    result: z.string().max(128).optional(),
    message: z.string().max(2000).optional(),
    triggeredBy: z.string().max(256),
    triggeredAt: z.iso.datetime(),
    startedAt: z.iso.datetime().optional(),
    finishedAt: z.iso.datetime().optional(),
  })
  .strict();

export const jenkinsDependencyViewSchema = z.object({
  revision: z.number().int().nonnegative(),
  buildRevision: z.number().int().nonnegative(),
  configuration: jenkinsDependencyConnectionSchema
    .omit({ apiToken: true })
    .extend({ apiTokenConfigured: z.boolean() })
    .optional(),
  build: jenkinsDependencyBuildSchema.optional(),
});

export const triggerJenkinsDependencyBuildSchema = z
  .object({
    requestId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_-]+$/),
    expectedRevision: z.number().int().positive(),
    expectedBuildRevision: z.number().int().nonnegative(),
  })
  .strict();

export type JenkinsDependencyConnection = z.infer<typeof jenkinsDependencyConnectionSchema>;
export type JenkinsDependencyBuild = z.infer<typeof jenkinsDependencyBuildSchema>;
export type JenkinsDependencyView = z.infer<typeof jenkinsDependencyViewSchema>;
export type SaveJenkinsDependencyConfiguration = z.infer<
  typeof saveJenkinsDependencyConfigurationSchema
>;
export type TriggerJenkinsDependencyBuild = z.infer<typeof triggerJenkinsDependencyBuildSchema>;

export function isJenkinsDependencyBuildActive(status: JenkinsDependencyBuild["status"]): boolean {
  return ["submitting", "queued", "running", "unknown"].includes(status);
}
