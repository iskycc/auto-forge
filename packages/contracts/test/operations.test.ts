import { describe, expect, it } from "vitest";

import {
  createServiceAccountInputSchema,
  updateServiceAccountInputSchema,
} from "../src/operations";

describe("service account inputs", () => {
  it("applies empty permission defaults when creating an account", () => {
    expect(createServiceAccountInputSchema.parse({ name: "automation" })).toEqual({
      name: "automation",
      description: "",
      systemPermissions: [],
      projectPermissions: {},
    });
  });

  it("does not clear omitted permissions during a status-only update", () => {
    const parsed = updateServiceAccountInputSchema.parse({
      status: "disabled",
      expectedRevision: 2,
    });

    expect(parsed).toEqual({ status: "disabled", expectedRevision: 2 });
    expect(parsed).not.toHaveProperty("systemPermissions");
    expect(parsed).not.toHaveProperty("projectPermissions");
  });
});
