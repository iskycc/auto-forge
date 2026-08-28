import { z } from "zod";

const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "用户名格式无效。");

const passwordSchema = z
  .string()
  .min(12)
  .max(128)
  .regex(/[A-Za-z]/, "密码必须包含字母。")
  .regex(/[0-9]/, "密码必须包含数字。")
  .regex(/[^A-Za-z0-9]/, "密码必须包含特殊字符。");

export const bootstrapAdminInputSchema = z.object({
  bootstrapToken: z.string().min(32).max(1024),
  username: usernameSchema,
  displayName: z.string().trim().min(1).max(120),
  password: passwordSchema,
});

export const loginInputSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1).max(1024),
  provider: z.enum(["local", "ldap"]).default("local"),
});

export const createUserInputSchema = z.object({
  username: usernameSchema,
  displayName: z.string().trim().min(1).max(120),
  email: z.email().max(320).optional(),
  password: passwordSchema,
  forcePasswordChange: z.boolean().default(true),
});

export const updateUserStatusInputSchema = z.object({
  status: z.enum(["active", "disabled"]),
});

export const resetUserPasswordInputSchema = z.object({
  password: passwordSchema,
  forcePasswordChange: z.boolean().default(true),
});

export const changePasswordInputSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: passwordSchema,
});

export const sessionListQuerySchema = z.object({
  userId: z.string().min(1).max(128).optional(),
});

export const createRoleInputSchema = z.object({
  key: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).default(""),
  scope: z.enum(["system", "project"]),
  permissions: z.array(z.string().min(1).max(128)).min(1).max(128),
});

export const updateRoleInputSchema = createRoleInputSchema
  .omit({ key: true })
  .partial()
  .extend({ active: z.boolean().optional() })
  .refine((value) => Object.keys(value).length > 0, "至少提供一个修改字段。");

export const assignSystemRoleInputSchema = z.object({
  roleId: z.string().min(1).max(128),
});

export const assignProjectRoleInputSchema = assignSystemRoleInputSchema.extend({
  projectId: z.string().min(1).max(128),
});

export const createProjectInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
});

export const transferProjectOwnerInputSchema = z.object({
  ownerUserId: z.string().min(1).max(128),
});

export const ldapConfigurationInputSchema = z
  .object({
    enabled: z.boolean(),
    urls: z.array(z.url()).min(1).max(4),
    tlsMode: z.enum(["ldaps", "starttls"]),
    verifyTlsCertificate: z.boolean().default(true),
    caPem: z.string().max(128_000).optional(),
    connectTimeoutMs: z.number().int().min(500).max(30_000).default(5_000),
    operationTimeoutMs: z.number().int().min(500).max(60_000).default(10_000),
    pageSize: z.number().int().min(50).max(1_000).default(500),
    maximumUsers: z.number().int().min(1).max(50_000).default(5_000),
    synchronizationIntervalMinutes: z.number().int().min(0).max(10_080).default(0),
    bindDn: z.string().trim().min(1).max(1024),
    bindPassword: z.string().min(1).max(4096).optional(),
    userBaseDn: z.string().trim().min(1).max(1024),
    userFilter: z.string().trim().min(1).max(1024),
    userIdAttribute: z.string().trim().min(1).max(128).default("entryUUID"),
    usernameAttribute: z.string().trim().min(1).max(128).default("uid"),
    displayNameAttribute: z.string().trim().min(1).max(128).default("displayName"),
    emailAttribute: z.string().trim().min(1).max(128).default("mail"),
    groupBaseDn: z.string().trim().max(1024).optional(),
    groupFilter: z.string().trim().max(1024).optional(),
    groupMemberAttribute: z.string().trim().min(1).max(128).default("member"),
  })
  .superRefine((value, context) => {
    if (!value.userFilter.includes("{username}")) {
      context.addIssue({
        code: "custom",
        path: ["userFilter"],
        message: "用户过滤器必须包含 {username} 占位符。",
      });
    }
    if (value.tlsMode === "ldaps" && value.urls.some((url) => !url.startsWith("ldaps://"))) {
      context.addIssue({ code: "custom", path: ["urls"], message: "LDAPS 模式只允许 ldaps://。" });
    }
    if (value.tlsMode === "starttls" && value.urls.some((url) => !url.startsWith("ldap://"))) {
      context.addIssue({
        code: "custom",
        path: ["urls"],
        message: "StartTLS 模式只允许 ldap://。",
      });
    }
  });

export const ldapGroupMappingInputSchema = z.object({
  groupDn: z.string().trim().min(1).max(1024),
  roleId: z.string().min(1).max(128),
  projectId: z.string().min(1).max(128).optional(),
  priority: z.number().int().min(-1_000).max(1_000).default(0),
});

export const auditListQuerySchema = z.object({
  projectId: z.string().min(1).max(128).optional(),
  actorId: z.string().optional(),
  action: z.string().optional(),
  resourceType: z.string().optional(),
  result: z.enum(["succeeded", "rejected", "failed"]).optional(),
  recordedAfter: z.iso.datetime({ offset: true }).optional(),
  recordedBefore: z.iso.datetime({ offset: true }).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export type BootstrapAdminInput = z.infer<typeof bootstrapAdminInputSchema>;
export type LoginInput = z.infer<typeof loginInputSchema>;
export type CreateUserInput = z.infer<typeof createUserInputSchema>;
export type CreateRoleInput = z.infer<typeof createRoleInputSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleInputSchema>;
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;
export type TransferProjectOwnerInput = z.infer<typeof transferProjectOwnerInputSchema>;
export type LdapConfigurationInput = z.infer<typeof ldapConfigurationInputSchema>;
export type LdapGroupMappingInput = z.infer<typeof ldapGroupMappingInputSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordInputSchema>;
