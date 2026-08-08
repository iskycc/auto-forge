const CLASS_FILE_MAGIC = 0xcafebabe;
const TEST_ANNOTATION = "Lorg/testng/annotations/Test;";
const IGNORE_ANNOTATION = "Lorg/testng/annotations/Ignore;";

const ACCESS_PUBLIC = 0x0001;
const ACCESS_BRIDGE = 0x0040;
const ACCESS_ABSTRACT = 0x0400;
const ACCESS_SYNTHETIC = 0x1000;
const ACCESS_INTERFACE = 0x0200;
const ACCESS_ANNOTATION = 0x2000;

type ConstantPoolEntry =
  | { kind: "utf8"; value: string }
  | { kind: "integer"; value: number }
  | { kind: "float"; value: number }
  | { kind: "long"; value: bigint }
  | { kind: "double"; value: number }
  | { kind: "class"; nameIndex: number }
  | { kind: "string"; stringIndex: number }
  | { kind: "other" };

type AnnotationValue =
  | string
  | number
  | bigint
  | boolean
  | AnnotationValue[]
  | { enumType: string; enumValue: string }
  | { classDescriptor: string }
  | { annotation: ParsedAnnotation };

type ParsedAnnotation = {
  type: string;
  values: Record<string, AnnotationValue>;
};

type ParsedMethod = {
  accessFlags: number;
  name: string;
  descriptor: string;
  annotations: ParsedAnnotation[];
};

export type ParsedTestNgMethod = {
  methodName: string;
  descriptor: string;
  enabled: boolean;
  annotationSource: "method" | "class";
  groups: string[];
  description?: string;
  dataProvider?: string;
  dependsOnMethods: string[];
  dependsOnGroups: string[];
  priority?: number;
};

export type ParsedTestNgClass = {
  className: string;
  packageName: string;
  simpleName: string;
  superClassName: string | null;
  enabled: boolean;
  classLevelTest: boolean;
  groups: string[];
  methods: ParsedTestNgMethod[];
};

class ClassFileReader {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining(): number {
    return this.bytes.byteLength - this.offset;
  }

  u1(): number {
    this.ensure(1);
    return this.view.getUint8(this.offset++);
  }

  u2(): number {
    this.ensure(2);
    const value = this.view.getUint16(this.offset, false);
    this.offset += 2;
    return value;
  }

  u4(): number {
    this.ensure(4);
    const value = this.view.getUint32(this.offset, false);
    this.offset += 4;
    return value;
  }

  i4(): number {
    this.ensure(4);
    const value = this.view.getInt32(this.offset, false);
    this.offset += 4;
    return value;
  }

  i8(): bigint {
    this.ensure(8);
    const value = this.view.getBigInt64(this.offset, false);
    this.offset += 8;
    return value;
  }

  f4(): number {
    this.ensure(4);
    const value = this.view.getFloat32(this.offset, false);
    this.offset += 4;
    return value;
  }

  f8(): number {
    this.ensure(8);
    const value = this.view.getFloat64(this.offset, false);
    this.offset += 8;
    return value;
  }

  take(length: number): Uint8Array {
    this.ensure(length);
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  skip(length: number): void {
    this.ensure(length);
    this.offset += length;
  }

  private ensure(length: number): void {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      this.offset + length > this.bytes.byteLength
    ) {
      throw new Error(`Class file ended unexpectedly at byte ${this.offset}.`);
    }
  }
}

function utf8(pool: Array<ConstantPoolEntry | undefined>, index: number): string {
  const entry = pool[index];
  if (!entry || entry.kind !== "utf8") {
    throw new Error(`Expected CONSTANT_Utf8 at pool index ${index}.`);
  }
  return entry.value;
}

function className(pool: Array<ConstantPoolEntry | undefined>, index: number): string {
  const entry = pool[index];
  if (!entry || entry.kind !== "class") {
    throw new Error(`Expected CONSTANT_Class at pool index ${index}.`);
  }
  return utf8(pool, entry.nameIndex).replaceAll("/", ".");
}

function constantValue(
  pool: Array<ConstantPoolEntry | undefined>,
  index: number,
): string | number | bigint {
  const entry = pool[index];
  if (!entry) {
    throw new Error(`Missing constant pool entry ${index}.`);
  }
  switch (entry.kind) {
    case "utf8":
    case "integer":
    case "float":
    case "long":
    case "double":
      return entry.value;
    case "string":
      return utf8(pool, entry.stringIndex);
    default:
      throw new Error(`Unsupported annotation constant at pool index ${index}.`);
  }
}

