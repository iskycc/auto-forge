import type { JarInspectionWarning, TestNgXmlSelection } from "@autoforge/contracts";

const MAX_XML_BYTES = 1024 * 1024;
const MAX_XML_NODES = 10_000;
const MAX_XML_DEPTH = 64;
const MAX_ATTRIBUTES_PER_ELEMENT = 64;
const MAX_ATTRIBUTE_VALUE_LENGTH = 4_096;
const MAX_SELECTIONS = 200;

type XmlElement = {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
};

export type ParsedTestNgXml = {
  selections: TestNgXmlSelection[];
  warnings: JarInspectionWarning[];
};

function decodeEntities(value: string): string {
  return value.replace(
    /&(#x[0-9a-f]+|#[0-9]+|quot|apos|lt|gt|amp);/giu,
    (_entity, name: string) => {
      const named: Record<string, string> = {
        quot: '"',
        apos: "'",
        lt: "<",
        gt: ">",
        amp: "&",
      };
      if (named[name]) return named[name];
      const codePoint = name.startsWith("#x")
        ? Number.parseInt(name.slice(2), 16)
        : Number.parseInt(name.slice(1), 10);
      if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
        throw new Error("testng.xml 包含无效字符实体。");
      }
      return String.fromCodePoint(codePoint);
    },
  );
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const matcher = /\s*([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
  let offset = 0;
  while (offset < source.length) {
    matcher.lastIndex = offset;
    const match = matcher.exec(source);
    if (!match) {
      if (source.slice(offset).trim().length === 0) break;
      throw new Error("testng.xml 包含无效属性语法。");
    }
    const name = match[1];
    if (!name) throw new Error("testng.xml 包含无效属性名。");
    if (Object.hasOwn(attributes, name)) throw new Error(`testng.xml 属性 ${name} 重复。`);
    const value = decodeEntities(match[2] ?? match[3] ?? "");
    if (value.length > MAX_ATTRIBUTE_VALUE_LENGTH) {
      throw new Error(`testng.xml 属性 ${name} 超过长度限制。`);
    }
    attributes[name] = value;
    if (Object.keys(attributes).length > MAX_ATTRIBUTES_PER_ELEMENT) {
      throw new Error("testng.xml 单个标签的属性数量超过限制。");
    }
    offset = matcher.lastIndex;
  }
  return attributes;
}

function readMarkup(xml: string, start: number): { content: string; nextOffset: number } {
  if (xml.startsWith("<!--", start)) {
    const end = xml.indexOf("-->", start + 4);
    if (end < 0) throw new Error("testng.xml 注释未闭合。");
    return { content: "!comment", nextOffset: end + 3 };
  }
  if (xml.startsWith("<?", start)) {
    const end = xml.indexOf("?>", start + 2);
    if (end < 0) throw new Error("testng.xml 处理指令未闭合。");
    return { content: "?instruction", nextOffset: end + 2 };
  }
  let quote: '"' | "'" | undefined;
  for (let offset = start + 1; offset < xml.length; offset += 1) {
    const character = xml[offset];
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") {
      return { content: xml.slice(start + 1, offset), nextOffset: offset + 1 };
    }
  }
  throw new Error("testng.xml 标签未闭合。");
}

function parseDocument(xml: string): XmlElement {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new Error("testng.xml 不允许 DTD 或实体声明。");
  }
  const root: XmlElement = { name: "#document", attributes: {}, children: [] };
  const stack = [root];
  let nodeCount = 0;
  let offset = 0;
  while (offset < xml.length) {
    const tagStart = xml.indexOf("<", offset);
    if (tagStart < 0) {
      if (xml.slice(offset).trim()) throw new Error("testng.xml 标签外包含意外文本。");
      break;
    }
    if (xml.slice(offset, tagStart).trim()) {
      throw new Error("testng.xml 标签外包含意外文本。");
    }
    const markup = readMarkup(xml, tagStart);
    offset = markup.nextOffset;
    const token = markup.content.trim();
    if (!token || token.startsWith("?") || token.startsWith("!")) continue;
    if (token.startsWith("/")) {
      const closingName = token.slice(1).trim();
      const current = stack.pop();
      if (!current || current === root || current.name !== closingName) {
        throw new Error(`testng.xml 标签闭合不匹配：${closingName}。`);
      }
      continue;
    }
    const selfClosing = token.endsWith("/");
    const body = selfClosing ? token.slice(0, -1).trim() : token;
    const name = body.match(/^[A-Za-z_][\w:.-]*/)?.[0];
    if (!name) throw new Error("testng.xml 包含无效标签。");
    nodeCount += 1;
    if (nodeCount > MAX_XML_NODES) throw new Error("testng.xml 节点数超过限制。");
    const element: XmlElement = {
      name,
      attributes: parseAttributes(body.slice(name.length)),
      children: [],
    };
    stack.at(-1)?.children.push(element);
    if (!selfClosing) {
      stack.push(element);
      if (stack.length > MAX_XML_DEPTH) throw new Error("testng.xml 嵌套深度超过限制。");
    }
  }
  if (stack.length !== 1) throw new Error("testng.xml 存在未闭合标签。");
  return root;
}

