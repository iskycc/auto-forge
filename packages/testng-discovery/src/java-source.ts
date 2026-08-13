import { createHash } from "node:crypto";

import type {
  JavaSourceReference,
  TestNgClassCandidate,
  TestNgMethodCandidate,
} from "@autoforge/contracts";

const TEST_ANNOTATION = "org.testng.annotations.Test";
const JAVA_LANG_TYPES = new Set([
  "Boolean",
  "Byte",
  "Character",
  "Class",
  "Double",
  "Enum",
  "Exception",
  "Float",
  "Integer",
  "Long",
  "Number",
  "Object",
  "RuntimeException",
  "Short",
  "String",
  "StringBuilder",
  "Throwable",
  "Void",
]);
const DECLARATION_MODIFIERS = new Set([
  "abstract",
  "default",
  "final",
  "native",
  "private",
  "protected",
  "public",
  "static",
  "strictfp",
  "synchronized",
  "transient",
  "volatile",
]);
const CONTROL_KEYWORDS = new Set(["catch", "do", "for", "if", "new", "switch", "try", "while"]);

type Token = {
  kind: "identifier" | "number" | "string" | "symbol";
  value: string;
};

type Annotation = {
  name: string;
  arguments: Token[];
};

type ParsedMethod = {
  methodName: string;
  descriptor: string;
  public: boolean;
  test?: TestAnnotation;
};

type TestAnnotation = {
  enabled: boolean;
  groups: string[];
  description?: string;
  dataProvider?: string;
  dependsOnMethods: string[];
  dependsOnGroups: string[];
  priority?: number;
};

type SourceContext = {
  packageName: string;
  imports: Map<string, string>;
  testAnnotationImported: boolean;
};

export function isSafeJavaSourceEntry(entryPath: string): boolean {
  if (!entryPath.endsWith(".java") || entryPath.startsWith("/") || entryPath.includes("\\")) {
    return false;
  }
  const segments = entryPath.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export function parseJavaTestSource(
  entryPath: string,
  content: Uint8Array,
): TestNgClassCandidate | null {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(content);
  const tokens = tokenize(source);
  const context = sourceContext(tokens);
  const declaration = findTopLevelClass(tokens);
  if (!declaration) return null;
  const classTest = testAnnotation(declaration.annotations, context);
  const parsedMethods = parseMethods(
    tokens,
    declaration.bodyStart,
    declaration.bodyEnd,
    declaration.simpleName,
    context,
  );
  const methods = parsedMethods.flatMap((method): TestNgMethodCandidate[] => {
    if (!method.test && (!classTest || !method.public)) return [];
    const annotation = method.test ?? classTest;
    if (!annotation) return [];
    return [
      {
        methodName: method.methodName,
        descriptor: method.descriptor,
        enabled: (classTest?.enabled ?? true) && annotation.enabled,
        annotationSource: method.test ? "method" : "class",
        groups: sortedUnique([...(classTest?.groups ?? []), ...annotation.groups]),
        ...(annotation.description ? { description: annotation.description } : {}),
        ...(annotation.dataProvider ? { dataProvider: annotation.dataProvider } : {}),
        dependsOnMethods: annotation.dependsOnMethods,
        dependsOnGroups: annotation.dependsOnGroups,
        ...(annotation.priority !== undefined ? { priority: annotation.priority } : {}),
      },
    ];
  });
  if (!classTest && methods.length === 0) return null;
  const className = context.packageName
    ? `${context.packageName}.${declaration.simpleName}`
    : declaration.simpleName;
  const sourceReference: JavaSourceReference = {
    entryPath,
    sha256: createHash("sha256").update(content).digest("hex"),
    sizeBytes: content.byteLength,
  };
  return {
    className,
    packageName: context.packageName,
    simpleName: declaration.simpleName,
    enabled: classTest?.enabled ?? true,
    classLevelTest: Boolean(classTest),
    groups: classTest?.groups ?? [],
    parameters: {},
    source: sourceReference,
    methods: methods.sort((left, right) =>
      `${left.methodName}${left.descriptor}`.localeCompare(
        `${right.methodName}${right.descriptor}`,
      ),
    ),
  };
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index] ?? "";
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      index = skipLineComment(source, index + 2);
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      index = skipBlockComment(source, index + 2);
      continue;
    }
    if (character === '"' || character === "'") {
      const literal = readQuoted(source, index, character);
      tokens.push({ kind: "string", value: literal.value });
      index = literal.next;
      continue;
    }
    if (/[A-Za-z_$]/u.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_$]/u.test(source[index] ?? "")) index += 1;
      tokens.push({ kind: "identifier", value: source.slice(start, index) });
      continue;
    }
    if (/\d/u.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[\d_a-fA-FxX.+-]/u.test(source[index] ?? "")) index += 1;
      tokens.push({ kind: "number", value: source.slice(start, index) });
      continue;
    }
    if (source.startsWith("...", index)) {
      tokens.push({ kind: "symbol", value: "..." });
      index += 3;
      continue;
    }
    tokens.push({ kind: "symbol", value: character });
    index += 1;
  }
  return tokens;
}