function readConstantPool(reader: ClassFileReader): Array<ConstantPoolEntry | undefined> {
  const count = reader.u2();
  const pool: Array<ConstantPoolEntry | undefined> = new Array(count);
  const decoder = new TextDecoder("utf-8", { fatal: true });

  for (let index = 1; index < count; index += 1) {
    const tag = reader.u1();
    switch (tag) {
      case 1: {
        const length = reader.u2();
        pool[index] = { kind: "utf8", value: decoder.decode(reader.take(length)) };
        break;
      }
      case 3:
        pool[index] = { kind: "integer", value: reader.i4() };
        break;
      case 4:
        pool[index] = { kind: "float", value: reader.f4() };
        break;
      case 5:
        pool[index] = { kind: "long", value: reader.i8() };
        index += 1;
        break;
      case 6:
        pool[index] = { kind: "double", value: reader.f8() };
        index += 1;
        break;
      case 7:
        pool[index] = { kind: "class", nameIndex: reader.u2() };
        break;
      case 8:
        pool[index] = { kind: "string", stringIndex: reader.u2() };
        break;
      case 9:
      case 10:
      case 11:
      case 12:
      case 17:
      case 18:
        reader.skip(4);
        pool[index] = { kind: "other" };
        break;
      case 15:
        reader.skip(3);
        pool[index] = { kind: "other" };
        break;
      case 16:
      case 19:
      case 20:
        reader.skip(2);
        pool[index] = { kind: "other" };
        break;
      default:
        throw new Error(`Unsupported constant pool tag ${tag}.`);
    }
  }

  return pool;
}

function readAnnotation(
  reader: ClassFileReader,
  pool: Array<ConstantPoolEntry | undefined>,
): ParsedAnnotation {
  const type = utf8(pool, reader.u2());
  const pairCount = reader.u2();
  const values: Record<string, AnnotationValue> = {};
  for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
    const name = utf8(pool, reader.u2());
    values[name] = readElementValue(reader, pool);
  }
  return { type, values };
}

function readElementValue(
  reader: ClassFileReader,
  pool: Array<ConstantPoolEntry | undefined>,
): AnnotationValue {
  const tag = String.fromCharCode(reader.u1());
  switch (tag) {
    case "B":
    case "C":
    case "D":
    case "F":
    case "I":
    case "J":
    case "S":
    case "s":
      return constantValue(pool, reader.u2());
    case "Z":
      return Number(constantValue(pool, reader.u2())) !== 0;
    case "e":
      return {
        enumType: utf8(pool, reader.u2()),
        enumValue: utf8(pool, reader.u2()),
      };
    case "c":
      return { classDescriptor: utf8(pool, reader.u2()) };
    case "@":
      return { annotation: readAnnotation(reader, pool) };
    case "[": {
      const count = reader.u2();
      return Array.from({ length: count }, () => readElementValue(reader, pool));
    }
    default:
      throw new Error(`Unsupported annotation value tag ${tag}.`);
  }
}

function readAnnotationsAttribute(
  bytes: Uint8Array,
  pool: Array<ConstantPoolEntry | undefined>,
): ParsedAnnotation[] {
  const reader = new ClassFileReader(bytes);
  const count = reader.u2();
  const annotations = Array.from({ length: count }, () => readAnnotation(reader, pool));
  if (reader.remaining !== 0) {
    throw new Error("Annotation attribute contains trailing bytes.");
  }
  return annotations;
}

function readAttributes(
  reader: ClassFileReader,
  pool: Array<ConstantPoolEntry | undefined>,
): ParsedAnnotation[] {
  const attributeCount = reader.u2();
  const annotations: ParsedAnnotation[] = [];
  for (let index = 0; index < attributeCount; index += 1) {
    const name = utf8(pool, reader.u2());
    const length = reader.u4();
    const content = reader.take(length);
    if (name === "RuntimeVisibleAnnotations" || name === "RuntimeInvisibleAnnotations") {
      annotations.push(...readAnnotationsAttribute(content, pool));
    }
  }
  return annotations;
}

function skipMembers(reader: ClassFileReader, pool: Array<ConstantPoolEntry | undefined>): void {
  const count = reader.u2();
  for (let index = 0; index < count; index += 1) {
    reader.skip(6);
    readAttributes(reader, pool);
  }
}

function readMethods(
  reader: ClassFileReader,
  pool: Array<ConstantPoolEntry | undefined>,
): ParsedMethod[] {
  const count = reader.u2();
  const methods: ParsedMethod[] = [];
  for (let index = 0; index < count; index += 1) {
    const accessFlags = reader.u2();
    const name = utf8(pool, reader.u2());
    const descriptor = utf8(pool, reader.u2());
    const annotations = readAttributes(reader, pool);
    methods.push({ accessFlags, name, descriptor, annotations });
  }
  return methods;
}

function findAnnotation(
  annotations: ParsedAnnotation[],
  annotationType: string,
): ParsedAnnotation | undefined {
  return annotations.find((annotation) => annotation.type === annotationType);
}

