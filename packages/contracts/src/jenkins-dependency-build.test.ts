import { describe, expect, it } from "vitest";
import { saveJenkinsDependencyConfigurationSchema } from "./jenkins-dependency-build";
const valid = {
  jobUrl: "http://jenkins.local/jenkins/job/folder/job/update/",
  username: "builder",
  apiToken: "secret",
  parameters: [{ name: "VERSION", value: "中文版本 &+" }],
  expectedRevision: 0,
};
describe("dependency pipeline configuration", () => {
  it("accepts nested jobs, Chinese values, empty values and optional stored credentials", () => {
    expect(
      saveJenkinsDependencyConfigurationSchema.parse({
        ...valid,
        parameters: [{ name: "EMPTY", value: "" }],
      }).parameters[0]?.value,
    ).toBe("");
    const withoutToken = { ...valid, apiToken: undefined };
    expect(saveJenkinsDependencyConfigurationSchema.safeParse(withoutToken).success).toBe(true);
  });
  it.each([
    "file:///tmp/job/x/",
    "http://user:password@jenkins/job/x/",
    "http://jenkins/job/x/?token=secret",
    "http://jenkins/job/x/#secret",
    "http://jenkins/job/x/buildWithParameters",
  ])("rejects unsafe or non-job address %s", (jobUrl) => {
    expect(saveJenkinsDependencyConfigurationSchema.safeParse({ ...valid, jobUrl }).success).toBe(
      false,
    );
  });
  it("rejects duplicate or blank keys and usernames containing colons", () => {
    expect(
      saveJenkinsDependencyConfigurationSchema.safeParse({ ...valid, username: "user:password" })
        .success,
    ).toBe(false);
    expect(
      saveJenkinsDependencyConfigurationSchema.safeParse({
        ...valid,
        parameters: [{ name: "", value: "" }],
      }).success,
    ).toBe(false);
    expect(
      saveJenkinsDependencyConfigurationSchema.safeParse({
        ...valid,
        parameters: [valid.parameters[0], valid.parameters[0]],
      }).success,
    ).toBe(false);
  });
});
