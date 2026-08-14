import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { isJarInspectionError, JarInspectionError, TestNgJarDiscovery } from "../src/jar-discovery";
import { buildClassFile } from "./class-fixture";

describe("TestNgJarDiscovery", () => {
  it("discovers TestNG cases from a bounded sources JAR and exposes their source", async () => {
    const source = `package com.example;

import org.testng.annotations.Test;

public class CheckoutTest {
  @Test(groups = {"smoke", "checkout"}, description = "creates an order", priority = 2)
  public void checkout(String accountId) {
    // Source is displayed, never compiled or executed by discovery.
  }
}
`;
    const jar = zipSync({
      "com/example/CheckoutTest.java": new TextEncoder().encode(source),
    });
    const discovery = new TestNgJarDiscovery();

    const inspection = await discovery.inspect("checkout-tests-sources.jar", jar);

    expect(inspection).toMatchObject({
      discoveryMode: "java-source-annotations",
      classFileCount: 0,
      javaSourceFileCount: 1,
      testClassCount: 1,
      testMethodCount: 1,
      classes: [
        {
          className: "com.example.CheckoutTest",
          source: {
            entryPath: "com/example/CheckoutTest.java",
            sizeBytes: new TextEncoder().encode(source).byteLength,
          },
          methods: [
            {
              methodName: "checkout",
              descriptor: "(Ljava/lang/String;)V",
              groups: ["checkout", "smoke"],
              description: "creates an order",
              priority: 2,
            },
          ],
        },
      ],
    });
    await expect(discovery.readSource(jar, inspection.classes[0]?.source)).resolves.toBe(source);
    await expect(
      discovery.readSource(jar, {
        ...inspection.classes[0]!.source!,
        sha256: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "SOURCE_INTEGRITY_FAILED" });
  });

  it("rejects unsafe source paths and does not expose their content", async () => {
    const jar = zipSync({
      "../EscapedTest.java": new TextEncoder().encode(
        "import org.testng.annotations.Test; class EscapedTest { @Test void escaped() {} }",
      ),
    });

    const inspection = await new TestNgJarDiscovery().inspect("unsafe-sources.jar", jar);

    expect(inspection.testClassCount).toBe(0);
    expect(inspection.warnings).toContainEqual(
      expect.objectContaining({ code: "SOURCE_ENTRY_PATH_UNSAFE" }),
    );
  });

  it("keeps a bytecode JAR executable while attaching embedded Java source", async () => {
    const source = `package com.example;
import org.testng.annotations.Test;
public class CheckoutTest { @Test public void checkout() {} }
`;
    const jar = zipSync({
      "com/example/CheckoutTest.class": buildClassFile({
        className: "com.example.CheckoutTest",
        methods: [{ name: "checkout", annotations: [{ type: "Test" }] }],
      }),
      "com/example/CheckoutTest.java": new TextEncoder().encode(source),
    });

    const inspection = await new TestNgJarDiscovery().inspect("tests-with-source.jar", jar);

    expect(inspection).toMatchObject({
      discoveryMode: "bytecode-annotations",
      executable: true,
      javaSourceFileCount: 1,
      classes: [
        {
          className: "com.example.CheckoutTest",
          source: { entryPath: "com/example/CheckoutTest.java" },
        },
      ],
    });
  });

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

  it("recognizes inspection errors across production bundle boundaries", () => {
    const bundledError = Object.assign(new Error("文件不是有效的 ZIP/JAR 格式。"), {
      name: "JarInspectionError",
      code: "INVALID_JAR",
    });

    expect(isJarInspectionError(bundledError)).toBe(true);
    expect(
      isJarInspectionError(
        Object.assign(new Error("unexpected"), {
          name: "JarInspectionError",
          code: "UNRECOGNIZED_ERROR",
        }),
      ),
    ).toBe(false);
  });

  it("enforces the compressed upload size limit", async () => {
    const discovery = new TestNgJarDiscovery({ maxJarBytes: 2 });
    await expect(
      discovery.inspect("large.jar", new Uint8Array([0x50, 0x4b, 3])),
    ).rejects.toMatchObject({ code: "JAR_TOO_LARGE" } satisfies Partial<JarInspectionError>);
  });

  it("does not impose a separate discovered test class limit", async () => {
    const classCount = 5_001;
    const entries = Object.fromEntries(
      Array.from({ length: classCount }, (_, index) => {
        const className = `com.example.GeneratedTest${index}`;
        return [
          `${className.replaceAll(".", "/")}.class`,
          buildClassFile({
            className,
            methods: [{ name: "test", annotations: [{ type: "Test" }] }],
          }),
        ];
      }),
    );

    const inspection = await new TestNgJarDiscovery().inspect("many-tests.jar", zipSync(entries));

    expect(inspection.testClassCount).toBe(classCount);
  });

  it("applies bounded testng.xml class, method, group, package and parameter selection", async () => {
    const jar = zipSync({
      "com/example/CheckoutTest.class": buildClassFile({
        className: "com.example.CheckoutTest",
        methods: [
          { name: "smoke", annotations: [{ type: "Test", values: { groups: ["smoke"] } }] },
          { name: "slow", annotations: [{ type: "Test", values: { groups: ["slow"] } }] },
        ],
      }),
      "org/other/OtherTest.class": buildClassFile({
        className: "org.other.OtherTest",
        methods: [{ name: "other", annotations: [{ type: "Test" }] }],
      }),
      "testng.xml": new TextEncoder().encode(`
        <suite name="offline-suite">
          <parameter name="region" value="cn-north" />
          <test name="selected">
            <groups><run><include name="smoke"/><exclude name="slow"/></run></groups>
            <packages><package name="com.example.*"/></packages>
            <classes><class name="com.example.CheckoutTest"><methods><exclude name="slow"/></methods></class></classes>
          </test>
        </suite>`),
    });

    const inspection = await new TestNgJarDiscovery().inspect("selected.jar", jar);

    expect(inspection.classes.map((candidate) => candidate.className)).toEqual([
      "com.example.CheckoutTest",
    ]);
    expect(inspection.classes[0]?.methods).toMatchObject([
      { methodName: "slow", enabled: false },
      { methodName: "smoke", enabled: true },
    ]);
    expect(inspection.testNgXmlSelections?.[0]).toMatchObject({
      suiteName: "offline-suite",
      testName: "selected",
      parameters: { region: "cn-north" },
      includedGroups: ["smoke"],
      excludedGroups: ["slow"],
      includedPackages: ["com.example.*"],
    });
  });

  it("resolves inherited class annotations and inherited methods inside the JAR", async () => {
    const jar = zipSync({
      "com/example/BaseTest.class": buildClassFile({
        className: "com.example.BaseTest",
        annotations: [{ type: "Test", values: { groups: ["base"] } }],
        methods: [{ name: "inheritedCase" }],
      }),
      "com/example/CheckoutTest.class": buildClassFile({
        className: "com.example.CheckoutTest",
        superClassName: "com.example.BaseTest",
        methods: [{ name: "checkout" }],
      }),
    });

    const inspection = await new TestNgJarDiscovery().inspect("inheritance.jar", jar);
    const child = inspection.classes.find(
      (candidate) => candidate.className === "com.example.CheckoutTest",
    );

    expect(child?.groups).toEqual(["base"]);
    expect(child?.methods.map((method) => method.methodName)).toEqual([
      "checkout",
      "inheritedCase",
    ]);
  });

  it("selects the highest compatible Multi-Release class", async () => {
    const jar = zipSync({
      "META-INF/MANIFEST.MF": new TextEncoder().encode(
        "Manifest-Version: 1.0\r\nMulti-Release: true\r\n\r\n",
      ),
      "com/example/VersionedTest.class": buildClassFile({
        className: "com.example.VersionedTest",
        methods: [{ name: "base", annotations: [{ type: "Test" }] }],
      }),
      "META-INF/versions/17/com/example/VersionedTest.class": buildClassFile({
        className: "com.example.VersionedTest",
        methods: [{ name: "java17", annotations: [{ type: "Test" }] }],
      }),
      "META-INF/versions/22/com/example/VersionedTest.class": buildClassFile({
        className: "com.example.VersionedTest",
        methods: [{ name: "java22", annotations: [{ type: "Test" }] }],
      }),
    });

    const inspection = await new TestNgJarDiscovery({ targetJavaVersion: 21 }).inspect(
      "multi-release.jar",
      jar,
    );

    expect(inspection.classes[0]?.methods[0]?.methodName).toBe("java17");
    expect(inspection.warnings).toContainEqual(
      expect.objectContaining({ code: "MULTI_RELEASE_SELECTED" }),
    );
  });

  it("warns when runtime TestNG factories and providers exceed static discovery", async () => {
    const jar = zipSync({
      "com/example/DynamicTest.class": buildClassFile({
        className: "com.example.DynamicTest",
        annotations: [{ type: "Listeners" }],
        methods: [
          { name: "factory", annotations: [{ type: "Factory" }] },
          { name: "rows", annotations: [{ type: "DataProvider" }] },
          { name: "test", annotations: [{ type: "Test", values: { dataProvider: "rows" } }] },
        ],
      }),
    });

    const inspection = await new TestNgJarDiscovery().inspect("dynamic.jar", jar);

    expect(inspection.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining([
        "TESTNG_FACTORY_RUNTIME_ONLY",
        "TESTNG_DATA_PROVIDER_RUNTIME_ONLY",
        "TESTNG_LISTENERS_RUNTIME_ONLY",
      ]),
    );
  });

  it("warns that suite-files references are not expanded", async () => {
    const jar = zipSync({
      "com/example/CheckoutTest.class": buildClassFile({
        className: "com.example.CheckoutTest",
        methods: [{ name: "checkout", annotations: [{ type: "Test" }] }],
      }),
      "testng.xml": new TextEncoder().encode(
        `<suite name="fixture">
          <suite-files><suite-file path="nested-suite.xml" /></suite-files>
          <test name="unit"><classes><class name="com.example.CheckoutTest" /></classes></test>
        </suite>`,
      ),
    });

    const inspection = await new TestNgJarDiscovery().inspect("suite-files.jar", jar);

    expect(inspection.warnings).toContainEqual(
      expect.objectContaining({ code: "TESTNG_XML_SUITE_FILES_UNSUPPORTED", entry: "testng.xml" }),
    );
    expect(inspection.classes.map((candidate) => candidate.className)).toEqual([
      "com.example.CheckoutTest",
    ]);
  });

  it("warns that nested testng.xml files do not participate in discovery", async () => {
    const jar = zipSync({
      "com/example/CheckoutTest.class": buildClassFile({
        className: "com.example.CheckoutTest",
        methods: [{ name: "checkout", annotations: [{ type: "Test" }] }],
      }),
      "testng.xml": new TextEncoder().encode('<suite name="fixture" />'),
      "resources/testng.xml": new TextEncoder().encode('<suite name="ignored" />'),
      "META-INF/testng.xml": new TextEncoder().encode('<suite name="also-ignored" />'),
    });

    const inspection = await new TestNgJarDiscovery().inspect("nested-xml.jar", jar);

    expect(inspection.warnings).toContainEqual(
      expect.objectContaining({
        code: "TESTNG_XML_NESTED_IGNORED",
        entry: "resources/testng.xml",
      }),
    );
    expect(inspection.hasRootTestNgXml).toBe(true);
  });

  it("rejects an unsupported target Java version", () => {
    expect(() => new TestNgJarDiscovery({ targetJavaVersion: 7 })).toThrow(/targetJavaVersion/);
  });
});
