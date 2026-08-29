import { z } from "zod";

const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "用户名格式无效。");

const loginIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[^\u0000-\u001F\u007F]+$/u, "用户名不能包含控制字符。");

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
  username: loginIdentifierSchema,
  password: z.string().min(1).max(1024),
  // Accepted temporarily for compatibility with older API clients. Authentication source is
  // resolved authoritatively from the stored user and LDAP configuration, never from this hint.
  provider: z.enum(["local", "ldap"]).optional(),
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

const ldapAttributeSchema = z
  .string()
  .trim()
  .max(128)
  .regex(/^[a-zA-Z][a-zA-Z0-9;-]*$/u, "LDAP 属性格式不正确。");

const ldapConfigurationCompatibilitySchema = z.object({
  enabled: z.boolean(),
  url: z.string().trim().max(2_048).optional(),
  // v1 compatibility: older clients submitted a server array plus an explicit TLS mode.
  urls: z.array(z.string().trim().max(2_048)).min(1).max(4).optional(),
  tlsMode: z.enum(["ldaps", "starttls"]).optional(),
  verifyTlsCertificate: z.boolean().default(true),
  caPem: z.string().max(128_000).optional(),
  connectTimeoutMs: z.number().int().min(1_000).max(30_000).default(5_000),
  operationTimeoutMs: z.number().int().min(500).max(60_000).default(10_000),
  pageSize: z.number().int().min(50).max(1_000).default(500),
  maximumUsers: z.number().int().min(1).max(50_000).default(5_000),
  synchronizationIntervalMinutes: z.number().int().min(0).max(10_080).default(0),
  bindDn: z.string().trim().max(2_048).default(""),
  bindPassword: z.string().min(1).max(4_096).optional(),
  clearBindPassword: z.boolean().default(false),
  userBaseDn: z.string().trim().max(2_048).default(""),
  userFilter: z.string().trim().min(1).max(1_024).default("(uid={{username}})"),
  usernameAttribute: ldapAttributeSchema.default("uid"),
  displayNameAttribute: ldapAttributeSchema.default("displayName"),
  emailAttribute: ldapAttributeSchema.or(z.literal("")).default("mail"),
  groupAttribute: ldapAttributeSchema.or(z.literal("")).optional(),
  groupSearchBase: z.string().trim().max(2_048).optional(),
  groupSearchFilter: z.string().trim().max(1_024).optional(),
  groupNameAttribute: ldapAttributeSchema.or(z.literal("")).optional(),
  defaultRole: z.enum(["admin", "editor", "viewer"]).default("editor"),
  // v1 compatibility aliases. They are normalized to the ddt-insight field names below.
  userIdAttribute: ldapAttributeSchema.optional(),
  groupBaseDn: z.string().trim().max(2_048).optional(),
  groupFilter: z.string().trim().max(1_024).optional(),
  groupMemberAttribute: ldapAttributeSchema.optional(),
});

