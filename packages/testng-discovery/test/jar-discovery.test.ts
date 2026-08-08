import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { JarInspectionError, TestNgJarDiscovery } from "../src/jar-discovery";
import { buildClassFile } from "./class-fixture";

describe("TestNgJarDiscovery", () => {
  it("discovers TestNG classes without loading user bytecode", async () => {
    const jar = zipSync({
      "com/example/CheckoutTest.class": buildClassFile({
        className: "com.example.CheckoutTest",
        methods: [{ name: "checkout", annotations: [{ type: "Test" }] }],
      }),
      "com/example/Helper.class": buildClassFile({
        className: "com.example.Helper",
        methods: [{ name: "help" }],
      }),
      "testng.xml": new TextEncoder().encode('<suite name="fixture" />'),
    });

    const inspection = await new TestNgJarDiscovery().inspect("fixture.jar", jar);

    expect(inspection).toMatchObject({
      schemaVersion: 1,
      fileName: "fixture.jar",
      classFileCount: 2,
      testClassCount: 1,
      testMethodCount: 1,
      hasRootTestNgXml: true,
      discoveryMode: "bytecode-annotations",
    });
    expect(inspection.classes[0]?.className).toBe("com.example.CheckoutTest");
    expect(inspection.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects non-JAR input", async () => {
    const discovery = new TestNgJarDiscovery();
    await expect(
      discovery.inspect("not-a-jar.jar", new Uint8Array([1, 2, 3])),
    ).rejects.toMatchObject({ code: "INVALID_JAR" } satisfies Partial<JarInspectionError>);
  });

  it("enforces the compressed upload size limit", async () => {
    const discovery = new TestNgJarDiscovery({ maxJarBytes: 2 });
    await expect(
      discovery.inspect("large.jar", new Uint8Array([0x50, 0x4b, 3])),
    ).rejects.toMatchObject({ code: "JAR_TOO_LARGE" } satisfies Partial<JarInspectionError>);
  });

  it("rejects archives that exceed the discovered test class limit", async () => {
    const jar = zipSync({
      "com/example/FirstTest.class": buildClassFile({
        className: "com.example.FirstTest",
        methods: [{ name: "first", annotations: [{ type: "Test" }] }],
      }),
      "com/example/SecondTest.class": buildClassFile({
        className: "com.example.SecondTest",
        methods: [{ name: "second", annotations: [{ type: "Test" }] }],
      }),
    });
    const discovery = new TestNgJarDiscovery({ maxTestClasses: 1 });

    await expect(discovery.inspect("too-many.jar", jar)).rejects.toMatchObject({
      code: "TOO_MANY_TEST_CLASSES",
    } satisfies Partial<JarInspectionError>);
  });
});