function stringValue(annotation: ParsedAnnotation | undefined, name: string): string | undefined {
  const value = annotation?.values[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function integerValue(annotation: ParsedAnnotation | undefined, name: string): number | undefined {
  const value = annotation?.values[name];
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function booleanValue(
  annotation: ParsedAnnotation | undefined,
  name: string,
  defaultValue: boolean,
): boolean {
  const value = annotation?.values[name];
  return typeof value === "boolean" ? value : defaultValue;
}

function stringArray(annotation: ParsedAnnotation | undefined, name: string): string[] {
  const value = annotation?.values[name];
  if (typeof value === "string") {
    return value.length > 0 ? [value] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function parseTestNgClassFile(bytes: Uint8Array): ParsedTestNgClass | null {
  const reader = new ClassFileReader(bytes);
  if (reader.u4() !== CLASS_FILE_MAGIC) {
    throw new Error("Entry is not a Java class file.");
  }

  reader.skip(4); // minor_version and major_version
  const pool = readConstantPool(reader);
  const accessFlags = reader.u2();
  const thisClass = className(pool, reader.u2());
  const superClassIndex = reader.u2();
  const superClassName = superClassIndex === 0 ? null : className(pool, superClassIndex);

  const interfaceCount = reader.u2();
  reader.skip(interfaceCount * 2);
  skipMembers(reader, pool);
  const methods = readMethods(reader, pool);
  const classAnnotations = readAttributes(reader, pool);

  if (reader.remaining !== 0) {
    throw new Error("Class file contains trailing bytes.");
  }
  if ((accessFlags & (ACCESS_INTERFACE | ACCESS_ANNOTATION)) !== 0) {
    return null;
  }
  if (
    thisClass === "module-info" ||
    thisClass.endsWith(".module-info") ||
    thisClass === "package-info" ||
    thisClass.endsWith(".package-info")
  ) {
    return null;
  }

  const classTest = findAnnotation(classAnnotations, TEST_ANNOTATION);
  const classIgnored = Boolean(findAnnotation(classAnnotations, IGNORE_ANNOTATION));
  const classEnabled = !classIgnored && booleanValue(classTest, "enabled", true);
  const classGroups = uniqueSorted(stringArray(classTest, "groups"));

  const testMethods: ParsedTestNgMethod[] = [];
  for (const method of methods) {
    if (method.name === "<init>" || method.name === "<clinit>") {
      continue;
    }
    if ((method.accessFlags & (ACCESS_ABSTRACT | ACCESS_SYNTHETIC | ACCESS_BRIDGE)) !== 0) {
      continue;
    }

    const methodTest = findAnnotation(method.annotations, TEST_ANNOTATION);
    const includedByClass = Boolean(classTest) && (method.accessFlags & ACCESS_PUBLIC) !== 0;
    if (!methodTest && !includedByClass) {
      continue;
    }

    const ignored = Boolean(findAnnotation(method.annotations, IGNORE_ANNOTATION));
    const inheritGroups = booleanValue(methodTest, "inheritGroups", true);
    const ownGroups = stringArray(methodTest, "groups");
    const groups = uniqueSorted([...(inheritGroups ? classGroups : []), ...ownGroups]);
    const enabled = classEnabled && !ignored && booleanValue(methodTest, "enabled", true);
    const candidate: ParsedTestNgMethod = {
      methodName: method.name,
      descriptor: method.descriptor,
      enabled,
      annotationSource: methodTest ? "method" : "class",
      groups,
      dependsOnMethods: uniqueSorted(stringArray(methodTest, "dependsOnMethods")),
      dependsOnGroups: uniqueSorted(stringArray(methodTest, "dependsOnGroups")),
    };

    const description =
      stringValue(methodTest, "description") ?? stringValue(classTest, "description");
    if (description) {
      candidate.description = description;
    }
    const dataProvider = stringValue(methodTest, "dataProvider");
    if (dataProvider) {
      candidate.dataProvider = dataProvider;
    }
    const priority = integerValue(methodTest, "priority");
    if (priority !== undefined) {
      candidate.priority = priority;
    }
    testMethods.push(candidate);
  }

  if (!classTest && testMethods.length === 0) {
    return null;
  }

  testMethods.sort((left, right) => left.methodName.localeCompare(right.methodName));
  const lastDot = thisClass.lastIndexOf(".");
  return {
    className: thisClass,
    packageName: lastDot === -1 ? "" : thisClass.slice(0, lastDot),
    simpleName: lastDot === -1 ? thisClass : thisClass.slice(lastDot + 1),
    superClassName,
    enabled: classEnabled,
    classLevelTest: Boolean(classTest),
    groups: classGroups,
    methods: testMethods,
  };
}