export const ldapConfigurationInputSchema = ldapConfigurationCompatibilitySchema
  .superRefine((value, context) => {
    const url = value.url ?? value.urls?.[0] ?? "";
    if (value.enabled && !url) {
      context.addIssue({
        code: "custom",
        path: ["url"],
        message: "启用 LDAP 时必须填写服务地址。",
      });
    }
    if (url) validateLdapUrl(url, context);
    if (value.enabled && !value.userBaseDn) {
      context.addIssue({
        code: "custom",
        path: ["userBaseDn"],
        message: "启用 LDAP 时必须填写用户 Base DN。",
      });
    }
    if (!hasUsernamePlaceholder(value.userFilter)) {
      context.addIssue({
        code: "custom",
        path: ["userFilter"],
        message: "用户过滤器必须包含 {{username}} 占位符。",
      });
    }
    const groupSearchBase = value.groupSearchBase ?? value.groupBaseDn ?? "";
    const groupSearchFilter = value.groupSearchFilter ?? value.groupFilter ?? "";
    if (groupSearchBase && value.groupNameAttribute === "") {
      context.addIssue({
        code: "custom",
        path: ["groupNameAttribute"],
        message: "配置 Group Search Base 时必须填写 Group 名称属性。",
      });
    }
    if (
      groupSearchBase &&
      !groupSearchFilter.includes("{{userDn}}") &&
      !groupSearchFilter.includes("{{username}}") &&
      !groupSearchFilter.includes("{userDn}") &&
      !groupSearchFilter.includes("{username}")
    ) {
      context.addIssue({
        code: "custom",
        path: ["groupSearchFilter"],
        message: "Group 过滤器必须包含 {{userDn}} 或 {{username}} 占位符。",
      });
    }
  })
  .transform((value) => {
    const rawUrl = value.url ?? value.urls?.[0] ?? "";
    const groupSearchBase = value.groupSearchBase ?? value.groupBaseDn ?? "";
    const groupSearchFilter = normalizeDirectoryFilter(
      value.groupSearchFilter ?? value.groupFilter ?? "(member={{userDn}})",
    );
    return {
      enabled: value.enabled,
      // Historical StartTLS clients already declared their transport separately. Preserve their
      // ldap:// URL verbatim so an unusual port cannot be reinterpreted as implicit TLS.
      url: value.tlsMode === "starttls" ? rawUrl : normalizeLdapUrl(rawUrl),
      verifyTlsCertificate: value.verifyTlsCertificate,
      ...(value.caPem ? { caPem: value.caPem } : {}),
      connectTimeoutMs: value.connectTimeoutMs,
      operationTimeoutMs: value.operationTimeoutMs,
      pageSize: value.pageSize,
      maximumUsers: value.maximumUsers,
      synchronizationIntervalMinutes: value.synchronizationIntervalMinutes,
      bindDn: value.bindDn,
      ...(value.bindPassword ? { bindPassword: value.bindPassword } : {}),
      clearBindPassword: value.clearBindPassword,
      userBaseDn: value.userBaseDn,
      userFilter: normalizeDirectoryFilter(value.userFilter),
      usernameAttribute: value.usernameAttribute,
      displayNameAttribute: value.displayNameAttribute,
      emailAttribute: value.emailAttribute,
      groupAttribute: value.groupAttribute ?? value.groupMemberAttribute ?? "memberOf",
      groupSearchBase,
      groupSearchFilter,
      groupNameAttribute: value.groupNameAttribute ?? "cn",
      defaultRole: value.defaultRole,
      ...(value.tlsMode === "starttls" ? { legacyStartTls: true as const } : {}),
    };
  });

function validateLdapUrl(value: string, context: z.RefinementCtx): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    context.addIssue({ code: "custom", path: ["url"], message: "LDAP 服务地址格式不正确。" });
    return;
  }
  if (parsed.protocol !== "ldap:" && parsed.protocol !== "ldaps:") {
    context.addIssue({
      code: "custom",
      path: ["url"],
      message: "LDAP 服务地址必须使用 ldap:// 或 ldaps://。",
    });
  }
  if (!parsed.hostname || parsed.username || parsed.password) {
    context.addIssue({
      code: "custom",
      path: ["url"],
      message: "LDAP 服务地址不能包含用户名或密码。",
    });
  }
  if ((parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) {
    context.addIssue({
      code: "custom",
      path: ["url"],
      message: "LDAP 服务地址只能包含协议、主机和端口。",
    });
  }
}

function normalizeLdapUrl(value: string): string {
  if (!value) return "";
  const parsed = new URL(value);
  return parsed.protocol === "ldap:" && (parsed.port === "636" || parsed.port === "3269")
    ? value.replace(/^ldap:/iu, "ldaps:")
    : value;
}

function hasUsernamePlaceholder(value: string): boolean {
  return value.includes("{{username}}") || value.includes("{username}");
}

function normalizeDirectoryFilter(value: string): string {
  let normalized = value;
  if (!normalized.includes("{{username}}")) {
    normalized = normalized.replaceAll("{username}", "{{username}}");
  }
  if (!normalized.includes("{{userDn}}")) {
    normalized = normalized.replaceAll("{userDn}", "{{userDn}}");
  }
  return normalized;
}

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
