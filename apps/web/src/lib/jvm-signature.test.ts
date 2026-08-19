import { describe, expect, it } from "vitest";

import { formatMethodSignature, parseMethodDescriptor } from "./jvm-signature";

describe("formatMethodSignature", () => {
  it("renders no-arg void methods as 入参：空，返回值：空", () => {
    expect(formatMethodSignature("()V")).toBe("入参：空，返回值：空");
  });

  it("renders primitive parameters and return types", () => {
    expect(formatMethodSignature("(I)Z")).toBe("入参：int，返回值：boolean");
    expect(formatMethodSignature("(JD)F")).toBe("入参：long、double，返回值：float");
  });

  it("renders object types by simple class name", () => {
    expect(formatMethodSignature("(Ljava/lang/String;)V")).toBe("入参：String，返回值：空");
    expect(formatMethodSignature("()Ljava/util/List;")).toBe("入参：空，返回值：List");
  });

  it("renders array types with [] suffixes", () => {
    expect(formatMethodSignature("([Ljava/lang/String;[[D)V")).toBe(
      "入参：String[]、double[][]，返回值：空",
    );
  });

  it("keeps overloaded methods distinguishable", () => {
    expect(formatMethodSignature("(I)V")).not.toBe(formatMethodSignature("(J)V"));
  });

  it("uses a readable Chinese fallback without exposing malformed JVM symbols", () => {
    for (const malformed of ["(I", "", "(L;)V", "([V)V", "(I)Vextra"]) {
      expect(formatMethodSignature(malformed)).toBe("入参：无法识别，返回值：无法识别");
    }
  });
});

describe("parseMethodDescriptor", () => {
  it("rejects void parameters", () => {
    expect(parseMethodDescriptor("(V)V")).toBeNull();
  });

  it("parses nested object paths to simple names", () => {
    expect(parseMethodDescriptor("()Lcom/example/CheckoutTest;")).toEqual({
      parameterTypes: [],
      returnType: "CheckoutTest",
    });
  });
});
