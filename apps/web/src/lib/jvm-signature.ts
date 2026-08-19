/**
 * 将 JVM 方法描述符渲染为中文可读签名。
 * 原始描述符（如 `()V`）对非 JVM 用户是噪音；展示层统一映射为
 * “入参：…，返回值：…”（如“入参：空，返回值：空”）。
 * 数据与契约仍保留原始 descriptor，重载方法的精确区分不受影响。
 */

const PRIMITIVE_TYPE_NAMES: Record<string, string> = {
  B: "byte",
  C: "char",
  D: "double",
  F: "float",
  I: "int",
  J: "long",
  S: "short",
  Z: "boolean",
};

export type MethodSignature = {
  parameterTypes: string[];
  returnType: string;
};

/** 解析失败返回 null；展示层使用中文未知状态，不暴露原始 JVM 符号。 */
export function parseMethodDescriptor(descriptor: string): MethodSignature | null {
  if (!descriptor.startsWith("(")) return null;
  const closeIndex = descriptor.indexOf(")");
  if (closeIndex < 0) return null;

  const parameterTypes: string[] = [];
  let cursor = 1;
  while (cursor < closeIndex) {
    const parameter = parseFieldType(descriptor, cursor);
    if (!parameter || parameter.name === "void") return null;
    parameterTypes.push(parameter.name);
    cursor = parameter.nextIndex;
  }

  const returnType = parseFieldType(descriptor, closeIndex + 1);
  if (!returnType || returnType.nextIndex !== descriptor.length) return null;
  return { parameterTypes, returnType: returnType.name };
}

export function formatMethodSignature(descriptor: string): string {
  const parsed = parseMethodDescriptor(descriptor);
  if (!parsed) return "入参：无法识别，返回值：无法识别";
  const parameters = parsed.parameterTypes.length > 0 ? parsed.parameterTypes.join("、") : "空";
  const returnType = parsed.returnType === "void" ? "空" : parsed.returnType;
  return `入参：${parameters}，返回值：${returnType}`;
}

function parseFieldType(
  descriptor: string,
  start: number,
): { name: string; nextIndex: number } | null {
  let cursor = start;
  let arrayDepth = 0;
  while (descriptor[cursor] === "[") {
    arrayDepth += 1;
    cursor += 1;
  }

  const head = descriptor[cursor];
  let name: string;
  let nextIndex = cursor + 1;
  if (head === "V") {
    if (arrayDepth > 0) return null;
    name = "void";
  } else if (head !== undefined && PRIMITIVE_TYPE_NAMES[head]) {
    name = PRIMITIVE_TYPE_NAMES[head];
  } else if (head === "L") {
    const end = descriptor.indexOf(";", cursor);
    if (end < 0) return null;
    const internal = descriptor.slice(cursor + 1, end);
    const simpleName = internal.split("/").pop() ?? "";
    if (simpleName.length === 0) return null;
    name = simpleName;
    nextIndex = end + 1;
  } else {
    return null;
  }

  return { name: `${name}${"[]".repeat(arrayDepth)}`, nextIndex };
}
