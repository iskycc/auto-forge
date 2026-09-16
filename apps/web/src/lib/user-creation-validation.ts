import { z } from "zod";

import { validationIssueMessage } from "./form-validation";

const fieldLabels = {
  username: "用户名",
  displayName: "显示名称",
  email: "邮箱",
  password: "初始密码",
  forcePasswordChange: "首次登录修改密码",
};

const issueSchema = z.object({
  path: z.tuple([z.enum(["username", "displayName", "email", "password", "forcePasswordChange"])]),
  message: z.string().trim().min(1),
});

export type UserCreationValidationError = {
  field: keyof typeof fieldLabels;
  message: string;
};

export function userCreationValidationErrors(details: unknown): UserCreationValidationError[] {
  if (!Array.isArray(details)) return [];
  const messagesByField = new Map<keyof typeof fieldLabels, Set<string>>();
  for (const candidate of details) {
    const parsed = issueSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const field = parsed.data.path[0];
    const messages = messagesByField.get(field) ?? new Set<string>();
    messages.add(parsed.data.message);
    messagesByField.set(field, messages);
  }
  return Array.from(messagesByField, ([field, messages]) => ({
    field,
    message: validationIssueMessage(
      [{ path: [field], message: Array.from(messages).join(" ") }],
      fieldLabels,
    )!,
  }));
}
