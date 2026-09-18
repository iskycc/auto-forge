import { describe, expect, it } from "vitest";

import { platformVersion } from "./version";

describe("platform version provenance", () => {
  it("identifies an unstamped source build instead of advertising the package version", () => {
    expect(platformVersion).toBe("dev");
  });
});
