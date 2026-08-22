import { DEFAULT_PROJECT_ID, type Project } from "@autoforge/domain";
import { describe, expect, it } from "vitest";

import { fallbackProjectId } from "./project-selection";

function project(id: string, isDefault = id === DEFAULT_PROJECT_ID): Project {
  return {
    id,
    name: id,
    slug: id,
    isDefault,
    archived: false,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
  };
}

describe("fallbackProjectId", () => {
  it("prefers the product default over repository ordering", () => {
    expect(fallbackProjectId([project("newest-project"), project(DEFAULT_PROJECT_ID)])).toBe(
      DEFAULT_PROJECT_ID,
    );
  });

  it("falls back to the first accessible project when the default is unavailable", () => {
    expect(fallbackProjectId([project("newer"), project("declared-default", true)])).toBe(
      "declared-default",
    );
    expect(fallbackProjectId([project("accessible-project")])).toBe("accessible-project");
    expect(fallbackProjectId([])).toBeUndefined();
  });
});
