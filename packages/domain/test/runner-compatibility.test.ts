import { describe, expect, it } from "vitest";

import { assessRunnerCompatibility, isAgentUpdateAvailable } from "../src/runner-compatibility";

describe("Runner compatibility", () => {
  it("accepts a versioned Linux Agent with the required executor and isolation", () => {
    expect(
      assessRunnerCompatibility({
        os: "linux",
        architecture: "amd64",
        agentVersion: "0.2.2",
        protocolVersion: 1,
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2", "java:24.0.2", "testng:7.11.0"],
      }),
    ).toEqual({
      compatible: true,
      status: "compatible",
      issues: [],
      javaVersion: "24.0.2",
      testNgVersion: "7.11.0",
    });
  });

  it("keeps an Agent without cgroup v2 eligible while surfacing reduced isolation", () => {
    expect(
      assessRunnerCompatibility({
        os: "linux",
        architecture: "amd64",
        agentVersion: "0.2.2",
        protocolVersion: 1,
        capabilities: ["executor:testng-v1", "java:24.0.2", "testng:7.11.0"],
      }),
    ).toEqual({
      compatible: true,
      status: "attention",
      issues: ["resource_isolation_missing"],
      javaVersion: "24.0.2",
      testNgVersion: "7.11.0",
    });
  });

  it("blocks unsupported protocol, platform and execution capabilities", () => {
    expect(
      assessRunnerCompatibility({
        os: "windows",
        architecture: "amd64",
        agentVersion: "dev",
        protocolVersion: 0,
        capabilities: [],
      }),
    ).toMatchObject({
      compatible: false,
      status: "incompatible",
      issues: [
        "protocol_unsupported",
        "platform_unsupported",
        "testng_executor_missing",
        "resource_isolation_missing",
        "java_version_unknown",
        "testng_version_unknown",
        "agent_version_unversioned",
      ],
    });
  });

  it("blocks Agents with incomplete toolchain metadata", () => {
    expect(
      assessRunnerCompatibility({
        os: "linux",
        architecture: "arm64",
        agentVersion: "dev",
        protocolVersion: 1,
        capabilities: ["executor:testng-v1", "isolation:cgroup-v2"],
      }),
    ).toMatchObject({
      compatible: false,
      status: "incompatible",
      issues: ["java_version_unknown", "testng_version_unknown", "agent_version_unversioned"],
    });
  });

  it("accepts an Adapter Agent whose JDK and JARs are supplied by the project", () => {
    expect(
      assessRunnerCompatibility({
        os: "linux",
        architecture: "amd64",
        agentVersion: "0.2.2",
        protocolVersion: 1,
        capabilities: [
          "executor:testng-v1",
          "adapter:cotest-testng-v1",
          "runtime:project-assets-v1",
        ],
      }),
    ).toEqual({
      compatible: true,
      status: "attention",
      issues: ["resource_isolation_missing"],
    });
  });

  it("does not block project-runtime Agents because of the host JDK and TestNG versions", () => {
    expect(
      assessRunnerCompatibility({
        os: "linux",
        architecture: "amd64",
        agentVersion: "0.2.2",
        protocolVersion: 1,
        capabilities: [
          "executor:testng-v1",
          "isolation:cgroup-v2",
          "adapter:cotest-testng-v1",
          "runtime:project-assets-v1",
          "java:1.8.0_452",
          "testng:7.10.2",
        ],
      }),
    ).toMatchObject({ compatible: true, status: "compatible", issues: [] });
  });

  it("rejects Java and TestNG versions outside the offline execution baseline", () => {
    expect(
      assessRunnerCompatibility({
        os: "linux",
        architecture: "amd64",
        agentVersion: "0.2.2",
        protocolVersion: 1,
        capabilities: [
          "executor:testng-v1",
          "isolation:cgroup-v2",
          "java:1.8.0_452",
          "testng:7.10.2",
        ],
      }),
    ).toMatchObject({
      compatible: false,
      issues: ["java_version_unsupported", "testng_version_unsupported"],
    });
  });
});

describe("isAgentUpdateAvailable", () => {
  it.each([
    ["0.2.1", "0.2.2", true],
    ["0.2.2", "0.2.2", false],
    ["0.2.3", "0.2.2", false],
    ["0.2.2", "0.3.0", true],
    ["0.0.0-e2e", "0.2.2", true],
    ["0.2.2-rc.1", "0.2.2", true],
    ["0.2.2", "0.2.2-rc.1", false],
    ["dev", "0.2.2", false],
    ["0.2.2", "dev", false],
    ["unknown", "unknown", false],
  ])("current %s vs latest %s → %s", (current, latest, expected) => {
    expect(isAgentUpdateAvailable(current, latest)).toBe(expected);
  });
});
