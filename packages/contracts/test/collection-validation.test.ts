import { describe, expect, it } from "vitest";
import { z } from "zod";

describe("bounded collection validation", () => {
  const collections = [
    {
      name: "array",
      schema: (element: z.ZodString) => z.array(element).max(1),
      oversized: ["first", "second"],
      allowed: ["first"],
    },
    {
      name: "set",
      schema: (element: z.ZodString) => z.set(element).max(1),
      oversized: new Set(["first", "second"]),
      allowed: new Set(["first"]),
    },
    {
      name: "map",
      schema: (element: z.ZodString) => z.map(z.string(), element).max(1),
      oversized: new Map([
        ["first", "first"],
        ["second", "second"],
      ]),
      allowed: new Map([["first", "first"]]),
    },
  ];

  it.each(collections)("rejects oversized $name before validating its elements", (collection) => {
    let validatedElements = 0;
    const schema = collection.schema(
      z.string().superRefine(() => {
        validatedElements += 1;
      }),
    );

    expect(schema.safeParse(collection.oversized).success).toBe(false);
    expect(validatedElements).toBe(0);
    expect(schema.safeParse(collection.allowed).success).toBe(true);
    expect(validatedElements).toBe(1);
  });
});
