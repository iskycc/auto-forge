import { describe, expect, it } from "vitest";

import {
  createServiceAccountInputSchema,
  deleteStorageRuntimeAssetsInputSchema,
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

describe("storage runtime asset deletion inputs", () => {
  it("accepts a bounded unique batch and rejects duplicate asset identifiers", () => {
    expect(
      deleteStorageRuntimeAssetsInputSchema.parse({ runtimeAssetIds: ["asset-1", "asset-2"] }),
    ).toEqual({ runtimeAssetIds: ["asset-1", "asset-2"] });
    expect(() =>
      deleteStorageRuntimeAssetsInputSchema.parse({ runtimeAssetIds: ["asset-1", "asset-1"] }),
    ).toThrow("运行时资源编号不能重复");
  });
});