function skipLineComment(source: string, index: number): number {
  const newline = source.indexOf("\n", index);
  return newline === -1 ? source.length : newline + 1;
}

function skipBlockComment(source: string, index: number): number {
  const closing = source.indexOf("*/", index);
  return closing === -1 ? source.length : closing + 2;
}

function readQuoted(source: string, start: number, quote: string): { value: string; next: number } {
  let value = "";
  let index = start + 1;
  while (index < source.length) {
    const character = source[index] ?? "";
    if (character === quote) return { value, next: index + 1 };
    if (character === "\\" && index + 1 < source.length) {
      const escaped = source[index + 1] ?? "";
      value += { n: "\n", r: "\r", t: "\t" }[escaped] ?? escaped;
      index += 2;
      continue;
    }
    value += character;
    index += 1;
  }
  throw new Error("Java 源文件包含未闭合的字符串或字符字面量。");
}

function sourceContext(tokens: Token[]): SourceContext {
  let packageName = "";
  const imports = new Map<string, string>();
  let testAnnotationImported = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.value === "class" || token?.value === "interface" || token?.value === "record") {
      break;
    }
    if (token?.value !== "package" && token?.value !== "import") continue;
    const end = tokens.findIndex((candidate, candidateIndex) =>
      candidateIndex > index ? candidate.value === ";" : false,
    );
    if (end === -1) break;
    const qualified = tokens
      .slice(index + 1, end)
      .filter((candidate) => candidate.value !== "static")
      .map((candidate) => candidate.value)
      .join("");
    if (token.value === "package") packageName = qualified;
    else if (qualified === "org.testng.annotations.*" || qualified === TEST_ANNOTATION) {
      testAnnotationImported = true;
    }
    if (token.value === "import" && !qualified.endsWith(".*")) {
      const simpleName = qualified.split(".").at(-1);
      if (simpleName) imports.set(simpleName, qualified);
    }
    index = end;
  }
  return { packageName, imports, testAnnotationImported };
}

function findTopLevelClass(tokens: Token[]): {
  simpleName: string;
  annotations: Annotation[];
  bodyStart: number;
  bodyEnd: number;
} | null {
  let depth = 0;
  let annotations: Annotation[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.value === "{" || token.value === "(") depth += 1;
    if (token.value === "}" || token.value === ")") depth -= 1;
    if (depth !== 0) continue;
    if (token.value === "@") {
      const parsed = readAnnotation(tokens, index);
      annotations.push(parsed.annotation);
      index = parsed.next - 1;
      continue;
    }
    if (token.value === ";") {
      annotations = [];
      continue;
    }
    if (token.value !== "class" && token.value !== "record") continue;
    const simpleName = tokens[index + 1]?.value;
    if (!simpleName) return null;
    const bodyStart = findToken(tokens, "{", index + 2);
    if (bodyStart === -1) return null;
    const bodyEnd = matchingToken(tokens, bodyStart, "{", "}");
    if (bodyEnd === -1) return null;
    return { simpleName, annotations, bodyStart, bodyEnd };
  }
  return null;
}

function parseMethods(
  tokens: Token[],
  bodyStart: number,
  bodyEnd: number,
  className: string,
  context: SourceContext,
): ParsedMethod[] {
  const methods: ParsedMethod[] = [];
  let depth = 1;
  let declarationStart = bodyStart + 1;
  let annotations: Annotation[] = [];
  for (let index = bodyStart + 1; index < bodyEnd; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (depth === 1 && token.value === "@") {
      const parsed = readAnnotation(tokens, index);
      annotations.push(parsed.annotation);
      declarationStart = parsed.next;
      index = parsed.next - 1;
      continue;
    }
    if (depth === 1 && token.value === "(") {
      const close = matchingToken(tokens, index, "(", ")");
      const method = parseMethodDeclaration(
        tokens,
        declarationStart,
        index,
        close,
        className,
        annotations,
        context,
      );
      if (method) methods.push(method);
      annotations = [];
      if (close !== -1) index = close;
      continue;
    }
    if (token.value === "{") depth += 1;
    if (token.value === "}") {
      depth -= 1;
      if (depth === 1) declarationStart = index + 1;
    }
    if (depth === 1 && token.value === ";") {
      annotations = [];
      declarationStart = index + 1;
    }
  }
  return methods;
}

