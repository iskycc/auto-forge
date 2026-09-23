"use client";
import { Notice } from "@/components/ui/notice";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import { createUserInputSchema } from "@autoforge/contracts";
import { Plus } from "lucide-react";
import { useState, type FormEvent } from "react";

import { ActionDialog } from "@/components/action-dialog";
import { Button, Input } from "@/components/ui";
import { readApiError } from "@/lib/client-api";
import {
  userCreationValidationErrors,
  type UserCreationValidationError,
} from "@/lib/user-creation-validation";

const userFields = [
  {
    name: "username",
    label: "用户名",
    type: "text",
    autoComplete: "off",
    required: true,
    maxLength: 64,
    hint: "3–64 位，以字母或数字开头，可使用字母、数字、点、下划线和短横线。",
  },
  {
    name: "displayName",
    label: "显示名称",
    type: "text",
    autoComplete: "off",
    required: true,
    maxLength: 120,
    hint: "1–120 个字符，可填写中文姓名或昵称。",
  },
  {
    name: "email",
    label: "邮箱（可选）",
    type: "email",
    autoComplete: "off",
    required: false,
    maxLength: 320,
    hint: "可留空，例如 name@example.com。",
  },
  {
    name: "password",
    label: "初始密码",
    type: "password",
    autoComplete: "new-password",
    required: true,
    maxLength: 128,
    hint: "12–128 位，必须同时包含字母、数字和特殊字符。",
  },
] as const;

type CreationFailure = { message: string; fields: UserCreationValidationError[] };

export function CreateUserDialog({ onClose, onCreated }: { onClose(): void; onCreated(): void }) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<CreationFailure | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const parsed = createUserInputSchema.safeParse({
      username: form.get("username"),
      displayName: form.get("displayName"),
      email: form.get("email") || undefined,
      password: form.get("password"),
      forcePasswordChange: true,
    });
    if (!parsed.success) {
      showFailure(
        formElement,
        "请修正以下内容后重试。",
        userCreationValidationErrors(parsed.error.issues),
      );
      return;
    }

    setPending(true);
    setFailure(null);
    try {
      const response = await fetch("/api/v1/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const apiError = await readApiError(response, "创建用户失败，请稍后重试。");
      if (apiError) {
        const fields =
          apiError.code === "VALIDATION_FAILED"
            ? userCreationValidationErrors(apiError.details)
            : apiError.code === "USER_CONFLICT"
              ? [{ field: "username" as const, message: apiError.message }]
              : [];
        showFailure(
          formElement,
          fields.length ? "请修正以下内容后重试。" : apiError.message,
          fields,
        );
        return;
      }
      onCreated();
    } catch {
      showFailure(formElement, "创建用户请求未完成，请检查网络连接后重试。", []);
    } finally {
      setPending(false);
    }
  }

  function showFailure(
    form: HTMLFormElement,
    message: string,
    fields: UserCreationValidationError[],
  ) {
    setFailure({ message, fields });
    const firstInvalid = fields[0] ? form.elements.namedItem(fields[0].field) : null;
    if (firstInvalid instanceof HTMLInputElement) firstInvalid.focus();
  }

  return (
    <ActionDialog
      description="创建本地账号后，用户首次登录必须修改初始密码。"
      onClose={() => {
        if (!pending) onClose();
      }}
      open
      title="创建本地用户"
      protectUnsavedChanges
      closeDisabled={pending}
      footer={
        <>
          <Button disabled={pending} data-dialog-dismiss onClick={onClose} type="button">
            取消
          </Button>
          <Button disabled={pending} type="submit" form="create-local-user" variant="primary">
            <Plus size={16} /> {pending ? "正在创建…" : "创建本地用户"}
          </Button>
        </>
      }
    >
      <form
        id="create-local-user"
        className={cn(
          "settings-grid-form action-dialog-form create-user-form",
          uiPatterns["settings-grid-form"],
          createUserDialogStyles["action-dialog-form"],
          createUserDialogStyles["create-user-form"],
        )}
        noValidate
        onSubmit={submit}
      >
        {userFields.map(({ name, label, hint, ...inputProps }) => {
          const invalid = failure?.fields.some(({ field }) => field === name) ?? false;
          const id = `create-user-${name}`;
          return (
            <div
              className={cn("create-user-field", createUserDialogStyles["create-user-field"])}
              key={name}
            >
              <label htmlFor={id}>{label}</label>
              <Input
                {...inputProps}
                aria-describedby={`${id}-hint${invalid ? ` ${id}-error` : ""}`}
                aria-invalid={invalid}
                id={id}
                name={name}
                readOnly={pending}
              />
              <p className={cn("field-hint", uiPatterns["field-hint"])} id={`${id}-hint`}>
                {hint}
              </p>
            </div>
          );
        })}
        {failure ? (
          <Notice
            tone="error"
            className={cn(
              "auth-error settings-wide-field create-user-error",
              uiPatterns["auth-error"],
              uiPatterns["settings-wide-field"],
              createUserDialogStyles["create-user-error"],
            )}
            role="alert"
          >
            <p>{failure.message}</p>
            {failure.fields.length ? (
              <ul>
                {failure.fields.map(({ field, message }) => (
                  <li id={`create-user-${field}-error`} key={field}>
                    {message}
                  </li>
                ))}
              </ul>
            ) : null}
          </Notice>
        ) : null}
      </form>
    </ActionDialog>
  );
}

const createUserDialogStyles = {
  "action-dialog-form": "mt-0",
  "create-user-error":
    "[&_p]:m-0 [&_p]:leading-[1.5] [&_p]:[overflow-wrap:anywhere] [&_ul]:grid [&_ul]:gap-1 [&_ul]:[margin:8px_0_0] [&_ul]:pl-5 [&_ul]:[overflow-wrap:anywhere]",
  "create-user-field":
    "grid min-w-0 gap-2 [&_.field-hint]:m-0 [&_.field-hint]:leading-[1.5] [&_.field-hint]:[overflow-wrap:anywhere]",
  "create-user-form": "items-start",
} as const;
