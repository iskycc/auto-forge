import { randomUUID } from "node:crypto";

import { DomainError } from "@autoforge/domain";
import { JarInspectionError } from "@autoforge/testng-discovery";
import { NextResponse } from "next/server";
import { ZodError } from "zod";

export type JarUpload = {
  fileName: string;
  content: Uint8Array;
};

export async function readJarUpload(request: Request, maxJarBytes: number): Promise<JarUpload> {
  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    throw new DomainError("FILE_REQUIRED", "请选择要上传的 JAR 文件。");
  }
  if (file.size === 0) {
    throw new DomainError("EMPTY_JAR", "JAR 文件为空。");
  }
  if (file.size > maxJarBytes) {
    throw new DomainError("JAR_TOO_LARGE", `JAR 超过 ${maxJarBytes} 字节的导入限制。`);
  }
  return {
    fileName: file.name,
    content: new Uint8Array(await file.arrayBuffer()),
  };
}

export function apiErrorResponse(error: unknown, requestId = randomUUID()): NextResponse {
  if (error instanceof DomainError || error instanceof JarInspectionError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message, requestId } },
      { status: 400 },
    );
  }
  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: "请求数据校验失败。",
          requestId,
          details: error.issues,
        },
      },
      { status: 400 },
    );
  }
  return NextResponse.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "服务器处理请求失败。",
        requestId,
      },
    },
    { status: 500 },
  );
}