function parseMethodDeclaration(
  tokens: Token[],
  declarationStart: number,
  openParenthesis: number,
  closeParenthesis: number,
  className: string,
  annotations: Annotation[],
  context: SourceContext,
): ParsedMethod | null {
  if (closeParenthesis === -1) return null;
  const methodName = tokens[openParenthesis - 1]?.value;
  if (!methodName || CONTROL_KEYWORDS.has(methodName) || methodName === className) return null;
  const prefix = tokens.slice(declarationStart, openParenthesis - 1);
  if (prefix.length === 0 || prefix.some((token) => token.value === "=")) return null;
  const publicMethod = prefix.some((token) => token.value === "public");
  const returnTypeTokens = declarationTypeTokens(prefix);
  if (returnTypeTokens.length === 0) return null;
  const parameterDescriptors = splitTopLevel(
    tokens.slice(openParenthesis + 1, closeParenthesis),
    ",",
  )
    .filter((parameter) => parameter.length > 0)
    .map((parameter) => descriptorForParameter(parameter, context));
  const returnDescriptor = descriptorForType(returnTypeTokens, context);
  const methodTest = testAnnotation(annotations, context);
  return {
    methodName,
    descriptor: `(${parameterDescriptors.join("")})${returnDescriptor}`,
    public: publicMethod,
    ...(methodTest ? { test: methodTest } : {}),
  };
}

function declarationTypeTokens(prefix: Token[]): Token[] {
  let tokens = prefix.filter((token) => !DECLARATION_MODIFIERS.has(token.value));
  if (tokens[0]?.value === "<") {
    const genericEnd = matchingToken(tokens, 0, "<", ">");
    if (genericEnd !== -1) tokens = tokens.slice(genericEnd + 1);
  }
  return tokens;
}

function descriptorForParameter(parameter: Token[], context: SourceContext): string {
  const withoutAnnotations = removeAnnotations(parameter).filter(
    (token) => token.value !== "final" && token.value !== "volatile",
  );
  let parameterNameIndex = -1;
  for (let index = withoutAnnotations.length - 1; index >= 0; index -= 1) {
    if (withoutAnnotations[index]?.kind === "identifier") {
      parameterNameIndex = index;
      break;
    }
  }
  if (parameterNameIndex <= 0) throw new Error("Java 测试方法参数声明无法静态解析。");
  const trailingArrays = withoutAnnotations
    .slice(parameterNameIndex + 1)
    .filter((token) => token.value === "[").length;
  const typeTokens = withoutAnnotations.slice(0, parameterNameIndex);
  for (let index = 0; index < trailingArrays; index += 1) typeTokens.push(symbol("["), symbol("]"));
  return descriptorForType(typeTokens, context);
}

function descriptorForType(typeTokens: Token[], context: SourceContext): string {
  const tokens = eraseGenerics(typeTokens);
  let dimensions = tokens.filter((token) => token.value === "[").length;
  if (tokens.some((token) => token.value === "...")) dimensions += 1;
  const typeName = tokens
    .filter((token) => !["[", "]", "...", "?", "extends", "super"].includes(token.value))
    .map((token) => token.value)
    .join("");
  const primitive: Record<string, string> = {
    boolean: "Z",
    byte: "B",
    char: "C",
    double: "D",
    float: "F",
    int: "I",
    long: "J",
    short: "S",
    void: "V",
  };
  const base =
    primitive[typeName] ?? `L${qualifiedTypeName(typeName, context).replaceAll(".", "/")};`;
  return `${"[".repeat(dimensions)}${base}`;
}

function qualifiedTypeName(typeName: string, context: SourceContext): string {
  if (typeName.includes(".")) return typeName;
  const imported = context.imports.get(typeName);
  if (imported) return imported;
  if (JAVA_LANG_TYPES.has(typeName)) return `java.lang.${typeName}`;
  return context.packageName ? `${context.packageName}.${typeName}` : typeName;
}

function removeAnnotations(tokens: Token[]): Token[] {
  const result: Token[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.value !== "@") {
      result.push(tokens[index]!);
      continue;
    }
    index = readAnnotation(tokens, index).next - 1;
  }
  return result;
}

