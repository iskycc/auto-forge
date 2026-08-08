import { describe, expect, it } from "vitest";

import { parseTestNgClassFile } from "../src/class-file";
import { buildClassFile } from "./class-fixture";

describe("parseTestNgClassFile", () => {
  it("discovers method annotations and their execution metadata", () => {
    const parsed = parseTestNgClassFile(
      buildClassFile({
        className: "com.example.CheckoutTest",
        methods: [
          {
            name: "createsOrder",
            descriptor: "(Ljava/lang/String;)V",
            annotations: [
              {
                type: "Test",
                values: {
                  groups: ["smoke", "checkout"],
                  description: "creates a paid order",
                  dataProvider: "orders",
                  dependsOnMethods: ["login"],
                  priority: 3,
                },
              },
            ],
          },
        ],
      }),
    );

    expect(parsed).toMatchObject({
      className: "com.example.CheckoutTest",
      packageName: "com.example",
      simpleName: "CheckoutTest",
      classLevelTest: false,
      methods: [
        {
          methodName: "createsOrder",
          descriptor: "(Ljava/lang/String;)V",
          groups: ["checkout", "smoke"],
          description: "creates a paid order",
          dataProvider: "orders",
          dependsOnMethods: ["login"],
          priority: 3,
          enabled: true,
          annotationSource: "method",
        },
      ],
    });
  });

  it("applies class-level TestNG semantics to public methods", () => {
    const parsed = parseTestNgClassFile(
      buildClassFile({
        className: "com.example.ClassLevelTest",
        annotations: [{ type: "Test", values: { groups: ["regression"] } }],
        methods: [
          { name: "publicCase" },
          { name: "privateHelper", accessFlags: 0x0002 },
          {
            name: "disabledCase",
            annotations: [{ type: "Test", values: { enabled: false, groups: ["blocked"] } }],
          },
        ],
      }),
    );

    expect(parsed?.methods.map((method) => method.methodName)).toEqual([
      "disabledCase",
      "publicCase",
    ]);
    expect(parsed?.methods[0]).toMatchObject({
      enabled: false,
      groups: ["blocked", "regression"],
      annotationSource: "method",
    });
    expect(parsed?.methods[1]).toMatchObject({
      enabled: true,
      groups: ["regression"],
      annotationSource: "class",
    });
  });

  it("returns null for classes without TestNG tests", () => {
    const parsed = parseTestNgClassFile(
      buildClassFile({
        className: "com.example.Helper",
        methods: [{ name: "help" }],
      }),
    );
    expect(parsed).toBeNull();
  });
});