function children(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((child) => child.name === name);
}

function directParameters(element: XmlElement): Record<string, string> {
  const result: Record<string, string> = {};
  for (const parameter of children(element, "parameter")) {
    const name = parameter.attributes.name;
    const value = parameter.attributes.value;
    if (!name || value === undefined) continue;
    result[name] = value;
  }
  return result;
}

function names(elements: XmlElement[]): string[] {
  return [
    ...new Set(
      elements
        .map((element) => element.attributes.name)
        .filter((name): name is string => Boolean(name)),
    ),
  ].sort();
}

function groupNames(element: XmlElement, action: "include" | "exclude"): string[] {
  const groups = children(element, "groups")[0];
  const run = groups ? children(groups, "run")[0] : undefined;
  return run ? names(children(run, action)) : [];
}

function packageNames(element: XmlElement): string[] {
  const packages = children(element, "packages")[0];
  return packages ? names(children(packages, "package")) : [];
}

function selection(suite: XmlElement, test: XmlElement): TestNgXmlSelection {
  const classes = children(test, "classes")[0];
  return {
    suiteName: suite.attributes.name ?? "default-suite",
    testName: test.attributes.name ?? "default-test",
    parameters: { ...directParameters(suite), ...directParameters(test) },
    includedGroups: [...new Set([...groupNames(suite, "include"), ...groupNames(test, "include")])],
    excludedGroups: [...new Set([...groupNames(suite, "exclude"), ...groupNames(test, "exclude")])],
    includedPackages: [...new Set([...packageNames(suite), ...packageNames(test)])],
    selectedClasses: classes
      ? children(classes, "class")
          .map((classElement) => {
            const methods = children(classElement, "methods")[0];
            return {
              className: classElement.attributes.name ?? "",
              includedMethods: methods ? names(children(methods, "include")) : [],
              excludedMethods: methods ? names(children(methods, "exclude")) : [],
            };
          })
          .filter((item) => item.className.length > 0)
      : [],
  };
}

function unsupportedWarnings(suite: XmlElement): JarInspectionWarning[] {
  const warnings: JarInspectionWarning[] = [];
  if (children(suite, "suite-files").length > 0) {
    warnings.push({
      code: "TESTNG_XML_SUITE_FILES_UNSUPPORTED",
      message: "testng.xml 的 suite-files 引用不会展开，静态发现只解析当前文件。",
      entry: "testng.xml",
    });
  }
  if (children(suite, "listeners").length > 0) {
    warnings.push({
      code: "TESTNG_LISTENERS_RUNTIME_ONLY",
      message: "testng.xml listeners 仅在执行期生效，不会扩展静态发现结果。",
      entry: "testng.xml",
    });
  }
  const selectors = suite.children.flatMap((element) =>
    element.children.flatMap((child) => child.children),
  );
  if (selectors.some((element) => element.name === "script" || element.name === "selector-class")) {
    warnings.push({
      code: "TESTNG_METHOD_SELECTOR_RUNTIME_ONLY",
      message: "脚本或自定义方法选择器无法安全静态执行，发现结果未应用其动态筛选。",
      entry: "testng.xml",
    });
  }
  return warnings;
}

export function parseTestNgXml(content: Uint8Array): ParsedTestNgXml {
  if (content.byteLength > MAX_XML_BYTES) throw new Error("testng.xml 超过 1 MiB 限制。");
  const document = parseDocument(new TextDecoder("utf-8", { fatal: true }).decode(content));
  const suites = children(document, "suite");
  if (suites.length !== 1) throw new Error("testng.xml 必须包含唯一根 suite 标签。");
  const suite = suites[0];
  if (!suite) throw new Error("testng.xml 缺少 suite 标签。");
  const tests = children(suite, "test");
  const selections = (tests.length > 0 ? tests : [suite]).map((test) => selection(suite, test));
  if (selections.length > MAX_SELECTIONS) throw new Error("testng.xml 的 test 数量超过限制。");
  return { selections, warnings: unsupportedWarnings(suite) };
}

export function selectionIncludesClass(selection: TestNgXmlSelection, className: string): boolean {
  if (selection.selectedClasses.length > 0) {
    return selection.selectedClasses.some((selected) => selected.className === className);
  }
  if (selection.includedPackages.length === 0) return true;
  return selection.includedPackages.some((pattern) => {
    const normalized = pattern.endsWith(".*") ? pattern.slice(0, -2) : pattern;
    return className === normalized || className.startsWith(`${normalized}.`);
  });
}