function eraseGenerics(tokens: Token[]): Token[] {
  const result: Token[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (token.value === "<") {
      depth += 1;
      continue;
    }
    if (token.value === ">") {
      depth -= 1;
      continue;
    }
    if (depth === 0) result.push(token);
  }
  return result;
}

function readAnnotation(tokens: Token[], start: number): { annotation: Annotation; next: number } {
  let index = start + 1;
  const name: string[] = [];
  const first = tokens[index];
  if (first?.kind === "identifier") {
    name.push(first.value);
    index += 1;
  }
  while (tokens[index]?.value === "." && tokens[index + 1]?.kind === "identifier") {
    name.push(".", tokens[index + 1]!.value);
    index += 2;
  }
  let arguments_: Token[] = [];
  if (tokens[index]?.value === "(") {
    const end = matchingToken(tokens, index, "(", ")");
    if (end === -1) throw new Error("Java 注解参数未闭合。");
    arguments_ = tokens.slice(index + 1, end);
    index = end + 1;
  }
  return { annotation: { name: name.join(""), arguments: arguments_ }, next: index };
}

function testAnnotation(
  annotations: Annotation[],
  context: SourceContext,
): TestAnnotation | undefined {
  const annotation = annotations.find(
    (candidate) =>
      candidate.name === TEST_ANNOTATION ||
      (candidate.name === "Test" && context.testAnnotationImported),
  );
  if (!annotation) return undefined;
  const values = annotationValues(annotation.arguments);
  const description = scalarString(values.get("description"));
  const dataProvider = scalarString(values.get("dataProvider"));
  const priority = scalarInteger(values.get("priority"));
  return {
    enabled: scalarBoolean(values.get("enabled")) ?? true,
    groups: scalarStrings(values.get("groups")),
    ...(description ? { description } : {}),
    ...(dataProvider ? { dataProvider } : {}),
    dependsOnMethods: scalarStrings(values.get("dependsOnMethods")),
    dependsOnGroups: scalarStrings(values.get("dependsOnGroups")),
    ...(priority !== undefined ? { priority } : {}),
  };
}

function annotationValues(tokens: Token[]): Map<string, Token[]> {
  const values = new Map<string, Token[]>();
  for (const part of splitTopLevel(tokens, ",")) {
    const equals = part.findIndex((token) => token.value === "=");
    if (equals === -1) values.set("value", part);
    else {
      const key = part
        .slice(0, equals)
        .map((token) => token.value)
        .join("");
      values.set(key, part.slice(equals + 1));
    }
  }
  return values;
}

function splitTopLevel(tokens: Token[], separator: string): Token[][] {
  const parts: Token[][] = [[]];
  let parentheses = 0;
  let braces = 0;
  let brackets = 0;
  let generics = 0;
  for (const token of tokens) {
    if (token.value === "(") parentheses += 1;
    if (token.value === ")") parentheses -= 1;
    if (token.value === "{") braces += 1;
    if (token.value === "}") braces -= 1;
    if (token.value === "[") brackets += 1;
    if (token.value === "]") brackets -= 1;
    if (token.value === "<") generics += 1;
    if (token.value === ">") generics -= 1;
    if (
      token.value === separator &&
      parentheses === 0 &&
      braces === 0 &&
      brackets === 0 &&
      generics === 0
    ) {
      parts.push([]);
    } else {
      parts.at(-1)?.push(token);
    }
  }
  return parts;
}

function scalarString(tokens: Token[] | undefined): string | undefined {
  return tokens?.find((token) => token.kind === "string")?.value;
}

function scalarStrings(tokens: Token[] | undefined): string[] {
  return sortedUnique(
    tokens?.filter((token) => token.kind === "string").map((token) => token.value) ?? [],
  );
}

function scalarBoolean(tokens: Token[] | undefined): boolean | undefined {
  const value = tokens?.map((token) => token.value).join("");
  return value === "true" ? true : value === "false" ? false : undefined;
}

function scalarInteger(tokens: Token[] | undefined): number | undefined {
  const value = Number(tokens?.map((token) => token.value).join(""));
  return Number.isSafeInteger(value) ? value : undefined;
}

function matchingToken(tokens: Token[], start: number, opening: string, closing: string): number {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index]?.value === opening) depth += 1;
    if (tokens[index]?.value === closing) depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function findToken(tokens: Token[], value: string, start: number): number {
  return tokens.findIndex((token, index) => index >= start && token.value === value);
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function symbol(value: string): Token {
  return { kind: "symbol", value };
}
