import { describe, expect, it } from "vitest";
import {
  fullConfigurationFromSetup,
  infrastructureTargetFromForm,
} from "./platform-infrastructure-form";

function form(values: Record<string, string>) {
  const result = new FormData();
  for (const [key, value] of Object.entries(values)) result.set(key, value);
  return result;
}
describe("Full initialization form", () => {
  it("preserves password whitespace and special characters", () => {
    const target = infrastructureTargetFromForm(
      form({
        "postgres.host": "10.0.0.1",
        "postgres.port": "5432",
        "postgres.database": "autoforge",
        "postgres.username": "user",
        "postgres.password": " password@:/ ",
        "postgres.sslMode": "disable",
      }),
      "postgres",
    );
    expect(target.connection).toMatchObject({ password: " password@:/ " });
  });
  it("identifies the component and missing field before saving", () => {
    expect(() =>
      infrastructureTargetFromForm(
        form({ "postgres.host": "", "postgres.port": "5432" }),
        "postgres",
      ),
    ).toThrow("PostgreSQL 主库 · IP / 主机名");
  });
  it("keeps saved Full credentials when every component card is untouched", () => {
    expect(fullConfigurationFromSetup(form({}), true, "settings")).toEqual({});
  });
  it("requires a separate PostgreSQL log server during initialization", () => {
    expect(() => fullConfigurationFromSetup(form({}), true)).toThrow("PostgreSQL 日志库");
  });
  it("does not silently discard partially filled cards", () => {
    expect(() =>
      fullConfigurationFromSetup(form({ "postgres.password": "changed" }), true),
    ).toThrow("IP / 主机名");
  });
});
