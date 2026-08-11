type AnnotationValueSpec = string | boolean | number | string[];

export type AnnotationSpec = {
  type: "Test" | "Ignore" | "Factory" | "DataProvider" | "Listeners";
  values?: Record<string, AnnotationValueSpec>;
};

export type MethodSpec = {
  name: string;
  descriptor?: string;
  accessFlags?: number;
  annotations?: AnnotationSpec[];
};

export type ClassSpec = {
  className: string;
  superClassName?: string;
  annotations?: AnnotationSpec[];
  methods: MethodSpec[];
};

function u1(value: number): number[] {
  return [value & 0xff];
}

function u2(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function u4(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

class ConstantPoolBuilder {
  private readonly entries: number[][] = [];
  private readonly utf8Indexes = new Map<string, number>();
  private readonly integerIndexes = new Map<number, number>();
  private readonly classIndexes = new Map<string, number>();

  utf8(value: string): number {
    const existing = this.utf8Indexes.get(value);
    if (existing) return existing;
    const encoded = new TextEncoder().encode(value);
    const index = this.entries.length + 1;
    this.entries.push([...u1(1), ...u2(encoded.length), ...encoded]);
    this.utf8Indexes.set(value, index);
    return index;
  }

  integer(value: number): number {
    const existing = this.integerIndexes.get(value);
    if (existing) return existing;
    const index = this.entries.length + 1;
    this.entries.push([...u1(3), ...u4(value)]);
    this.integerIndexes.set(value, index);
    return index;
  }

  classInfo(value: string): number {
    const existing = this.classIndexes.get(value);
    if (existing) return existing;
    const nameIndex = this.utf8(value);
    const index = this.entries.length + 1;
    this.entries.push([...u1(7), ...u2(nameIndex)]);
    this.classIndexes.set(value, index);
    return index;
  }

  bytes(): number[] {
    return [...u2(this.entries.length + 1), ...this.entries.flat()];
  }
}

function annotationDescriptor(type: AnnotationSpec["type"]): string {
  return `Lorg/testng/annotations/${type};`;
}

function registerAnnotation(pool: ConstantPoolBuilder, annotation: AnnotationSpec): void {
  pool.utf8(annotationDescriptor(annotation.type));
  for (const [name, value] of Object.entries(annotation.values ?? {})) {
    pool.utf8(name);
    if (typeof value === "string") pool.utf8(value);
    if (typeof value === "boolean") pool.integer(value ? 1 : 0);
    if (typeof value === "number") pool.integer(value);
    if (Array.isArray(value)) value.forEach((item) => pool.utf8(item));
  }
}

function elementValue(pool: ConstantPoolBuilder, value: AnnotationValueSpec): number[] {
  if (typeof value === "string") {
    return [...u1("s".charCodeAt(0)), ...u2(pool.utf8(value))];
  }
  if (typeof value === "boolean") {
    return [...u1("Z".charCodeAt(0)), ...u2(pool.integer(value ? 1 : 0))];
  }
  if (typeof value === "number") {
    return [...u1("I".charCodeAt(0)), ...u2(pool.integer(value))];
  }
  return [
    ...u1("[".charCodeAt(0)),
    ...u2(value.length),
    ...value.flatMap((item) => elementValue(pool, item)),
  ];
}

function annotationBytes(pool: ConstantPoolBuilder, annotation: AnnotationSpec): number[] {
  const pairs = Object.entries(annotation.values ?? {});
  return [
    ...u2(pool.utf8(annotationDescriptor(annotation.type))),
    ...u2(pairs.length),
    ...pairs.flatMap(([name, value]) => [...u2(pool.utf8(name)), ...elementValue(pool, value)]),
  ];
}

function annotationsAttribute(pool: ConstantPoolBuilder, annotations: AnnotationSpec[]): number[] {
  if (annotations.length === 0) return [...u2(0)];
  const body = [
    ...u2(annotations.length),
    ...annotations.flatMap((item) => annotationBytes(pool, item)),
  ];
  return [...u2(1), ...u2(pool.utf8("RuntimeVisibleAnnotations")), ...u4(body.length), ...body];
}

export function buildClassFile(spec: ClassSpec): Uint8Array {
  const pool = new ConstantPoolBuilder();
  const internalClassName = spec.className.replaceAll(".", "/");
  const thisClass = pool.classInfo(internalClassName);
  const superClass = pool.classInfo(
    (spec.superClassName ?? "java.lang.Object").replaceAll(".", "/"),
  );
  pool.utf8("RuntimeVisibleAnnotations");
  for (const annotation of spec.annotations ?? []) registerAnnotation(pool, annotation);
  for (const method of spec.methods) {
    pool.utf8(method.name);
    pool.utf8(method.descriptor ?? "()V");
    for (const annotation of method.annotations ?? []) registerAnnotation(pool, annotation);
  }

  const methodBytes = spec.methods.flatMap((method) => [
    ...u2(method.accessFlags ?? 0x0001),
    ...u2(pool.utf8(method.name)),
    ...u2(pool.utf8(method.descriptor ?? "()V")),
    ...annotationsAttribute(pool, method.annotations ?? []),
  ]);
  const classAttributes = annotationsAttribute(pool, spec.annotations ?? []);

  return new Uint8Array([
    ...u4(0xcafebabe),
    ...u2(0),
    ...u2(61),
    ...pool.bytes(),
    ...u2(0x0021),
    ...u2(thisClass),
    ...u2(superClass),
    ...u2(0),
    ...u2(0),
    ...u2(spec.methods.length),
    ...methodBytes,
    ...classAttributes,
  ]);
}
